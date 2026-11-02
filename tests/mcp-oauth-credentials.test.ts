import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_CREDENTIAL_ENTRIES,
  isAuthorizationRequirementFresh,
  isTokenExpiring,
  normalizeOAuthCredentials,
  ownsServerUrl,
  type McpOAuthCredentials,
} from '@/lib/mcp/oauth/types';
import { McpAuthorizationRequiredError, parseWwwAuthenticate } from '@/lib/mcp/oauth/errors';
import { TOKEN_REFRESH_SKEW_MS } from '@/lib/mcp/oauth/types';

const mocks = vi.hoisted(() => ({
  state: { credentials: {} as Record<string, unknown> },
}));

vi.mock('@/store/storage', () => ({
  storage: {
    getMcpOAuthCredentials: async () => mocks.state.credentials,
    setMcpOAuthCredentials: async (next: Record<string, unknown>) => {
      mocks.state.credentials = next;
    },
  },
}));

const { StoredOAuthProvider } = await import('@/lib/mcp/oauth/provider');
const { McpTokenSource } = await import('@/lib/mcp/oauth/token-source');
const {
  clearCredentials,
  deleteCredentials,
  loadCredentials,
  patchCredentials,
  __resetOAuthCredentialCache,
} = await import('@/lib/mcp/oauth/store');

const REDIRECT_URI = 'https://lumo-test.chromiumapp.org/';
const SERVER_URL = 'https://sh.example/mcp';

function tokens(accessToken: string) {
  return { access_token: accessToken, token_type: 'Bearer', refresh_token: `${accessToken}-refresh` };
}

beforeEach(() => {
  mocks.state.credentials = {};
  __resetOAuthCredentialCache();
});

describe('credential normalisation', () => {
  it('drops records that carry nothing usable', () => {
    expect(
      normalizeOAuthCredentials({
        empty: { updatedAt: 1 },
        noise: 'nope',
        good: { updatedAt: 2, tokens: { access_token: 'a', token_type: 'Bearer' } },
      }),
    ).toEqual({ good: { updatedAt: 2, tokens: { access_token: 'a', token_type: 'Bearer' } } });
  });

  it('keeps in-flight state that the code exchange still needs', () => {
    // `auth()` saves the verifier and `state` before the consent window opens;
    // a normaliser that only kept tokens would break the exchange.
    expect(
      normalizeOAuthCredentials({ s: { updatedAt: 1, codeVerifier: 'v', state: 'csrf' } }),
    ).toEqual({ s: { updatedAt: 1, codeVerifier: 'v', state: 'csrf' } });
  });

  it('rejects tokens without an access token', () => {
    expect(
      normalizeOAuthCredentials({ s: { updatedAt: 1, tokens: { token_type: 'Bearer' } } }),
    ).toEqual({});
  });

  it('drops fields the SDK does not read', () => {
    const [record] = Object.values(
      normalizeOAuthCredentials({
        s: {
          updatedAt: 1,
          tokens: {
            access_token: 'a',
            token_type: 'Bearer',
            file: '/etc/passwd',
            nested: { deep: true },
          },
        },
      }),
    ) as McpOAuthCredentials[];

    // A hand-edited record must not be able to smuggle anything into a request
    // body, and the persisted size has to stay bounded.
    expect(record?.tokens).toEqual({ access_token: 'a', token_type: 'Bearer' });
  });

  it('defaults a missing token_type instead of dropping the token', () => {
    const [record] = Object.values(
      normalizeOAuthCredentials({ s: { updatedAt: 1, tokens: { access_token: 'a' } } }),
    ) as McpOAuthCredentials[];
    expect(record?.tokens?.token_type).toBe('Bearer');
  });

  it('keeps the map bounded, newest first', () => {
    const raw: Record<string, unknown> = {};
    for (let index = 0; index < MAX_CREDENTIAL_ENTRIES + 5; index += 1) {
      raw[`server-${index}`] = { updatedAt: index, tokens: tokens(`token-${index}`) };
    }

    const normalized = normalizeOAuthCredentials(raw);
    expect(Object.keys(normalized)).toHaveLength(MAX_CREDENTIAL_ENTRIES);
    expect(Object.keys(normalized)[0]).toBe(`server-${MAX_CREDENTIAL_ENTRIES + 4}`);
  });
});

