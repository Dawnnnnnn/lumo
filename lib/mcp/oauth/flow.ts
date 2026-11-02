/**
 * Interactive MCP authorization.
 *
 * The spec's flow, from the client's side:
 *
 *   1. request the MCP endpoint → `401` + `WWW-Authenticate: Bearer
 *      resource_metadata="…"` (RFC 9728 §5.1);
 *   2. fetch the protected resource metadata, then the authorization server
 *      metadata (RFC 8414);
 *   3. register this client dynamically (RFC 7591) unless a registration is
 *      already stored;
 *   4. send the user to `authorization_endpoint` with PKCE(S256), `state` and
 *      `resource` (RFC 8707);
 *   5. exchange the returned `code` for tokens, validating `state` and,
 *      when the server sends it, `iss` (RFC 9207).
 *
 * Steps 1–3, 5 and the refresh are `@ai-sdk/mcp`'s `auth()`; step 4's "send the
 * user" is the only part a library cannot do for a browser extension, because
 * it needs a browser-owned redirect URL. That is all this module adds: run
 * `auth()` until it hands back an authorization URL, open it with
 * `chrome.identity.launchWebAuthFlow`, then run `auth()` again with the code.
 */

import { auth, MCPClientOAuthError, UnauthorizedError } from '@ai-sdk/mcp';
import {
  McpAuthorizationRequiredError,
  type AuthorizationChallenge,
} from './errors';
import { ServerLockBusyError, withServerLock } from './lock';
import { createOAuthFetch, type OAuthFetchFunction } from './oauth-fetch';
import { StoredOAuthProvider } from './provider';
import type { McpAuthFailureReason } from './types';

/** Result of an authorization attempt, in terms the UI can act on. */
export type AuthorizationOutcome =
  | { status: 'authorized' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string; reason?: McpAuthFailureReason };

export interface AuthorizationTarget {
  /** Server id; scopes the stored credentials. */
  serverId: string;
  /** The MCP endpoint the credentials are for. */
  serverUrl: string;
  /** Consent-screen name for this client. */
  clientName?: string;
  /**
   * The `WWW-Authenticate` challenge the connection received, if any.
   *
   * The spec lets the server point at its protected-resource metadata and name
   * the scope it wants; honoring that beats rediscovering from the endpoint
   * alone, and it is the only way to request an additional scope.
   */
  challenge?: AuthorizationChallenge;
}

/**
 * Injectables, for tests.
 *
 * Production always uses `chrome.identity`; a unit test would otherwise need a
 * browser, so both the redirect URL and the window are parameters.
 */
export interface AuthorizationDeps {
  redirectUrl?: string;
  /** Returns the URL the authorization server redirected to, or undefined. */
  launch?: (authorizationUrl: string) => Promise<string | undefined>;
  /** How long to wait for another sign-in before reporting `busy` (tests). */
  lockWaitMs?: number;
}

/** The identity API, or undefined outside an extension context (unit tests). */
function identityApi(): typeof chrome.identity | undefined {
  return typeof chrome === 'undefined' ? undefined : chrome.identity;
}

/**
 * The redirect URI for this install.
 *
 * `launchWebAuthFlow` intercepts navigations to this origin, so nothing is ever
 * served there — the browser closes the window and hands us the URL. It is
 * registered with the authorization server during dynamic registration, which
 * is why it must be derived rather than configured.
 */
export function getRedirectUrl(): string {
  const identity = identityApi();
  if (!identity?.getRedirectURL) {
    throw new Error('chrome.identity is unavailable; the identity permission is required');
  }
  return identity.getRedirectURL();
}

async function defaultLaunch(authorizationUrl: string): Promise<string | undefined> {
  const identity = identityApi();
  if (!identity?.launchWebAuthFlow) {
    throw new Error('chrome.identity is unavailable; the identity permission is required');
  }
  return identity.launchWebAuthFlow({ url: authorizationUrl, interactive: true });
}

