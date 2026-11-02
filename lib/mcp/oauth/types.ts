/**
 * Persisted MCP OAuth state.
 *
 * The MCP authorization spec (revision 2025-06-18 and later) requires clients to
 * act as OAuth 2.1 clients: discover the protected resource metadata (RFC 9728),
 * register themselves dynamically (RFC 7591), run an authorization-code flow
 * with PKCE, and keep the resulting refresh token. `@ai-sdk/mcp` implements all
 * of that, but it is stateless by design — it asks an `OAuthClientProvider` for
 * every piece of state. This module owns the shape of that state and the pure
 * normaliser that keeps a hand-edited or half-written record from breaking a
 * connection.
 *
 * One record per external server id. It is deliberately *not* part of
 * `mcpSettings`: those are portable settings that ride along in config export,
 * and a bearer token must never be exported.
 */

import type {
  OAuthAuthorizationServerInformation,
  OAuthClientInformation,
  OAuthTokens,
} from '@ai-sdk/mcp';

export interface McpOAuthCredentials {
  /**
   * The MCP endpoint these credentials belong to.
   *
   * Credentials are bound to a (server id, URL) pair, exactly as pi binds them to
   * (server name, URL): editing a server's URL must not send the previous
   * server's token to the new endpoint. A record whose URL does not match the
   * configured one is treated as absent.
   */
  serverUrl?: string;
  /** Dynamic-registration result (or a future pre-registered client). */
  clientInformation?: OAuthClientInformation;
  /**
   * The redirect URI the client was registered with.
   *
   * A registration is bound to its redirect URIs, so a build that presents a
   * different one (the extension id changed) must not reuse the stored client:
   * the authorization server would reject the redirect and the consent window
   * would close without a code. Sign-in re-registers instead.
   */
  redirectUri?: string;
  /**
   * Whether `clientInformation` came from dynamic registration (RFC 7591).
   *
   * The SDK only re-registers after `invalid_client` when this is true; a
   * pre-registered confidential client must not be silently replaced.
   */
  clientInformationIsDynamic?: boolean;
  tokens?: OAuthTokens;
  /**
   * Absolute expiry of `tokens.access_token`, in epoch milliseconds.
   *
   * `expires_in` is relative to when the response was received, so it cannot be
   * used after a restart. Storing the absolute time is what allows a proactive
   * refresh before the next request instead of a guaranteed `401` round trip.
   */
  tokensExpireAt?: number;
  /** PKCE verifier, held only between the redirect and the code exchange. */
  codeVerifier?: string;
  /** `state` sent in the authorization request, validated on the callback. */
  state?: string;
  /**
   * The authorization server this record was issued by.
   *
   * Pins the credentials to one issuer/token endpoint, so a server whose
   * discovery metadata changes cannot redirect a refresh token elsewhere.
   */
  authorizationServer?: OAuthAuthorizationServerInformation;
  /**
   * The MCP endpoint answered `401`: a token is needed before it will talk.
   *
   * Persisted because it is the only way to keep a not-yet-authorized server
   * quiet. Every extension context reconnects on start and an MV3 service worker
   * restarts constantly, so without this verdict each wake-up would re-probe the
   * endpoint *and* — through the SDK's authorization attempt — re-register a
   * client. That is what exhausted a rate-limited registration endpoint and
   * turned one missing login into a stream of `429`s.
   */
  requiresAuthorization?: boolean;
  /** Last write, used for cross-context reconciliation and cache eviction. */
  updatedAt: number;
}

/** Server id → credentials. Bounded; see `MAX_CREDENTIAL_ENTRIES`. */
export type McpOAuthCredentialMap = Record<string, McpOAuthCredentials>;

/** Upper bound on stored servers; far above any realistic MCP list. */
export const MAX_CREDENTIAL_ENTRIES = 32;

/**
 * How long the "this endpoint wants a token" verdict is trusted.
 *
 * Long enough to keep unattended reconnects silent, short enough that a server
 * which stopped requiring authorization (or which the user just made public) is
 * re-probed within the hour instead of being written off forever.
 */
