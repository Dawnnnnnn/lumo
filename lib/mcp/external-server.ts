import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { stripSseNotifications } from './transports/sse-notification-filter';
import { classifyDiscoveryError } from './protocol-era';
import { forgetEra, rememberEra, resolveEra } from './protocol-era-store';
import { withAuthorization } from './oauth/authorized-fetch';
import { McpTokenSource } from './oauth/token-source';
import { McpAuthorizationRequiredError, type AuthorizationChallenge } from './oauth/errors';
import { withServerLock } from './oauth/lock';
import { deleteCredentials, loadCredentialsFor, patchCredentials } from './oauth/store';
import { authorizeServer, classifyAuthorizationFailure } from './oauth/flow';
import { isAuthorizationRequirementFresh } from './oauth/types';
import type {
  IMcpServer,
  McpAuthError,
  McpServerInfo,
  McpServerStatus,
  McpToolDefinition,
  McpHttpServerConfig,
  AnyTool,
} from './types';

/**
 * External MCP Server implementation using @ai-sdk/mcp.
 * Supports both HTTP Streamable and SSE transport types.
 *
 * State model:
 * - `enabled` (from config): user intent, toggled instantly
 * - `status`: runtime connection state (disconnected → connecting → connected | unauthorized | error)
 *
 * Protocol eras: since `2026-07-28` MCP has no `initialize` handshake, and the
 * SDK probes with `server/discover` first. Legacy servers reject that probe, and
 * the SDK falls back on its own — but the rejection also reaches us through
 * `transport.onerror`. Treating it as a server failure is what painted an error
 * card on servers that had in fact connected, so the era is now resolved up
 * front (and cached per origin) instead: see `protocol-era.ts`.
 *
 * Authorization: servers that answer `401` with a `WWW-Authenticate` challenge
 * are OAuth protected resources (MCP authorization spec). Connecting never runs
 * that flow — it sends the stored token, refreshes once when the token is stale
 * or rejected, and otherwise ends in `unauthorized` until the user signs in.
 * Discovery, dynamic registration and the consent window belong to the explicit
 * `authorize()` path only (see `oauth/token-source.ts`).
 *
 * A manual `Authorization` header wins over OAuth: it is static credentials the
 * user pasted, and letting discovery replace them would silently discard the
 * token that already works.
 */
export class ExternalMcpServer implements IMcpServer {
  private status: McpServerStatus = 'disconnected';
  private error?: string;
  private authError?: McpAuthError;
  private client: MCPClient | null = null;
  private toolDefinitions: McpToolDefinition[] = [];
  private aiTools: Record<string, AnyTool> = {};
  private config: McpHttpServerConfig;
  /** Protocol version the server and client agreed on, once connected. */
  private protocolVersion?: string;
  /** Optional callback invoked whenever connection status changes */
  private onStateChange?: () => void;
  /** Single-flight guards: several contexts/events can ask at the same time. */
  private connectPromise?: Promise<void>;
  private authorizePromise?: Promise<void>;
  /** Bearer provider for this connection; absent when a static header is set. */
  private tokenSource?: McpTokenSource;
  /** Whether any credentials are stored, for the "sign out" affordance. */
  private credentialsPresent = false;
  /** The last `WWW-Authenticate` challenge, reused by the next sign-in. */
  private challenge?: AuthorizationChallenge;

  constructor(config: McpHttpServerConfig, onStateChange?: () => void) {
    this.config = config;
    this.onStateChange = onStateChange;
  }

  getInfo(): McpServerInfo {
    return {
      id: this.config.id,
      name: this.config.name,
      description: this.config.description,
      transport: this.config.transport,
      builtin: false,
      enabled: this.config.enabled,
      icon: this.config.transport === 'http-stream' ? 'radio' : 'radio-tower',
      ...(this.protocolVersion ? { protocolVersion: this.protocolVersion } : {}),
    };
  }