/**
 * What kind of authorization failure this is.
 *
 * - `challenge`: the endpoint answered `401`. The ordinary state of a server
 *   nobody has signed in to yet; a bare challenge carries no explanation.
 * - `no-registration`: the server demands a token but offers no way for a client
 *   to register itself, so a manual `Authorization` header is the only path.
 * - `temporary`: rate limiting or a transient refusal — waiting is the fix, and
 *   suggesting a manual token would be wrong.
 * - `other`: not an authorization problem at all.
 *
 * `kind` decides the branch; `reason` decides the sentence the user reads.
 */
export type AuthorizationFailureKind = 'challenge' | 'no-registration' | 'temporary' | 'other';

/** What a failed connection or authorization attempt means for the UI. */
export interface AuthorizationFailure {
  message: string;
  kind: AuthorizationFailureKind;
  /**
   * Why the user is needed, when there is something worth telling them. Absent
   * for `other` failures, which are rendered as plain errors instead of
   * authorization state.
   */
  reason?: McpAuthFailureReason;
  /**
   * True when the failure is a *challenge*: the server wants a user, so the
   * connection is not broken and the card must offer the sign-in affordance
   * instead of an error.
   */
  authorizationRequired: boolean;
}

/** Refusals that only need waiting. */
const TEMPORARY_FAILURE_RE = /\b429\b|too many requests|rate.?limit|try again later|频繁|稍后再试|过载/i;

/** The two statuses that mean "later", not "never". */
function isRateLimitStatus(status: number | undefined): boolean {
  return status === 429 || status === 408;
}

/**
 * Failures that mean "there is no way for a client to register itself".
 *
 * Deliberately narrow: the SDK words a *protocol* failure as "Incompatible auth
 * server: …", which must not be read as "this server cannot register clients".
 */
const NO_REGISTRATION_RE =
  /dynamic client registration|does not support.*client registration|protected resource metadata|oauth metadata|well-known\/oauth/i;

/**
 * A `401` is a challenge, and the SDK's transport wording ("no bearer token",
 * "POSTing to endpoint") explains nothing a user can act on.
 */
function challenge(): AuthorizationFailure {
  return {
    message: 'This server requires authorization',
    kind: 'challenge',
    reason: 'authorization-required',
    authorizationRequired: true,
  };
}

/**
 * A redirect this client cannot use: unparsable URL, no `code`, or an `error`
 * the authorization server put in the query string. Distinguished from other
 * protocol failures only so the message can name the redirect step.
 */
class OAuthCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthCallbackError';
  }
}

/**
 * Map a failure to the one decision the UI has to make.
 *
 * "The user has to do something" is a different state from "this server is
 * broken", and the SDK's errors are the only place that distinction is visible:
 * `UnauthorizedError` is thrown once an attempt needs a redirect,
 * `MCPClientOAuthError` covers discovery/registration failures, and a server
 * without a registration endpoint raises a plain error mid-flow. All three mean
 * the same thing to the user — sign in, or paste a token if there is no way to
 * sign in.
 *
 * `context.status` is the HTTP status the flow's fetch last saw. It is needed
 * because the SDK drops it when it parses a standard OAuth error body, which is
 * exactly the shape a `429` answers with — leaving an empty message that would
 * otherwise read as a broken server instead of "slow down".
 */