export const AUTHORIZATION_REQUIREMENT_TTL_MS = 60 * 60 * 1000;

/**
 * Why an authorization attempt ended without credentials.
 *
 * A reason, not a message: the UI owns the translation. Each value names a
 * *different* thing the user can do, which is why a plain failure has no hint.
 */
export type McpAuthFailureHint =
  /** The server offers no way for a client to register itself: paste a token. */
  | 'no-registration'
  /** `chrome.identity` is missing — the extension needs reloading. */
  | 'identity-unavailable'
  /** Another sign-in is already running in this browser. */
  | 'busy';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Keep only the fields the SDK reads.
 *
 * Records are rebuilt rather than spread so a stored blob can never smuggle an
 * unexpected key back into a token request, and so the persisted size stays
 * bounded no matter what a hand-edited import contained.
 */
function normalizeTokens(raw: unknown): OAuthTokens | undefined {
  if (!isRecord(raw)) return undefined;
  const accessToken = nonEmptyString(raw.access_token);
  if (!accessToken) return undefined;

  const tokens: OAuthTokens = {
    access_token: accessToken,
    token_type: nonEmptyString(raw.token_type) ?? 'Bearer',
  };
  const refreshToken = nonEmptyString(raw.refresh_token);
  if (refreshToken) tokens.refresh_token = refreshToken;
  const idToken = nonEmptyString(raw.id_token);
  if (idToken) tokens.id_token = idToken;
  const expiresIn = finiteNumber(raw.expires_in);
  if (expiresIn !== undefined) tokens.expires_in = expiresIn;
  const scope = nonEmptyString(raw.scope);
  if (scope) tokens.scope = scope;
  const issuer = nonEmptyString(raw.issuer);
  if (issuer) tokens.issuer = issuer;
  const authorizationServer = nonEmptyString(raw.authorization_server);
  if (authorizationServer) tokens.authorization_server = authorizationServer;
  const tokenEndpoint = nonEmptyString(raw.token_endpoint);
  if (tokenEndpoint) tokens.token_endpoint = tokenEndpoint;
  return tokens;
}

function normalizeClientInformation(raw: unknown): OAuthClientInformation | undefined {
  if (!isRecord(raw)) return undefined;
  const clientId = nonEmptyString(raw.client_id);
  if (!clientId) return undefined;

  const client: OAuthClientInformation = { client_id: clientId };
  const clientSecret = nonEmptyString(raw.client_secret);
  if (clientSecret) client.client_secret = clientSecret;
  const issuedAt = finiteNumber(raw.client_id_issued_at);
  if (issuedAt !== undefined) client.client_id_issued_at = issuedAt;
  const secretExpiresAt = finiteNumber(raw.client_secret_expires_at);
  if (secretExpiresAt !== undefined) client.client_secret_expires_at = secretExpiresAt;
  const issuer = nonEmptyString(raw.issuer);
  if (issuer) client.issuer = issuer;
  const authorizationServer = nonEmptyString(raw.authorization_server);
  if (authorizationServer) client.authorization_server = authorizationServer;
  const tokenEndpoint = nonEmptyString(raw.token_endpoint);
  if (tokenEndpoint) client.token_endpoint = tokenEndpoint;
  return client;
}

function normalizeAuthorizationServer(
  raw: unknown,
): OAuthAuthorizationServerInformation | undefined {
  if (!isRecord(raw)) return undefined;
  const authorizationServerUrl = nonEmptyString(raw.authorizationServerUrl);
  const tokenEndpoint = nonEmptyString(raw.tokenEndpoint);
  if (!authorizationServerUrl || !tokenEndpoint) return undefined;

  const issuer = nonEmptyString(raw.issuer);
  return {
    authorizationServerUrl,
    tokenEndpoint,
    ...(issuer ? { issuer } : {}),
  };
}

