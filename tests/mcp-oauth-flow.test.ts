import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpHttpServerConfig } from '@/lib/mcp/types';
import { startMockOAuthServer, type MockOAuthServer } from './helpers/mock-mcp-oauth-server';

/**
 * End-to-end cover for MCP authorization.
 *
 * The architecture under test is the one pi uses: a connection only ever *uses*
 * a stored token, and the browser authorization flow runs solely on demand. These
 * cases therefore assert both halves — that a connection never registers a client
 * on its own, and that signing in does the whole RFC-compliant dance exactly once.
 *
 * Nothing about the OAuth protocol is stubbed: the mock authorization server
 * verifies the PKCE challenge, the redirect URI and the RFC 8707 `resource`
 * parameter, and rotates refresh tokens. What *is* stubbed is the browser surface
 * (`chrome.identity`) — the one part a unit test cannot have.
 */

/** Stand-in for `chrome.identity.getRedirectURL()`. */
const REDIRECT_URI = 'https://lumo-test.chromiumapp.org/';

const mocks = vi.hoisted(() => ({
  state: {
    eras: {} as Record<string, unknown>,
    credentials: {} as Record<string, unknown>,
  },
}));

// In-memory stand-ins for the two runtime storage areas the flow touches.
vi.mock('@/store/storage', () => ({
  storage: {
    getMcpProtocolEras: async () => mocks.state.eras,
    setMcpProtocolEras: async (next: Record<string, unknown>) => {
      mocks.state.eras = next;
    },
    getMcpOAuthCredentials: async () => mocks.state.credentials,
    setMcpOAuthCredentials: async (next: Record<string, unknown>) => {
      mocks.state.credentials = next;
    },
  },
}));

const { ExternalMcpServer } = await import('@/lib/mcp/external-server');
const { __resetOAuthCredentialCache, clearCredentials, loadCredentials } = await import(
  '@/lib/mcp/oauth/store'
);
const { __resetProtocolEraCache } = await import('@/lib/mcp/protocol-era-store');
const { authorizeServer, classifyAuthorizationFailure } = await import('@/lib/mcp/oauth/flow');

type LaunchArgs = { url: string; interactive?: boolean };

/** Install a fake `chrome.identity` backed by the mock authorization server. */
function stubIdentity(server: MockOAuthServer, approve = true) {
  const launchWebAuthFlow = vi.fn(async ({ url }: LaunchArgs) =>
    approve ? server.approve(new URL(url)) : undefined,
  );
  vi.stubGlobal('chrome', {
    identity: {
      getRedirectURL: () => REDIRECT_URI,
      launchWebAuthFlow,
    },
  });
  return launchWebAuthFlow;
}

function serverConfig(
  server: MockOAuthServer,
  overrides: Partial<McpHttpServerConfig> = {},
): McpHttpServerConfig {
  return {
    id: 'script-hub',
    name: 'ScriptHub',
    description: '',
    transport: 'http-stream',
    url: server.mcpUrl,
    enabled: true,
    ...overrides,
  };
}

let active: MockOAuthServer[] = [];

async function startServer(options = {}): Promise<MockOAuthServer> {
  const server = await startMockOAuthServer(options);
  active.push(server);
  return server;
}

/** Authorize once, so a test can start from "already signed in". */
async function signedIn(server: MockOAuthServer) {
  const launch = stubIdentity(server);
  const mcp = new ExternalMcpServer(serverConfig(server));
  await mcp.connect();
  await mcp.authorize();
  expect(mcp.getStatus()).toBe('connected');
  return launch;
}

function countRequests(server: MockOAuthServer, path: string): number {
  return server.requests.filter((request) => request.endsWith(` ${path}`)).length;
}

beforeEach(() => {
  mocks.state.eras = {};
  mocks.state.credentials = {};
  __resetOAuthCredentialCache();
  // The era cache is process-wide; a verdict from an earlier case would skip the
  // probe and change how many requests a connect costs.
  __resetProtocolEraCache();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(active.map((server) => server.close()));
  active = [];
  __resetOAuthCredentialCache();
});