  /**
   * Connect, serialising concurrent calls.
   *
   * A registry snapshot, a storage sync and a user click can all ask for a
   * connection within the same tick; without this guard each one would open a
   * client and close the previous one under another's feet.
   */
  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    // Several contexts can start the same server at the same time (service
    // worker, side panel, options page). Serialising the attempt means the later
    // ones see what the first learned — a token, or a remembered challenge —
    // instead of each spending its own round of requests.
    this.connectPromise = withServerLock(
      this.config.id,
      () => this.doConnect(),
      'connection',
    ).finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    if (!this.config.enabled) {
      this.status = 'disconnected';
      return;
    }

    const manualAuthorization = hasAuthorizationHeader(this.config.headers);
    const credentials = await loadCredentialsFor(this.config.id, this.config.url);
    this.credentialsPresent = Boolean(
      credentials?.tokens || credentials?.clientInformation,
    );
    // A connection may inject a token, but it may never *obtain* one: signing in
    // is a user action, and doing discovery here is what turned a missing login
    // into a registration storm.
    this.tokenSource = manualAuthorization
      ? undefined
      : new McpTokenSource({ serverId: this.config.id, serverUrl: this.config.url });

    // Nothing to send and we already know the endpoint wants a token: skip the
    // request entirely. Every context reconnects on start and the service worker
    // restarts constantly, so this is what keeps an un-authorized server quiet.
    if (!manualAuthorization && !credentials?.tokens && isAuthorizationRequirementFresh(credentials)) {
      this.error = undefined;
      this.authError = undefined;
      this.toolDefinitions = [];
      this.aiTools = {};
      this.setStatus('unauthorized');
      return;
    }

    this.setStatus('connecting');
    this.error = undefined;
    this.protocolVersion = undefined;