describe('credential store', () => {
  it('merges patches without dropping earlier fields', async () => {
    await patchCredentials('srv', { tokens: tokens('one') });
    await patchCredentials('srv', { codeVerifier: 'verifier' });

    const stored = await loadCredentials('srv');
    expect(stored?.tokens?.access_token).toBe('one');
    expect(stored?.codeVerifier).toBe('verifier');
    expect(stored?.updatedAt).toBeGreaterThan(0);
  });

  it('keeps the client registration when only tokens are invalidated', async () => {
    await patchCredentials('srv', {
      clientInformation: { client_id: 'client-1' },
      clientInformationIsDynamic: true,
      tokens: tokens('one'),
      codeVerifier: 'verifier',
    });

    await clearCredentials('srv', 'tokens');

    const stored = await loadCredentials('srv');
    expect(stored?.tokens).toBeUndefined();
    expect(stored?.clientInformation?.client_id).toBe('client-1');
    expect(stored?.codeVerifier).toBe('verifier');
  });

  it('drops the authorization-server pin together with the client', async () => {
    await patchCredentials('srv', {
      clientInformation: { client_id: 'client-1' },
      authorizationServer: {
        authorizationServerUrl: 'https://as.example',
        tokenEndpoint: 'https://as.example/token',
      },
    });

    await clearCredentials('srv', 'client');

    const stored = await loadCredentials('srv');
    expect(stored?.clientInformation).toBeUndefined();
    expect(stored?.authorizationServer).toBeUndefined();
  });

  it('forgets a removed server entirely', async () => {
    await patchCredentials('srv', { tokens: tokens('one') });
    await deleteCredentials('srv');
    expect(await loadCredentials('srv')).toBeUndefined();
  });
});

describe('OAuth provider', () => {
  it('captures the authorization URL instead of opening a window', async () => {
    const onAuthorizationRequired = vi.fn();
    const provider = new StoredOAuthProvider({
      serverId: 'srv',
      serverUrl: SERVER_URL,
      redirectUrl: REDIRECT_URI,
      onAuthorizationRequired,
    });

    const url = new URL('https://as.example/authorize?client_id=c');
    await provider.redirectToAuthorization(url);

    expect(provider.pendingAuthorizationUrl()).toBe(url);
    expect(onAuthorizationRequired).toHaveBeenCalledWith(url);
  });

  it('registers as a public client using the browser redirect', () => {
    const provider = new StoredOAuthProvider({
      serverId: 'srv',
      serverUrl: SERVER_URL,
      redirectUrl: REDIRECT_URI,
    });

    expect(provider.redirectUrl).toBe(REDIRECT_URI);
    expect(provider.clientMetadata).toMatchObject({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      response_types: ['code'],
    });
  });

  it('refuses to exchange a code without a verifier', async () => {
    const provider = new StoredOAuthProvider({
      serverId: 'srv',
      serverUrl: SERVER_URL,
      redirectUrl: REDIRECT_URI,
    });
    await expect(provider.codeVerifier()).rejects.toThrow(/restart the authorization flow/);
  });

  it('does not discard a newer token generation on a stale invalidation', async () => {
    const provider = new StoredOAuthProvider({
      serverId: 'srv',
      serverUrl: SERVER_URL,
      redirectUrl: REDIRECT_URI,
    });
    await provider.saveTokens(tokens('stale'));
    await provider.saveTokens(tokens('fresh'));

    // A concurrent refresh in another context replaced the generation we saw;
    // dropping it here would log the user out for no reason.
    await provider.invalidateCredentials('tokens', { tokens: tokens('stale') });
    expect((await provider.tokens())?.access_token).toBe('fresh');

    await provider.invalidateCredentials('tokens', { tokens: tokens('fresh') });
    expect(await provider.tokens()).toBeUndefined();
  });
});

