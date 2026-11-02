/**
 * A real HTTP MCP server + OAuth 2.1 authorization server, for tests.
 *
 * The point is to exercise the actual wire contract rather than a stubbed SDK:
 * the client under test discovers the protected resource metadata, registers
 * itself once, builds an authorization URL with PKCE, redeems the code against
 * this server (which really verifies the S256 challenge, the redirect URI, the
 * client id and the RFC 8707 `resource` parameter), and only then gets tools.
 *
 * It also models the two things that made the original implementation fail in
 * practice: a rotating refresh token, and a registration endpoint that can refuse
 * (`429`) — see `registrationFailure`.
 *
 * Loopback HTTP is used deliberately: the MCP OAuth spec allows it for local
 * development (RFC 8252 §7.3), so no TLS fixtures are needed.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';

export interface MockOAuthServerOptions {
  /** Advertise (and serve) dynamic client registration. Default true. */
  registration?: boolean;
  /** Answer registration with this HTTP status (e.g. 429). */
  registrationFailure?: number;
  /** Answer the first N `/mcp` POSTs with 503, to exercise the retry policy. */
  failFirstMcpPosts?: number;
  /** Scopes the server advertises. */
  scopes?: string[];
}

interface PendingCode {
  code: string;
  challenge: string;
  redirectUri: string;
  state?: string;
  clientId: string;
  resource?: string;
}

export interface MockOAuthServer {
  origin: string;
  mcpUrl: string;
  /** Authorization URLs the client asked the browser to open. */
  authorizationUrls: URL[];
  /** Raw registration payloads received. */
  registrations: Array<Record<string, unknown>>;
  /** Token-endpoint form bodies received. */
  tokenRequests: URLSearchParams[];
  /** `METHOD /path` for every request, for "made no request" assertions. */
  requests: string[];
  /** The access token the MCP endpoint currently accepts. */
  validAccessToken: string;
  /** Invalidate the current access token without touching the refresh grant. */
  expireAccessToken(): void;
  /** Simulate the user approving: turn an authorization URL into a redirect. */
  approve(authorizationUrl: URL): string;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

const SERVER_INFO = { name: 'mock-script-hub', version: '1.0.0' };
const PROTOCOL_VERSION = '2025-11-25';

export async function startMockOAuthServer(
  options: MockOAuthServerOptions = {},
): Promise<MockOAuthServer> {
  const withRegistration = options.registration !== false;
  const scopes = options.scopes ?? ['mcp:read'];
  const pending = new Map<string, PendingCode>();
  const authorizationUrls: URL[] = [];
  const registrations: Array<Record<string, unknown>> = [];
  const tokenRequests: URLSearchParams[] = [];
  const requests: string[] = [];

  let origin = '';
  let clientId = 'test-client';
  let registeredRedirectUri = '';
  let validAccessToken = 'access-1';
  let remainingTransientFailures = options.failFirstMcpPosts ?? 0;
  let refreshToken = 'refresh-1';
  let tokenSerial = 2;

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
    requests.push(`${request.method ?? 'GET'} ${url.pathname}`);

    // ── OAuth discovery ────────────────────────────────────────────────────
    if (
      url.pathname === '/.well-known/oauth-protected-resource' ||
      url.pathname === '/.well-known/oauth-protected-resource/mcp'
    ) {
      json(response, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: scopes,
        bearer_methods_supported: ['header'],
      });
      return;
    }