describe('connecting never authorizes', () => {
  it('waits for the user instead of registering a client or opening a window', async () => {
    const server = await startServer();
    const launch = stubIdentity(server);
    const mcp = new ExternalMcpServer(serverConfig(server));

    await mcp.connect();

    expect(mcp.getStatus()).toBe('unauthorized');
    expect(mcp.getError()).toBeUndefined();
    // The whole point: a background connection does not touch the authorization
    // server. Registration belongs to an explicit sign-in.
    expect(server.registrations).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
    // One probe is enough to learn "this endpoint wants a token": the challenge
    // raised by the probe stops the attempt before `server/discover`,
    // `initialize` and the inbound SSE stream each earn their own 401.
    expect(server.requests).toEqual(['POST /mcp']);
  });

  it('costs at most two requests when the protocol era is already known', async () => {
    const server = await startServer();
    stubIdentity(server);
    // A cached era means the probe is skipped, so the challenge is found by the
    // client's own first request instead: `server/discover`, then `initialize`.
    mocks.state.eras = {
      [new URL(server.mcpUrl).origin]: { era: 'legacy', updatedAt: Date.now() },
    };
    const mcp = new ExternalMcpServer(serverConfig(server));

    await mcp.connect();

    expect(mcp.getStatus()).toBe('unauthorized');
    expect(server.requests.length).toBeLessThanOrEqual(2);
    expect(server.registrations).toEqual([]);
  });

  it('skips the request entirely once the challenge is known', async () => {
    const server = await startServer();
    stubIdentity(server);
    const first = new ExternalMcpServer(serverConfig(server));
    await first.connect();
    expect(server.requests.length).toBeGreaterThan(0);

    // Every extension context reconnects on start and the service worker restarts
    // constantly; a remembered challenge keeps all of that off the wire.
    server.requests.length = 0;
    const second = new ExternalMcpServer(serverConfig(server));
    await second.connect();

    expect(second.getStatus()).toBe('unauthorized');
    expect(server.requests).toEqual([]);
    expect(server.registrations).toEqual([]);
  });

  it('keeps a manually configured token in charge', async () => {
    const server = await startServer();
    const launch = await signedIn(server);
    const token = server.validAccessToken;
    server.requests.length = 0;

    const manual = new ExternalMcpServer(
      serverConfig(server, { headers: { Authorization: `Bearer ${token}` } }),
    );
    await manual.connect();

    expect(manual.getStatus()).toBe('connected');
    expect(countRequests(server, '/register')).toBe(0);
    expect(launch).toHaveBeenCalledTimes(1); // from `signedIn` only
  });

  it('retries a transient server failure instead of reporting a broken server', async () => {
    const server = await startServer({ failFirstMcpPosts: 1 });
    stubIdentity(server);
    const mcp = new ExternalMcpServer(serverConfig(server));

    await mcp.connect();

    // Without the retry the 503 would surface as `error`; the server is merely
    // starting up, so the outcome has to be the same as any other challenge.
    expect(mcp.getStatus()).toBe('unauthorized');
    expect(mcp.getError()).toBeUndefined();
  });

  it('reports a rejected manual token as a failure, not as a sign-in prompt', async () => {
    const server = await startServer();
    stubIdentity(server);
    const mcp = new ExternalMcpServer(
      serverConfig(server, { headers: { Authorization: 'Bearer wrong' } }),
    );

    await mcp.connect();

    // Signing in cannot help: the header wins at request time, so the header is
    // what the user has to fix.
    expect(mcp.getStatus()).toBe('error');
    expect(mcp.getError()).toBeTruthy();
    expect(server.registrations).toEqual([]);
  });
});

