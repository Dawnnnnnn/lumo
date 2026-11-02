/**
 * `OAuthClientProvider` backed by `chrome.storage.local`.
 *
 * `@ai-sdk/mcp` owns the OAuth protocol (discovery, dynamic registration, PKCE,
 * code exchange, refresh, issuer pinning); this class owns only the state it
 * asks for. Every getter reads the persisted record, so a provider created in
 * one context transparently sees a client registration or token obtained in
 * another — which is what makes "authorize in the options page, keep chatting in
 * the side panel" work.
 *
 * `redirectToAuthorization` deliberately does *not* open a window. The SDK calls
 * it from inside `connect()` too, and `connect()` runs unattended (startup,
 * another panel's storage sync); only an explicit user action may open one. The
 * URL is handed to the caller instead, which is why the class exposes
 * `pendingAuthorizationUrl()`.
 */

import type {
  OAuthAuthorizationServerInformation,
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthTokens,
} from '@ai-sdk/mcp';
import { clearCredentials, loadCredentials, patchCredentials } from './store';
import { ownsServerUrl, type McpOAuthCredentials } from './types';

export interface StoredOAuthProviderOptions {
  serverId: string;
  /** The MCP endpoint these credentials belong to. */
  serverUrl: string;
  /**
   * Where the authorization server must send the user back.
   *
   * In a Chrome extension this is `chrome.identity.getRedirectURL()`, i.e.
   * `https://<extension-id>.chromiumapp.org/`. It is registered with the
   * authorization server by the dynamic client registration, so it must be
   * stable for the lifetime of the install.
   */
  redirectUrl: string;
  /** Name shown on the consent screen. */
  clientName?: string;
  /**
   * Whether a rejected client registration may be re-registered automatically.
   *
   * Allowed while signing in (that is what makes a first login work), refused
   * while refreshing: a refresh must never reach the registration endpoint,
   * because every extra registration burns a rate limit the user did not ask to
   * spend. A refused re-registration surfaces as "sign in", which registers once.
   */
  allowDynamicRegistration?: boolean;
  /** Called when the SDK decides an interactive authorization is required. */
  onAuthorizationRequired?: (url: URL) => void;
}

export class StoredOAuthProvider implements OAuthClientProvider {
  private readonly serverId: string;
  private readonly serverUrl: string;
  private readonly redirect: string;
  private readonly clientName: string;
  private readonly allowDynamicRegistration: boolean;
  private onAuthorizationRequired?: (url: URL) => void;

  /** Loaded once per connection: the transport asks for tokens on every request. */
  private cache?: McpOAuthCredentials;
  private loaded = false;
  private authorizationUrl?: URL;

  constructor(options: StoredOAuthProviderOptions) {
    this.serverId = options.serverId;
    this.serverUrl = options.serverUrl;
    this.redirect = options.redirectUrl;
    this.clientName = options.clientName ?? 'Lumo';
    this.allowDynamicRegistration = options.allowDynamicRegistration !== false;
    this.onAuthorizationRequired = options.onAuthorizationRequired;
  }

  /** The authorization URL captured during the last `REDIRECT` outcome. */
  pendingAuthorizationUrl(): URL | undefined {
    return this.authorizationUrl;
  }

  private async current(): Promise<McpOAuthCredentials | undefined> {
    if (!this.loaded) {
      const stored = await loadCredentials(this.serverId);
      // Credentials issued for another endpoint are not ours to use or refresh.
      this.cache = ownsServerUrl(stored, this.serverUrl) ? stored : undefined;
      this.loaded = true;
    }
    return this.cache;
  }

  /** Every write stamps the endpoint, so the record can never outlive a URL edit. */
  private async patch(next: Partial<McpOAuthCredentials>): Promise<void> {
    this.cache = await patchCredentials(this.serverId, { ...next, serverUrl: this.serverUrl });
    this.loaded = true;
  }

  // ── Tokens ────────────────────────────────────────────────────────────────

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.current())?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // `expires_in` is relative, so it is converted to an absolute deadline here,
    // where the response arrives; every later read (other context, next start)
    // can then decide to refresh before sending.
    const expiresIn = tokens.expires_in;
    await this.patch({
      tokens,
      tokensExpireAt: typeof expiresIn === 'number' ? Date.now() + expiresIn * 1000 : undefined,
    });
  }

  // ── Redirect ──────────────────────────────────────────────────────────────

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.clientName,
      // A browser extension cannot keep a secret, so it is a public client:
      // PKCE is the only proof the token endpoint is allowed to ask for.
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [this.redirect],
      application_type: 'web',
    };
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.authorizationUrl = authorizationUrl;
    this.onAuthorizationRequired?.(authorizationUrl);
  }

  // ── PKCE + CSRF state ─────────────────────────────────────────────────────

  async codeVerifier(): Promise<string> {
    const verifier = (await this.current())?.codeVerifier;
    if (!verifier) {
      // Rewinding to a fresh flow is the only honest recovery: the verifier is
      // single-use and was never persisted (or was already redeemed).
      throw new Error('MCP OAuth code verifier is missing; restart the authorization flow');
    }
    return verifier;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.patch({ codeVerifier });
  }

  state(): string {
    return crypto.randomUUID();
  }

  async saveState(state: string): Promise<void> {
    await this.patch({ state });
  }

  async storedState(): Promise<string | undefined> {
    return (await this.current())?.state;
  }

  // ── Client registration ───────────────────────────────────────────────────

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const record = await this.current();
    if (!record?.clientInformation) return undefined;

    // A registration is bound to the redirect URIs it was created with. When
    // this build presents another one (the extension id changed), reusing the
    // client would make the authorization server reject the redirect — and the
    // consent window would close without a code, which looks exactly like
    // "sign-in did nothing". Dropping it here makes `auth()` register again.
    if (
      this.allowDynamicRegistration &&
      record.redirectUri !== undefined &&
      record.redirectUri !== this.redirect
    ) {
      return undefined;
    }
    return record.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformation): Promise<void> {
    // Everything the SDK saves here comes from a registration response; a
    // pre-registered client would be configured out of band instead.
    await this.patch({
      clientInformation,
      clientInformationIsDynamic: true,
      redirectUri: this.redirect,
    });
  }

  async isClientInformationDynamicallyRegistered(): Promise<boolean> {
    // Returns false while refreshing, which makes the SDK surface the rejection
    // instead of silently registering a new client.
    return this.allowDynamicRegistration && (await this.current())?.clientInformationIsDynamic === true;
  }

  // ── Authorization-server pin ──────────────────────────────────────────────

  async authorizationServerInformation(): Promise<
    OAuthAuthorizationServerInformation | undefined
  > {
    return (await this.current())?.authorizationServer;
  }

  async saveAuthorizationServerInformation(
    authorizationServerInformation: OAuthAuthorizationServerInformation,
  ): Promise<void> {
    await this.patch({ authorizationServer: authorizationServerInformation });
  }

  // ── Invalidation ──────────────────────────────────────────────────────────

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier',
    context?: { tokens: OAuthTokens },
  ): Promise<void> {
    if (scope !== 'verifier' && context?.tokens) {
      // Two contexts can refresh at the same time. The SDK asks us to drop the
      // generation it observed; if storage already holds a newer one, dropping
      // it would log the user out for no reason.
      const stored = (await this.current())?.tokens;
      if (stored && stored.access_token !== context.tokens.access_token) return;
    }
    this.cache = await clearCredentials(this.serverId, scope);
    this.loaded = true;
  }
}