function normalizeCredential(raw: unknown): McpOAuthCredentials | undefined {
  if (!isRecord(raw)) return undefined;

  const credential: McpOAuthCredentials = {
    updatedAt: finiteNumber(raw.updatedAt) ?? 0,
  };
  const clientInformation = normalizeClientInformation(raw.clientInformation);
  if (clientInformation) credential.clientInformation = clientInformation;
  if (clientInformation && raw.clientInformationIsDynamic === true) {
    credential.clientInformationIsDynamic = true;
  }
  const redirectUri = nonEmptyString(raw.redirectUri);
  if (redirectUri) credential.redirectUri = redirectUri;
  const serverUrl = nonEmptyString(raw.serverUrl);
  if (serverUrl) credential.serverUrl = serverUrl;
  const tokens = normalizeTokens(raw.tokens);
  if (tokens) credential.tokens = tokens;
  const tokensExpireAt = finiteNumber(raw.tokensExpireAt);
  if (tokens && tokensExpireAt !== undefined) credential.tokensExpireAt = tokensExpireAt;
  const codeVerifier = nonEmptyString(raw.codeVerifier);
  if (codeVerifier) credential.codeVerifier = codeVerifier;
  const state = nonEmptyString(raw.state);
  if (state) credential.state = state;
  const authorizationServer = normalizeAuthorizationServer(raw.authorizationServer);
  if (authorizationServer) credential.authorizationServer = authorizationServer;
  if (raw.requiresAuthorization === true) credential.requiresAuthorization = true;

  // A record carrying nothing but a timestamp is noise: drop it so the card
  // does not look "authorized" on the strength of an empty entry. Anything the
  // SDK can legitimately save first (a PKCE verifier, a `state`, the
  // authorization-server pin) still counts as content — dropping it would
  // silently break the code exchange that is about to happen.
  const { updatedAt: _updatedAt, ...fields } = credential;
  if (Object.keys(fields).length === 0) return undefined;
  return credential;
}

/**
 * Whether a stored record belongs to the endpoint we are about to talk to.
 *
 * A record without a URL predates this rule; it is not trusted, because the one
 * thing it cannot prove is that its token belongs here.
 */
export function ownsServerUrl(
  credential: McpOAuthCredentials | undefined,
  serverUrl: string,
): boolean {
  return credential?.serverUrl === serverUrl;
}

/**
 * When a token should be refreshed ahead of use.
 *
 * pi uses 30s; the same margin covers a slow token endpoint without refreshing
 * on every request.
 */
export const TOKEN_REFRESH_SKEW_MS = 30_000;

/** Whether `tokensExpireAt` is close enough to refresh before sending. */
export function isTokenExpiring(
  tokensExpireAt: number | undefined,
  now = Date.now(),
): boolean {
  return tokensExpireAt !== undefined && tokensExpireAt - TOKEN_REFRESH_SKEW_MS <= now;
}

/**
 * Whether the cached challenge verdict still applies to this record.
 *
 * Used to skip a connection attempt entirely: a stale verdict must not make a
 * server look permanently unauthorized, so the timestamp decides.
 */
export function isAuthorizationRequirementFresh(
  credential: McpOAuthCredentials | undefined,
  now = Date.now(),
): boolean {
  if (credential?.requiresAuthorization !== true) return false;
  return now - credential.updatedAt < AUTHORIZATION_REQUIREMENT_TTL_MS;
}

/** Drop unusable records, repair timestamps and keep the map bounded. */
export function normalizeOAuthCredentials(raw: unknown): McpOAuthCredentialMap {
  if (!isRecord(raw)) return {};

  const entries: Array<[string, McpOAuthCredentials]> = [];
  for (const [serverId, value] of Object.entries(raw)) {
    if (!serverId) continue;
    const credential = normalizeCredential(value);
    if (credential) entries.push([serverId, credential]);
  }

  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(entries.slice(0, MAX_CREDENTIAL_ENTRIES));
}