describe('signing in', () => {
  it('runs the authorization code flow and then lists tools', async () => {
    const server = await startServer();
    const launch = stubIdentity(server);
    const mcp = new ExternalMcpServer(serverConfig(server));

    await mcp.connect();
    await mcp.authorize();

    expect(launch).toHaveBeenCalledTimes(1);
    expect(mcp.getStatus()).toBe('connected');
    expect(mcp.getTools().map((tool) => tool.name)).toEqual(['list_scripts']);
    expect(server.registrations).toHaveLength(1);

    // The authorization request carries everything the spec requires.
    const authorizationUrl = server.authorizationUrls[0]!;
    expect(authorizationUrl.pathname).toBe('/authorize');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(authorizationUrl.searchParams.get('resource')).toBe(server.mcpUrl);
    expect(authorizationUrl.searchParams.get('state')).toBeTruthy();
    expect(authorizationUrl.searchParams.get('client_id')).toBeTruthy();

    // The registration is a public client: PKCE is its only proof.
    expect(server.registrations[0]).toMatchObject({
      token_endpoint_auth_method: 'none',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
    });

    // ... and the code exchange is bound to the same resource.
    const tokenRequest = server.tokenRequests.at(-1)!;
    expect(tokenRequest.get('grant_type')).toBe('authorization_code');
    expect(tokenRequest.get('resource')).toBe(server.mcpUrl);
    expect(tokenRequest.get('code_verifier')).toBeTruthy();
  });

  it('stores tokens outside the portable settings, with an absolute expiry', async () => {
    const server = await startServer();
    await signedIn(server);

    const stored = await loadCredentials('script-hub');
    expect(stored?.serverUrl).toBe(server.mcpUrl);
    expect(stored?.tokens?.access_token).toBeTruthy();
    expect(stored?.tokensExpireAt).toBeGreaterThan(Date.now());
    expect(stored?.clientInformation?.client_id).toBeTruthy();
    expect(stored?.clientInformationIsDynamic).toBe(true);
  });

  it('announces the sign-in on the card while the window is being prepared', async () => {
    const server = await startServer();
    const launch = stubIdentity(server);
    const mcp = new ExternalMcpServer(serverConfig(server));
    await mcp.connect();

    const seen: string[] = [];
    mcp.setOnStateChange(() => seen.push(mcp.getStatus()));
    await mcp.authorize();

    // The click has to be acknowledged: discovery + registration happen before
    // the window opens, and a silent spinner reads as "nothing happened".
    expect(seen).toContain('authorizing');
    expect(seen.at(-1)).toBe('connected');
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('treats closing the consent window as a pending decision, not a failure', async () => {
    const server = await startServer();
    stubIdentity(server, false);
    const mcp = new ExternalMcpServer(serverConfig(server));

    await mcp.connect();
    await mcp.authorize();

    expect(mcp.getStatus()).toBe('unauthorized');
    expect(mcp.getAuthError()).toBeUndefined();
  });

  it('explains the fallback when the server cannot register clients', async () => {
    const server = await startServer({ registration: false });
    stubIdentity(server);
    const mcp = new ExternalMcpServer(serverConfig(server));

    await mcp.connect();
    await mcp.authorize();

    expect(mcp.getStatus()).toBe('unauthorized');
    expect(mcp.getAuthError()?.hint).toBe('no-registration');
  });

  it('does not tell the user to paste a token when registration is rate limited', async () => {
    const server = await startServer({ registrationFailure: 429 });
    stubIdentity(server);
    const mcp = new ExternalMcpServer(serverConfig(server));

    await mcp.connect();
    await mcp.authorize();

    expect(mcp.getStatus()).toBe('unauthorized');
    // Temporary: waiting is the fix, and a manual header is not the answer.
    expect(mcp.getAuthError()?.hint).toBeUndefined();
  });
});

describe('browser preconditions', () => {
  it('reports a missing identity API without touching the network', async () => {
    // No `chrome` stub at all: this is a build/permission problem, so the attempt
    // must stop before spending a client registration on it.
    const server = await startServer();
    const outcome = await authorizeServer({ serverId: 'script-hub', serverUrl: server.mcpUrl });

    expect(outcome).toMatchObject({ status: 'failed', hint: 'identity-unavailable' });
    expect(server.requests).toEqual([]);
  });

  it('says so when another sign-in is already running', async () => {
    const server = await startServer();
    // A lock that is never granted until the caller's signal is aborted, which
    // is what the real Web Locks API does.
    vi.stubGlobal('navigator', {
      locks: {
        request: (_name: string, options: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      },
    });

    const outcome = await authorizeServer(
      { serverId: 'script-hub', serverUrl: server.mcpUrl },
      { redirectUrl: REDIRECT_URI, lockWaitMs: 20 },
    );

    expect(outcome).toMatchObject({ status: 'failed', hint: 'busy' });
    expect(server.requests).toEqual([]);
  });

  it('registers again when this build presents a different redirect URI', async () => {
    const server = await startServer();
    await signedIn(server);
    expect(server.registrations).toHaveLength(1);
    // A refresh would short-circuit the flow, so drop the tokens: the point here
    // is the stored *client*, which is what a new install has to replace.
    await clearCredentials('script-hub', 'tokens');

    // An extension id change makes the stored client unusable: the authorization
    // server binds a registration to its redirect URIs, so reusing it would end
    // with a consent window that closes without a code.
    const otherRedirect = 'https://other-install.chromiumapp.org/';
    const outcome = await authorizeServer(
      { serverId: 'script-hub', serverUrl: server.mcpUrl },
      { redirectUrl: otherRedirect, launch: async (url) => server.approve(new URL(url)) },
    );

    expect(outcome).toEqual({ status: 'authorized' });
    expect(server.registrations).toHaveLength(2);
    expect(server.registrations[1]?.redirect_uris).toEqual([otherRedirect]);
  });
});

describe('using stored credentials', () => {
  it('comes up in another context without a window or a second registration', async () => {
    const server = await startServer();
    await signedIn(server);
    const registrationsBefore = server.registrations.length;

    const second = new ExternalMcpServer(serverConfig(server));
    await second.connect();

    expect(second.getStatus()).toBe('connected');
    expect(second.getTools().map((tool) => tool.name)).toEqual(['list_scripts']);
    expect(server.registrations).toHaveLength(registrationsBefore);
    expect(server.authorizationUrls).toHaveLength(1);
  });

  it('refreshes once when the access token is rejected, then reconnects', async () => {
    const server = await startServer();
    await signedIn(server);
    server.expireAccessToken();

    const mcp = new ExternalMcpServer(serverConfig(server));
    await mcp.connect();

    expect(mcp.getStatus()).toBe('connected');
    const refreshRequests = server.tokenRequests.filter(
      (request) => request.get('grant_type') === 'refresh_token',
    );
    expect(refreshRequests).toHaveLength(1);
    // A refresh must never reach the registration endpoint.
    expect(server.registrations).toHaveLength(1);
    expect(server.authorizationUrls).toHaveLength(1);
  });

  it('does not reuse a grant after the endpoint URL changes', async () => {
    const server = await startServer();
    await signedIn(server);

    // Same server id, different URL: the stored token belongs to the old
    // endpoint and must not be sent.
    const moved = new ExternalMcpServer(
      serverConfig(server, { url: `${server.mcpUrl}?tenant=other` }),
    );
    await moved.connect();

    expect(moved.getStatus()).toBe('unauthorized');
    expect(server.tokenRequests.filter((r) => r.get('grant_type') === 'refresh_token')).toHaveLength(
      0,
    );
  });

  it('forgets everything on sign out', async () => {
    const server = await startServer();
    await signedIn(server);
    const mcp = new ExternalMcpServer(serverConfig(server));

    await mcp.signOut();

    expect(mcp.getStatus()).toBe('unauthorized');
    expect(mcp.hasStoredCredentials()).toBe(false);
    expect(await loadCredentials('script-hub')).toEqual({
      requiresAuthorization: true,
      serverUrl: server.mcpUrl,
      updatedAt: expect.any(Number),
    });
  });
});

describe('authorization failure classification', () => {
  it('flags errors the user can only fix with a manual token', () => {
    const failure = classifyAuthorizationFailure(
      new Error('Incompatible auth server: does not support dynamic client registration'),
    );
    expect(failure.hint).toBe('no-registration');
  });

  it('treats a rate limit as temporary, without a hint', () => {
    const failure = classifyAuthorizationFailure(
      new Error('HTTP 429: {"error":"temporarily_unavailable"}'),
    );
    expect(failure.kind).toBe('temporary');
    expect(failure.hint).toBeUndefined();
  });

  it('leaves unrelated failures without a fallback hint', () => {
    const failure = classifyAuthorizationFailure(new Error('network down'));
    expect(failure.hint).toBeUndefined();
    expect(failure.kind).toBe('other');
    expect(failure.message).toBe('network down');
  });
});
