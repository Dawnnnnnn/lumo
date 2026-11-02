/**
 * The only thing a connection is allowed to know about OAuth: how to get a
 * bearer token, and what to do when the server rejects one.
 *
 * This mirrors the `AuthProvider` contract of pi's MCP client (`token()` +
 * `onUnauthorized()`), and it exists because `@ai-sdk/mcp`'s own
 * `OAuthClientProvider` cannot express it: its transport answers every `401` by
 * running the *entire* authorization flow — protected-resource discovery,
 * authorization-server discovery, dynamic client registration and a redirect.
 * Attached to a connection that reopens on every panel focus and every service
 * worker wake-up, that turns "nobody has signed in yet" into a registration
 * storm against a rate-limited endpoint.
 *
 * So the rule here is the standard one: send what we have, refresh once when it
 * is stale or rejected, and otherwise ask the user. Discovery and registration
 * happen only inside an explicit sign-in (`flow.ts`).
 */

import { auth, MCPClientOAuthError, UnauthorizedError } from '@ai-sdk/mcp';
import {
  McpAuthorizationRequiredError,
  parseWwwAuthenticate,
  type AuthorizationChallenge,
} from './errors';
import { getRedirectUrl } from './flow';
import { createOAuthFetch } from './oauth-fetch';
import { withServerLock } from './lock';
import { StoredOAuthProvider } from './provider';
import { loadCredentialsFor } from './store';
import { isTokenExpiring, type McpOAuthCredentials } from './types';

export interface TokenSourceOptions {
  serverId: string;
  /** The MCP endpoint the token is for. */
  serverUrl: string;
}

export class McpTokenSource {
  private readonly serverId: string;
  private readonly serverUrl: string;
  /** In-flight refresh, shared by every request of this connection. */
  private refreshing?: Promise<void>;

  constructor(options: TokenSourceOptions) {
    this.serverId = options.serverId;
    this.serverUrl = options.serverUrl;
  }

  /**
   * Token for the next request.
   *
   * Refreshes ahead of expiry so the request does not spend a `401` first. A
   * failed proactive refresh is swallowed on purpose: the old token is sent and
   * a `401` decides, which is both cheaper and more accurate than guessing.
   */
  async token(): Promise<string | undefined> {
    await this.refreshing?.catch(() => {});

    const record = await this.load();
    const accessToken = record?.tokens?.access_token;
    if (!accessToken) return undefined;
    if (!isTokenExpiring(record?.tokensExpireAt) || !record?.tokens?.refresh_token) {
      return accessToken;
    }

    await this.refresh(accessToken).catch(() => {});
    return (await this.load())?.tokens?.access_token;
  }

  /**
   * The server rejected `rejectedToken`. Refresh once, or require sign-in.
   *
   * Throws `McpAuthorizationRequiredError` when only a user can fix it, which is
   * what the connection turns into the `unauthorized` state.
   */
  async handleUnauthorized(response: Response, rejectedToken?: string): Promise<void> {
    const challenge = parseWwwAuthenticate(response.headers.get('www-authenticate'));

    // A refresh keeps the granted scope, so a wider scope is a new sign-in.
    if (challenge.error === 'insufficient_scope') {
      throw new McpAuthorizationRequiredError({ challenge, reason: 'insufficient-scope' });
    }

    const record = await this.load();
    if (!record?.tokens) throw new McpAuthorizationRequiredError({ challenge });
    // A concurrent context already replaced the token we sent: just retry.
    if (rejectedToken !== undefined && record.tokens.access_token !== rejectedToken) return;

    await this.refresh(record.tokens.access_token, challenge);
  }

  private load(): Promise<McpOAuthCredentials | undefined> {
    return loadCredentialsFor(this.serverId, this.serverUrl);
  }

  /**
   * Refresh the stored tokens, serialised across contexts.
   *
   * Three guards, all of them load-bearing:
   * - the lock keeps two panels from redeeming the same rotating refresh token;
   * - the generation check drops a refresh some other context already did;
   * - the client-registration guard keeps a revoked registration from turning
   *   into a new registration on a background refresh.
   */
  private refresh(staleToken?: string, challenge?: AuthorizationChallenge): Promise<void> {
    this.refreshing ??= withServerLock(this.serverId, async () => {
      const record = await this.load();
      if (!record?.tokens) throw new McpAuthorizationRequiredError({ challenge });

      if (staleToken !== undefined && record.tokens.access_token !== staleToken) return;
      if (!record.tokens.refresh_token || !record.clientInformation) {
        // Nothing to refresh with: a new sign-in is the only way forward.
        throw new McpAuthorizationRequiredError({ challenge });
      }

      const provider = new StoredOAuthProvider({
        serverId: this.serverId,
        serverUrl: this.serverUrl,
        redirectUrl: redirectUrlOrEmpty(),
        allowDynamicRegistration: false,
      });

      try {
        const result = await auth(provider, {
          serverUrl: this.serverUrl,
          // Same tolerance as sign-in: a refresh must not fail on a server that
          // answers an optional URL field with an empty string.
          fetchFn: createOAuthFetch(),
          ...(challenge?.resourceMetadataUrl
            ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
            : {}),
          ...(challenge?.scope ? { scope: challenge.scope } : {}),
        });
        if (result !== 'AUTHORIZED') {
          throw new McpAuthorizationRequiredError({ challenge });
        }
      } catch (error) {
        if (McpAuthorizationRequiredError.isInstance(error)) throw error;
        // The authorization server refused the refresh (revoked/expired grant,
        // client no longer registered): the user has to sign in again.
        if (MCPClientOAuthError.isInstance(error) || error instanceof UnauthorizedError) {
          throw new McpAuthorizationRequiredError({ challenge, cause: error });
        }
        throw error;
      }
    }).finally(() => {
      this.refreshing = undefined;
    });

    return this.refreshing;
  }
}

/**
 * The redirect URI is only used by the authorization request, never by a
 * refresh. A runtime without the identity API can still refresh.
 */
function redirectUrlOrEmpty(): string {
  try {
    return getRedirectUrl();
  } catch {
    return '';
  }
}