describe('credential ownership and expiry', () => {
  it('ignores a record issued for another endpoint', () => {
    const record = { serverUrl: 'https://other.example/mcp', updatedAt: 1 };
    expect(ownsServerUrl(record, SERVER_URL)).toBe(false);
    expect(ownsServerUrl(record, 'https://other.example/mcp')).toBe(true);
  });

  it('does not trust a record that predates URL binding', () => {
    expect(ownsServerUrl({ updatedAt: 1 }, SERVER_URL)).toBe(false);
  });

  it('refreshes inside the skew window only', () => {
    const now = 1_000_000;
    expect(isTokenExpiring(undefined, now)).toBe(false);
    expect(isTokenExpiring(now + TOKEN_REFRESH_SKEW_MS - 1, now)).toBe(true);
    expect(isTokenExpiring(now + TOKEN_REFRESH_SKEW_MS + 1, now)).toBe(false);
  });

  it('turns a saved `expires_in` into an absolute deadline', async () => {
    const provider = new StoredOAuthProvider({
      serverId: 'srv',
      serverUrl: SERVER_URL,
      redirectUrl: REDIRECT_URI,
    });
    const before = Date.now();
    await provider.saveTokens({ ...tokens('one'), expires_in: 600 });

    const stored = await loadCredentials('srv');
    expect(stored?.serverUrl).toBe(SERVER_URL);
    expect(stored?.tokensExpireAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(stored?.tokensExpireAt).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  it('expires a remembered challenge', () => {
    const now = 1_000_000;
    const fresh = { requiresAuthorization: true, updatedAt: now - 1_000 };
    const stale = { requiresAuthorization: true, updatedAt: now - 2 * 60 * 60 * 1000 };
    expect(isAuthorizationRequirementFresh(fresh, now)).toBe(true);
    expect(isAuthorizationRequirementFresh(stale, now)).toBe(false);
    expect(isAuthorizationRequirementFresh({ updatedAt: now }, now)).toBe(false);
  });
});

describe('WWW-Authenticate challenges', () => {
  it('reads the parameters MCP uses', () => {
    const challenge = parseWwwAuthenticate(
      'Bearer resource_metadata="https://sh.example/.well-known/oauth-protected-resource/mcp", scope="a:read b:write"',
    );
    expect(challenge.resourceMetadataUrl?.href).toBe(
      'https://sh.example/.well-known/oauth-protected-resource/mcp',
    );
    expect(challenge.scope).toBe('a:read b:write');
    expect(challenge.error).toBeUndefined();
  });

  it('reports a scope upgrade and keeps a malformed URL as no evidence', () => {
    const challenge = parseWwwAuthenticate(
      'Bearer error="insufficient_scope", error_description="more", resource_metadata="not a url"',
    );
    expect(challenge.error).toBe('insufficient_scope');
    expect(challenge.errorDescription).toBe('more');
    expect(challenge.resourceMetadataUrl).toBeUndefined();
  });

  it('returns an empty challenge without a header', () => {
    expect(parseWwwAuthenticate(null)).toEqual({});
  });
});

describe('token source', () => {
  it('requires a new sign-in for a scope upgrade instead of refreshing', async () => {
    await patchCredentials('srv', {
      serverUrl: SERVER_URL,
      clientInformation: { client_id: 'client-1' },
      tokens: tokens('access'),
    });
    const source = new McpTokenSource({ serverId: 'srv', serverUrl: SERVER_URL });

    const response = new Response('forbidden', {
      status: 403,
      headers: { 'www-authenticate': 'Bearer error="insufficient_scope"' },
    });

    await expect(source.handleUnauthorized(response, 'access')).rejects.toBeInstanceOf(
      McpAuthorizationRequiredError,
    );
  });

  it('requires a sign-in when there is nothing to refresh with', async () => {
    await patchCredentials('srv', { serverUrl: SERVER_URL, tokens: tokens('access') });
    const source = new McpTokenSource({ serverId: 'srv', serverUrl: SERVER_URL });

    const response = new Response('nope', { status: 401 });
    await expect(source.handleUnauthorized(response, 'access')).rejects.toMatchObject({
      reason: 'sign-in',
    });
  });

  it('sends nothing for another endpoint', async () => {
    await patchCredentials('srv', {
      serverUrl: 'https://other.example/mcp',
      tokens: tokens('access'),
    });
    const source = new McpTokenSource({ serverId: 'srv', serverUrl: SERVER_URL });

    expect(await source.token()).toBeUndefined();
  });

  it('does not refresh a token that another context already replaced', async () => {
    await patchCredentials('srv', {
      serverUrl: SERVER_URL,
      clientInformation: { client_id: 'client-1' },
      tokens: tokens('fresh'),
    });
    const source = new McpTokenSource({ serverId: 'srv', serverUrl: SERVER_URL });

    // The rejected generation is stale, so there is nothing to do: the retry
    // will simply use the token that is stored now.
    await expect(
      source.handleUnauthorized(new Response('401', { status: 401 }), 'stale'),
    ).resolves.toBeUndefined();
  });
});
