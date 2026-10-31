import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { stripSseNotifications } from './transports/sse-notification-filter';
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
 */
export class ExternalMcpServer implements IMcpServer {
  private status: McpServerStatus = 'disconnected';
  private error?: string;
  private client: MCPClient | null = null;
  private toolDefinitions: McpToolDefinition[] = [];
  private aiTools: Record<string, AnyTool> = {};
  private config: McpHttpServerConfig;
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

      // Close existing client if any
      if (this.client) {
        try {
          await this.client.close();
        } catch {
          // ignore close errors
        }
        this.client = null;
      }

      // Map our transport type to @ai-sdk/mcp transport config
      const transportType = this.config.transport === 'http-stream' ? 'http' : 'sse';

      this.client = await createMCPClient({
        transport: {
          type: transportType,
          url: this.config.url,
          headers: this.config.headers,
          // globalThis.fetch loses its binding context when assigned to a variable,
          // causing "Illegal invocation" in browser environments. We wrap it to
          // preserve the correct `this` context.
          //
          // The response is filtered because @ai-sdk/mcp rejects every server →
          // client notification with "Unsupported message type", although MCP
          // servers may push logging / list_changed / progress events on the
          // same SSE stream as a response.
          fetch: async (input, init) =>
            stripSseNotifications(await globalThis.fetch(input, init)),
        },
        clientName: `lumo-extension-${this.config.id}`,
        onUncaughtError: (err) => {
          console.error(`[MCP:${this.config.name}] Uncaught error:`, err);
          this.error = err instanceof Error ? err.message : String(err);
          this.setStatus('error');
        },
      });

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
      this.setStatus('error');

      // Clean up failed client
      if (this.client) {
        try {
          await this.client.close();
        } catch {
          // ignore
        }
        this.client = null;
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore close errors
      }
      this.client = null;
    }
    this.toolDefinitions = [];
    this.aiTools = {};
    this.error = undefined;
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