    if (
      url.pathname === '/.well-known/oauth-authorization-server' ||
      url.pathname === '/.well-known/oauth-authorization-server/mcp'
    ) {
      json(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        ...(withRegistration ? { registration_endpoint: `${origin}/register` } : {}),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: scopes,
      });
      return;
    }

    // ── Dynamic client registration (RFC 7591) ────────────────────────────
    if (url.pathname === '/register' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      registrations.push(body);
      if (options.registrationFailure) {
        json(response, options.registrationFailure, { error: 'temporarily_unavailable' });
        return;
      }
      const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
      registeredRedirectUri = String(redirectUris[0] ?? '');
      clientId = `client-${registrations.length}`;
      json(response, 201, {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: body.client_name,
        // Real servers (ScriptHub among them) answer absent optional URLs with an
        // empty string, which `z.string().url()` rejects. Kept here so the
        // tolerance layer stays covered by the end-to-end tests.
        client_uri: '',
        logo_uri: '',
        redirect_uris: redirectUris,
        grant_types: body.grant_types,
        response_types: body.response_types,
        token_endpoint_auth_method: body.token_endpoint_auth_method ?? 'none',
        application_type: body.application_type,
      });
      return;
    }

    // ── Token endpoint: code exchange and refresh ─────────────────────────
    if (url.pathname === '/token' && request.method === 'POST') {
      const params = new URLSearchParams(await readBody(request));
      tokenRequests.push(params);

      if (params.get('grant_type') === 'refresh_token') {
        if (params.get('refresh_token') !== refreshToken) {
          json(response, 400, { error: 'invalid_grant', error_description: 'unknown refresh token' });
          return;
        }
        // Rotating refresh tokens: the previous one is spent, as many MCP
        // authorization servers do. Two concurrent refreshes therefore lose the
        // grant, which is why the client serialises them.
        validAccessToken = `access-${tokenSerial}`;
        refreshToken = `refresh-${tokenSerial}`;
        tokenSerial += 1;
        json(response, 200, {
          access_token: validAccessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: refreshToken,
          scope: scopes.join(' '),
        });
        return;
      }

      const code = params.get('code') ?? '';
      const verifier = params.get('code_verifier') ?? '';
      const record = pending.get(code);
      const challenge = createHash('sha256').update(verifier).digest('base64url');

      const problem = !record
        ? 'unknown code'
        : challenge !== record.challenge
          ? 'PKCE mismatch'
          : params.get('redirect_uri') !== record.redirectUri
            ? 'redirect_uri mismatch'
            : params.get('client_id') !== record.clientId
              ? 'client_id mismatch'
              : record.resource && params.get('resource') !== record.resource
                ? 'resource mismatch'
                : undefined;

      if (problem) {
        json(response, 400, { error: 'invalid_grant', error_description: problem });
        return;
      }

      pending.delete(code);
      json(response, 200, {
        access_token: validAccessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: refreshToken,
        scope: scopes.join(' '),
      });
      return;
    }

    // ── MCP endpoint ──────────────────────────────────────────────────────
    if (url.pathname === '/mcp') {
      if (request.method !== 'POST') {
        // A legacy-era client also opens an inbound SSE GET stream; there is
        // nothing to push in these tests, so refuse it politely instead of
        // leaving the request unanswered.
        response.writeHead(405).end();
        return;
      }
      if (remainingTransientFailures > 0) {
        remainingTransientFailures -= 1;
        response.writeHead(503, { 'content-type': 'text/plain' }).end('try again');
        return;
      }
      if (request.headers.authorization !== `Bearer ${validAccessToken}`) {
        response.writeHead(401, {
          'content-type': 'text/plain',
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        });
        response.end('no bearer token');
        return;
      }

      const body = await readBody(request);
      const message = JSON.parse(body) as { id?: number | string; method?: string };

      if (message.id === undefined) {
        // Notification (`notifications/initialized`): no reply body.
        response.writeHead(202).end();
        return;
      }

      switch (message.method) {
        case 'server/discover':
          // Answering `method not found` is what a pre-2026 server does; it
          // makes the SDK fall back to the `initialize` handshake.
          json(response, 200, {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Method not found' },
          });
          return;
        case 'initialize':
          json(response, 200, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: SERVER_INFO,
            },
          });
          return;
        case 'tools/list':
          json(response, 200, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: [
                {
                  name: 'list_scripts',
                  description: 'Lists scripts',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          });
          return;
        default:
          json(response, 200, {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Method not found' },
          });
          return;
      }
    }

    json(response, 404, { error: 'not_found', path: url.pathname });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;

  return {
    get origin() {
      return origin;
    },
    get mcpUrl() {
      return `${origin}/mcp`;
    },
    authorizationUrls,
    registrations,
    tokenRequests,
    requests,
    get validAccessToken() {
      return validAccessToken;
    },
    expireAccessToken() {
      validAccessToken = `access-expired-${tokenSerial}`;
      tokenSerial += 1;
    },
    approve(authorizationUrl: URL) {
      authorizationUrls.push(authorizationUrl);
      const challenge = authorizationUrl.searchParams.get('code_challenge') ?? '';
      const redirectUri = authorizationUrl.searchParams.get('redirect_uri') ?? '';
      const state = authorizationUrl.searchParams.get('state') ?? undefined;
      const client = authorizationUrl.searchParams.get('client_id') ?? '';
      const resource = authorizationUrl.searchParams.get('resource') ?? undefined;

      // The test asserts on redirect URIs, so the record has to come from the
      // registration the client actually made.
      if (registeredRedirectUri && redirectUri !== registeredRedirectUri) {
        throw new Error(
          `authorization redirect_uri ${redirectUri} does not match registration ${registeredRedirectUri}`,
        );
      }

      const code = `code-${randomUUID()}`;
      pending.set(code, {
        code,
        challenge,
        redirectUri,
        state,
        clientId: client,
        resource,
      });

      const callback = new URL(redirectUri);
      callback.searchParams.set('code', code);
      if (state) callback.searchParams.set('state', state);
      callback.searchParams.set('iss', origin);
      return callback.toString();
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