export function classifyAuthorizationFailure(
  error: unknown,
  context: { status?: number } = {},
): AuthorizationFailure {
  const raw = error instanceof Error ? error.message : String(error);
  // A refusal without a description still needs a sentence, and that sentence
  // must not contain the words the metadata heuristics below look for.
  const message = raw || 'Authorization was refused';

  // Raised by our own token source: the connection already tried the stored
  // credentials and the server still refused them. A bare challenge explains
  // nothing; a widened scope is the one case the user can act on specifically.
  if (McpAuthorizationRequiredError.isInstance(error)) {
    if (error.reason === 'insufficient-scope') {
      return {
        message,
        kind: 'challenge',
        reason: 'insufficient-scope',
        authorizationRequired: true,
      };
    }
    return challenge();
  }

  // A redirect we cannot redeem is a failed sign-in attempt, not a broken
  // server: retrying is the first fix, which is what the card offers.
  if (error instanceof OAuthCallbackError) {
    return {
      message,
      kind: 'challenge',
      reason: 'authorization-server-error',
      authorizationRequired: true,
    };
  }

  // The endpoint refused the request. This is also what an unattended connect
  // sees, because we deliberately do not obtain a token there.
  if (error instanceof UnauthorizedError) return challenge();
  if ((error as { statusCode?: unknown } | null)?.statusCode === 401) return challenge();

  // Rate limiting is a "not now", not a "you cannot sign in here". Checked by
  // status as well as by wording, because a standard OAuth error body loses the
  // status and can arrive with no description at all.
  if (isRateLimitStatus(context.status) || TEMPORARY_FAILURE_RE.test(message)) {
    return { message, kind: 'temporary', reason: 'temporary', authorizationRequired: true };
  }

  // The one failure the user can act on differently: no way to register a client.
  // It is matched on the message because the SDK raises it as a plain `Error`.
  if (NO_REGISTRATION_RE.test(message)) {
    return {
      message,
      kind: 'no-registration',
      reason: 'no-registration',
      authorizationRequired: true,
    };
  }

  // Any other OAuth-protocol failure (`ServerError`, `InvalidGrantError`, …)
  // still means "a user is needed", but suggesting a manual token would be a
  // guess: only the paths above prove that sign-in cannot work. The reason names
  // the step that failed, so the card says "try again", not "paste a token".
  if (MCPClientOAuthError.isInstance(error)) {
    return {
      message,
      kind: 'challenge',
      reason: 'authorization-server-error',
      authorizationRequired: true,
    };
  }

  return { message, kind: 'other', authorizationRequired: false };
}



interface AuthorizationCallback {
  code: string;
  state?: string;
  issuer?: string;
}

/** Read `code`/`state`/`iss` out of the redirect URL, or report the refusal. */
function parseCallback(responseUrl: string): AuthorizationCallback {
  let parsed: URL;
  try {
    parsed = new URL(responseUrl);
  } catch {
    throw new OAuthCallbackError(
      `Authorization server returned an unusable redirect: ${responseUrl}`,
    );
  }

  const error = parsed.searchParams.get('error');
  if (error) {
    const description = parsed.searchParams.get('error_description');
    throw new OAuthCallbackError(description ? `${error}: ${description}` : error);
  }

  const code = parsed.searchParams.get('code');
  if (!code) throw new OAuthCallbackError('Authorization server returned no code');

  return {
    code,
    state: parsed.searchParams.get('state') ?? undefined,
    issuer: parsed.searchParams.get('iss') ?? undefined,
  };
}

/**
 * How long a sign-in may wait for another one to finish.
 *
 * Holding the lock covers the consent window, so a second click has to give up
 * with an explanation instead of hanging behind an open window.
 */
const LOCK_WAIT_MS = 5_000;

/** `chrome.identity` is missing: the extension needs reloading, not a retry. */
class IdentityUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      'chrome.identity is unavailable — reload the extension so the identity permission takes effect',
      { cause },
    );
    this.name = 'IdentityUnavailableError';
  }
}

/**
 * Run the whole authorization, opening the consent window when needed.
 *
 * `auth()` is called twice on purpose: the first call discovers, registers and
 * persists the state needed for the redirect; the second redeems the code. Both
 * are idempotent from the outside — an already-valid token (or a refresh token
 * that still works) short-circuits to `authorized`, which is what makes calling
 * this from a "Retry" affordance safe.
 */
