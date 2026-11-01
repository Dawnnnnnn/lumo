import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { stripSseNotifications } from './transports/sse-notification-filter';
import { classifyDiscoveryError } from './protocol-era';
import { forgetEra, rememberEra, resolveEra } from './protocol-era-store';
import type {
  IMcpServer,
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
 * - `status`: runtime connection state (disconnected → connecting → connected | error)
 *
 * Protocol eras: since `2026-07-28` MCP has no `initialize` handshake, and the
 * SDK probes with `server/discover` first. Legacy servers reject that probe, and
 * the SDK falls back on its own — but the rejection also reaches us through
 * `transport.onerror`. Treating it as a server failure is what painted an error
 * card on servers that had in fact connected, so the era is now resolved up
 * front (and cached per origin) instead: see `protocol-era.ts`.
 */
export class ExternalMcpServer implements IMcpServer {
  private status: McpServerStatus = 'disconnected';
  private error?: string;
  private client: MCPClient | null = null;
  private toolDefinitions: McpToolDefinition[] = [];
  private aiTools: Record<string, AnyTool> = {};
  private config: McpHttpServerConfig;
  /** Protocol version the server and client agreed on, once connected. */
  private protocolVersion?: string;
  /** Optional callback invoked whenever connection status changes */
  private onStateChange?: () => void;

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

  async connect(): Promise<void> {
    if (!this.config.enabled) {
      this.status = 'disconnected';
      return;
    }

    try {
      this.setStatus('connecting');
      this.error = undefined;
      this.protocolVersion = undefined;
      await this.closeClient();

      this.client = await this.createClient();

      // The negotiated revision is the one the server answered with, which for
      // a legacy server may be older than what we asked for.
      this.protocolVersion = this.client.initializeResult?.protocolVersion;

      // Fetch tools from the server
      const toolsResult = await this.client.listTools();
      this.toolDefinitions = toolsResult.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
      }));

      // Get AI SDK compatible tools
      this.aiTools = await this.client.tools();

      // Clear the error before announcing the state: the registry snapshots
      // status and error together, so a stale error would otherwise be shown
      // next to the "connected" badge.
      this.error = undefined;
      this.setStatus('connected');
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.toolDefinitions = [];
      this.aiTools = {};
      this.protocolVersion = undefined;
      this.setStatus('error');
      await this.closeClient();
    }
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
    // The deprecated HTTP+SSE transport predates the version header entirely,
    // so the SDK never probes for it and there is no era to learn.
    const legacy =
      this.config.transport === 'http-stream' &&
      (await resolveEra(this.config.url, {
        headers: this.config.headers,
        fetch: this.transportFetch(),
      })) === 'legacy';

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
    return async (input: RequestInfo | URL, init?: RequestInit) =>
      stripSseNotifications(await globalThis.fetch(input, init));
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