    let failure: unknown;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.openConnection();
        failure = undefined;
        break;
      } catch (err) {
        failure = err;
        // Only a transient failure earns a retry; an authorization challenge is
        // a stable state and retrying it would just repeat the refusal.
        if (!isTransientFailure(err) || attempt >= CONNECT_RETRY_DELAYS_MS.length) break;
        await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAYS_MS[attempt]));
      }
    }

    if (failure === undefined) {
      // Clear the error before announcing the state: the registry snapshots
      // status and error together, so a stale error would otherwise be shown
      // next to the "connected" badge.
      this.error = undefined;
      this.authError = undefined;
      this.setStatus('connected');

      // The endpoint answered, so any remembered challenge is stale.
      if (credentials?.requiresAuthorization) {
        void patchCredentials(this.config.id, {
          requiresAuthorization: false,
          serverUrl: this.config.url,
        });
      }
      return;
    }

    this.toolDefinitions = [];
    this.aiTools = {};
    this.protocolVersion = undefined;

    const classified = classifyAuthorizationFailure(failure);

    // A pasted token that the server rejects cannot be fixed by signing in:
    // the header wins at request time, so the header is what has to change.
    if (manualAuthorization && classified.authorizationRequired) {
      this.authError = undefined;
      this.error = classified.message;
      this.setStatus('error');
    } else if (classified.authorizationRequired) {
      // Keep the server's challenge alongside the verdict: sign-in uses its
      // resource-metadata URL and requested scope.
      if (McpAuthorizationRequiredError.isInstance(failure) && failure.challenge) {
        this.challenge = failure.challenge;
      }
      // Remember the challenge so the next unattended connect stays silent.
      void patchCredentials(this.config.id, {
        requiresAuthorization: true,
        serverUrl: this.config.url,
      });
      // One line per attempt, never a stack: this is a state, not a fault.
      console.debug(`[MCP:${this.config.name}] waiting for sign-in`);
      this.error = undefined;
      // A bare `401` explains nothing; only a real obstacle is worth showing.
      this.authError =
        classified.kind === 'challenge'
          ? undefined
          : { message: classified.message, ...(classified.hint ? { hint: classified.hint } : {}) };
      this.setStatus('unauthorized');
    } else {
      this.authError = undefined;
      this.error = describeError(failure);
      this.setStatus('error');
    }
    await this.closeClient();
  }

  /** One connection attempt: open a client, discover tools, keep them. */
  private async openConnection(): Promise<void> {
    await this.closeClient();

    this.client = await this.createClient();

    // The negotiated revision is the one the server answered with, which for a
    // legacy server may be older than what we asked for.
    this.protocolVersion = this.client.initializeResult?.protocolVersion;

    const toolsResult = await this.client.listTools();
    this.toolDefinitions = toolsResult.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
    }));

    // Get AI SDK compatible tools
    this.aiTools = await this.client.tools();
  }

  /**
   * Run the interactive authorization flow, then reconnect.
   *
   * Only ever called from a user action (the "Sign in" affordance, or right
   * after the user adds/enables a server): the flow opens a browser window.
   * Safe to call when already authorized — `authorizeServer` short-circuits on a
   * usable token or refresh token.
   */
  async authorize(): Promise<void> {
    if (this.authorizePromise) {
      console.debug(`[MCP:auth:${this.config.id}] already running`);
      return this.authorizePromise;
    }
    // First line of the trail: distinguishing "the button did nothing" from
    // "the flow started and stopped" needs a marker at the entry point.
    console.debug(`[MCP:auth:${this.config.id}] requested`);
    this.authorizePromise = this.runAuthorization().finally(() => {
      this.authorizePromise = undefined;
    });
    return this.authorizePromise;
  }

  private async runAuthorization(): Promise<void> {
    this.error = undefined;
    this.authError = undefined;
    // A dedicated state, not `connecting`: the card keeps the sign-in affordance
    // in place (busy) so the click is visibly acknowledged.
    this.setStatus('authorizing');
    // A connection may already be in flight (a storage sync, another panel).
    // Let it settle first: `connect()` returns the in-flight promise, so without
    // this the post-authorization reconnect would resolve against the attempt
    // that started before the token existed. The wait is bounded — a stalled
    // endpoint must not be able to prevent the consent window from opening.
    if (this.connectPromise) {
      const settled = await Promise.race([
        this.connectPromise.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), AUTHORIZE_WAIT_FOR_CONNECT_MS),
        ),
      ]);
      // Detach an attempt that is still running, so the reconnect after sign-in
      // starts a fresh one instead of joining the stalled promise.
      if (!settled) this.connectPromise = undefined;
    }
    await this.closeClient();

    const outcome = await authorizeServer({
      serverId: this.config.id,
      serverUrl: this.config.url,
      clientName: 'Lumo',
      ...(this.challenge ? { challenge: this.challenge } : {}),
    });

    if (outcome.status === 'cancelled') {
      // Closing the consent window is a decision, not a fault: leave the card
      // waiting for the user instead of shouting at them.
      this.setStatus('unauthorized');
      return;
    }
    if (outcome.status === 'failed') {
      this.authError = {
        message: outcome.message,
        ...(outcome.hint ? { hint: outcome.hint } : {}),
      };
      this.setStatus('unauthorized');
      return;
    }

    this.credentialsPresent = true;
    this.challenge = undefined;
    await this.connect();
  }

  getAuthError(): McpAuthError | undefined {
    return this.authError;
  }

  /** Whether stored credentials exist, so the UI can offer "sign out". */
  hasStoredCredentials(): boolean {
    return this.credentialsPresent;
  }

  /**
   * Forget the stored credentials, the browser equivalent of pi's `/mcp logout`.
   *
   * Dropping the client as well matters: it holds a session authenticated by the
   * token that no longer exists.
   */
  async signOut(): Promise<void> {
    // Let a connection that is already opening finish, so it cannot restore the
    // credentials this call is about to delete.
    if (this.connectPromise) await this.connectPromise.catch(() => {});
    await this.closeClient();
    // Keep only the verdict that this endpoint wants a token: without it the
    // next unattended connect would probe a server we know will refuse.
    await deleteCredentials(this.config.id);
    await patchCredentials(this.config.id, {
      requiresAuthorization: true,
      serverUrl: this.config.url,
    });
    this.credentialsPresent = false;
    this.error = undefined;
    this.authError = undefined;
    this.toolDefinitions = [];
    this.aiTools = {};
    this.setStatus('unauthorized');
  }

  /**
   * Open a client, choosing the protocol era first.
   *
   * The 2026-07-28 revision lets a dual-era client detect the server's era with
   * one modern request and cache the answer per origin; `resolveEra` does that
   * (and reuses a persisted verdict), so a known-legacy server goes straight to
   * the `initialize` handshake instead of paying for a probe it will reject.
   */
  private async createClient(): Promise<MCPClient> {
    // The era probe is the first request to the endpoint — and the first place a
    // `401` can appear. `probeProtocolEra` swallows every failure (a probe must
    // never block a connection), so the challenge is captured here and re-raised:
    // otherwise the endpoint would answer `server/discover`, `initialize` *and*
    // the inbound SSE stream before we noticed it wants a token.
    const pending: { authorization?: McpAuthorizationRequiredError } = {};
    const transportFetch = this.transportFetch();
    const probeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        return await transportFetch(input, init);
      } catch (error) {
        if (McpAuthorizationRequiredError.isInstance(error)) pending.authorization = error;
        throw error;
      }
    };

    // The deprecated HTTP+SSE transport predates the version header entirely,
    // so the SDK never probes for it and there is no era to learn. The probe
    // itself goes through the authorised fetch, so it carries the same bearer
    // token as any other request without a second code path.
    const legacy =
      this.config.transport === 'http-stream' &&
      (await resolveEra(this.config.url, {
        headers: this.config.headers,
        fetch: probeFetch,
      })) === 'legacy';

    if (pending.authorization) throw pending.authorization;

    try {
      return await this.openClient(!legacy);
    } catch (error) {
      // A cached "legacy" verdict can expire: a server may be upgraded to a
      // modern revision and stop accepting `initialize`. The spec asks for a
      // re-probe in exactly that case, so drop the verdict and retry once with
      // discovery enabled.
      if (legacy && classifyDiscoveryError(error) === 'modern') {
        await forgetEra(this.config.url);
        return this.openClient(true);
      }
      throw error;
    }
  }

  private async openClient(protocolVersionDiscovery: boolean): Promise<MCPClient> {
    // Map our transport type to @ai-sdk/mcp transport config
    const transportType = this.config.transport === 'http-stream' ? 'http' : 'sse';

    return createMCPClient({
      transport: {
        type: transportType,
        url: this.config.url,
        headers: this.config.headers,
        fetch: this.transportFetch(),
      },
      protocolVersionDiscovery,
      // A stalled endpoint must not wedge the client forever: without a bound,
      // `connect()` never settles, and a sign-in that waits for it never opens.
      initializationOptions: { timeout: CONNECT_TIMEOUT_MS },
      clientName: `lumo-extension-${this.config.id}`,
      onUncaughtError: (err) => this.handleTransportError(err, protocolVersionDiscovery),
    });
  }

  /**
   * `globalThis.fetch` loses its binding context when assigned to a variable,
   * causing "Illegal invocation" in browser environments. We wrap it to
   * preserve the correct `this` context.
   *
   * The response is filtered because @ai-sdk/mcp rejects every server → client
   * notification with "Unsupported message type", although MCP servers may push
   * logging / list_changed / progress events on the same SSE stream as a
   * response.
   */
  private transportFetch() {
    // Authorisation wraps the raw fetch, so a `401` becomes one refresh plus one
    // replay (or a sign-in request) before the client ever sees it. The SSE
    // filter stays outermost because it only rewrites successful bodies.
    const authed = withAuthorization(
      (input, init) => globalThis.fetch(input, init),
      this.tokenSource,
    );
    return async (input: RequestInfo | URL, init?: RequestInit) =>
      stripSseNotifications(await authed(input, init));
  }

  /**
   * Transport error events are advisory, never authoritative.
   *
   * `createMCPClient()` / `listTools()` reject when a connection genuinely
   * fails, so the awaited promise already owns the failure state. The event
   * channel additionally carries failures the client handles — most notably the
   * era probe a legacy server rejects before the SDK falls back to `initialize`
   * — and events can land after the handshake has settled. Letting them set
   * `status` is what showed a red 400 card on a connected server.
   *
   * The one thing worth keeping from a probe rejection is the verdict itself, so
   * the next connect skips a request the server is known to refuse. Two guards
   * make that safe: the attempt has to be one that actually probed, and the
   * handshake has to still be running (`connecting`). A late event from a
   * previous attempt can therefore only be misread while a *new* attempt is
   * connecting, and even then the mistake self-heals: the stale "legacy" verdict
   * makes the next connect send `initialize` to a modern server, whose
   * `-32022` rejection drops the verdict again.
   */
  private handleTransportError(err: unknown, protocolVersionDiscovery: boolean): void {
    if (McpAuthorizationRequiredError.isInstance(err)) {
      // Expected state, not a fault: the connection is waiting for a user. One
      // line, no stack — a stable state must not fill the console.
      console.debug(`[MCP:${this.config.name}] waiting for sign-in`);
      return;
    }
    if (
      protocolVersionDiscovery &&
      this.status === 'connecting' &&
      classifyDiscoveryError(err) === 'legacy'
    ) {
      void rememberEra(this.config.url, 'legacy');
      console.debug(
        `[MCP:${this.config.name}] legacy MCP server (modern probe rejected, falling back to initialize)`,
      );
      return;
    }
    console.debug(`[MCP:${this.config.name}] transport error (advisory)`, err);
  }

  private async closeClient(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    try {
      await client.close();
    } catch {
      // ignore close errors
    }
  }

  async disconnect(): Promise<void> {
    await this.closeClient();
    this.toolDefinitions = [];
    this.aiTools = {};
    this.error = undefined;
    this.authError = undefined;
    this.protocolVersion = undefined;
    this.setStatus('disconnected');
  }

  getStatus(): McpServerStatus {
    return this.status;
  }

  getTools(): McpToolDefinition[] {
    return this.toolDefinitions;
  }

  getAITools(): Record<string, AnyTool> {
    return this.aiTools;
  }

  getError(): string | undefined {
    return this.error;
  }

  /**
   * Get current config
   */
  getConfig(): McpHttpServerConfig {
    return this.config;
  }

  /**
   * Update config (e.g. toggle enabled). Does NOT automatically reconnect.
   */
  updateConfig(config: McpHttpServerConfig): void {
    this.config = config;
  }

  /**
   * Set the onStateChange callback (used by registry to auto-notify)
   */
  setOnStateChange(cb: () => void): void {
    this.onStateChange = cb;
  }

  private setStatus(status: McpServerStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStateChange?.();
  }
}

/**
 * Backoff for a connection that failed for a transient reason.
 *
 * Same policy as pi (two retries, 250ms and 1s): a flaky edge or a restarting
 * server should not present as a broken integration, while a `401` must never be
 * retried — that is a state, not a hiccup.
 */
const CONNECT_RETRY_DELAYS_MS = [250, 1_000];

/** Upper bound for opening a client, so a stalled endpoint cannot hang the card. */
const CONNECT_TIMEOUT_MS = 30_000;

/** How long a sign-in waits for an in-flight connection before starting anyway. */
const AUTHORIZE_WAIT_FOR_CONNECT_MS = 2_000;

/** Network-level failures worth retrying, as opposed to an authorization state. */
function isTransientFailure(error: unknown): boolean {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number' && (status === 408 || status === 429 || status >= 500)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP (408|429|5\d\d)\b/i.test(message) || /timed out|ECONNRESET|fetch failed/i.test(message);
}

/** Header names are case-insensitive; a manual token disables OAuth discovery. */
export function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