export async function authorizeServer(
  target: AuthorizationTarget,
  deps: AuthorizationDeps = {},
): Promise<AuthorizationOutcome> {
  const log = (step: string) => console.debug(`[MCP:auth:${target.serverId}] ${step}`);

  // Resolve the browser surfaces first. Both are needed before any network work,
  // and a missing identity API is a *configuration* problem — spending a client
  // registration before discovering it only burns a rate limit.
  let redirectUrl: string;
  let launch: (authorizationUrl: string) => Promise<string | undefined>;
  try {
    redirectUrl = deps.redirectUrl ?? getRedirectUrl();
    launch = deps.launch ?? defaultLaunch;
  } catch (error) {
    log('identity API unavailable');
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
      reason: 'identity-unavailable',
    };
  }

  // One fetch for the whole flow: discovery, registration, token exchange. It
  // tolerates servers that answer optional URL fields with `""` (ScriptHub does
  // for `client_uri`), which would otherwise fail registration and leave the
  // user staring at a button that appears to do nothing.
  const fetchFn = createOAuthFetch();

  log('start');
  try {
    return await withServerLock(
      target.serverId,
      async (): Promise<AuthorizationOutcome> => {
        const provider = new StoredOAuthProvider({
          serverId: target.serverId,
          serverUrl: target.serverUrl,
          redirectUrl,
          clientName: target.clientName,
        });

        const first = await auth(provider, {
          serverUrl: target.serverUrl,
          fetchFn,
          ...(target.challenge?.resourceMetadataUrl
            ? { resourceMetadataUrl: target.challenge.resourceMetadataUrl }
            : {}),
          ...(target.challenge?.scope ? { scope: target.challenge.scope } : {}),
        });
        if (first === 'AUTHORIZED') {
          log('stored credentials accepted');
          return { status: 'authorized' };
        }

        const authorizationUrl = provider.pendingAuthorizationUrl();
        if (!authorizationUrl) {
          log('no authorization URL returned');
          return {
            status: 'failed',
            message: 'Authorization server returned no authorization URL',
            reason: 'authorization-server-error',
          };
        }

        log(`opening consent window (${authorizationUrl.origin})`);
        let responseUrl: string | undefined;
        try {
          responseUrl = await launch(authorizationUrl.toString());
        } catch (error) {
          // Closing the consent window rejects the call; that is a decision, not
          // a failure, and must not be painted as an error on the server card.
          if (isUserCancellation(error)) {
            log('window closed by the user');
            return { status: 'cancelled' };
          }
          log(`window failed: ${error instanceof Error ? error.message : String(error)}`);
          return classifyFailure(error, fetchFn);
        }
        if (!responseUrl) {
          log('window closed without a redirect');
          return { status: 'cancelled' };
        }

        const callback = parseCallback(responseUrl);
        log('callback received, exchanging the code');
        await auth(provider, {
          serverUrl: target.serverUrl,
          fetchFn,
          authorizationCode: callback.code,
          callbackState: callback.state,
          callbackIssuer: callback.issuer,
        });
        log('authorized');
        return { status: 'authorized' };
      },
      'oauth',
      { timeoutMs: deps.lockWaitMs ?? LOCK_WAIT_MS },
    );
  } catch (error) {
    if (error instanceof ServerLockBusyError) {
      log('another sign-in is already running');
      return {
        status: 'failed',
        message: 'Another sign-in is already in progress',
        reason: 'busy',
      };
    }
    log(`failed: ${error instanceof Error ? error.message : String(error)}`);
    return classifyFailure(error, fetchFn);
  }
}

function classifyFailure(error: unknown, fetchFn?: OAuthFetchFunction): AuthorizationOutcome {
  const status = fetchFn?.lastFailureStatus;
  const { message, reason } = classifyAuthorizationFailure(error, {
    ...(status ? { status } : {}),
  });
  return { status: 'failed', message, ...(reason ? { reason } : {}) };
}

/** `launchWebAuthFlow` rejects with this when the window is closed early. */
function isUserCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /user did not approve|canceled|cancelled|closed/i.test(message);
}
