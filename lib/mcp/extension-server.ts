import { jsonSchema, tool } from 'ai';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import type {
  AnyTool,
  IMcpServer,
  McpExtensionProviderConfig,
  McpServerInfo,
  McpServerStatus,
  McpToolDefinition,
} from './types';
import { probeExtension } from './extension-probe';
import { ChromePortTransport } from './transports/chrome-port';

const MAX_TOOLS = 1024;
const RESERVED_NAMESPACES = new Set([
  'browser',
  'page',
  'file',
  'network',
  'devtools',
  'webmcp',
  'ext',
]);

function sanitizeNamespace(raw: string, extensionId: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 16);
  if (!cleaned || !/^[a-z]/.test(cleaned) || RESERVED_NAMESPACES.has(cleaned)) {
    return `ext_${extensionId.slice(0, 8)}`;
  }
  return cleaned;
}

function sanitizeToolName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return cleaned || 'tool';
}

/**
 * One installed extension, exposed through the standard `IMcpServer` surface.
 *
 * The MCP session is logical; the `chrome.runtime` Port is physical. MV3 stops
 * an idle service worker after ~30s, which closes the Port, so a dropped Port is
 * treated as "reconnect on next use" rather than "server gone": cached tools
 * stay available, and `execute` reconnects with the cached `initialize` result
 * before calling the provider.
 */
export class ExtensionMcpServer implements IMcpServer {
  private status: McpServerStatus = 'disconnected';
  private error?: string;
  private descriptor?: { namespace: string; name: string; version: string };
  private client: MCPClient | null = null;
  private transport: ChromePortTransport | null = null;
  private toolDefinitions: McpToolDefinition[] = [];
  private aiTools: Record<string, AnyTool> = {};
  private needsReconnect = false;
  private connecting: Promise<void> | null = null;
  private config: McpExtensionProviderConfig;

  constructor(config: McpExtensionProviderConfig, private onStateChange?: () => void) {
    this.config = config;
  }

  getInfo(): McpServerInfo {
    const name = this.config.label || this.descriptor?.name || `Extension ${this.config.id.slice(0, 8)}`;
    return {
      id: `ext:${this.config.id}`,
      name,
      description: this.descriptor
        ? `${this.descriptor.name} ${this.descriptor.version} · extension provider`
        : 'Extension provider over the runtime MCP transport',
      transport: 'extension',
      builtin: false,
      enabled: this.config.enabled,
      icon: 'puzzle',
    };
  }

  updateConfig(config: McpExtensionProviderConfig): void {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (!this.config.enabled) {
      this.setStatus('disconnected');
      return;
    }
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async disconnect(): Promise<void> {
    await this.closeSession();
    this.toolDefinitions = [];
    this.aiTools = {};
    this.needsReconnect = false;
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
    return this.status === 'error' ? this.error : undefined;
  }

  private async doConnect(): Promise<void> {
    this.setStatus('connecting');
    this.error = undefined;

    const outcome = await probeExtension(this.config.id);
    if (!outcome.ok || !outcome.response) {
      this.fail(
        outcome.unreachable
          ? 'Extension is not installed, or it does not expose an agent endpoint.'
          : (outcome.error ?? 'Probe failed.'),
      );
      return;
    }

    const { service, status } = outcome.response;
    if (!service || !status) {
      this.fail('Probe response is missing service or status.');
      return;
    }
    this.descriptor = service;

    if (!status.enabled) {
      this.fail(`Agent access is turned off in ${service.name}.`);
      return;
    }
    if (!status.authorized) {
      this.fail(
        status.pendingApproval
          ? `${service.name} is waiting for you to approve this extension. Open its settings, allow ${chrome.runtime.id}, then reconnect.`
          : `${service.name} does not allow this extension. Add ${chrome.runtime.id} to its allowed extension IDs.`,
      );
      return;
    }
    if (!status.ready) {
      this.fail(status.reason?.message ?? `${service.name} is not ready.`);
      return;
    }

    await this.closeSession();

    try {
      const transport = ChromePortTransport.connect(this.config.id);
      transport.onclose = () => {
        // The Port died (typically the provider's service worker went idle).
        // Keep the logical session and let the next tool call reconnect.
        this.needsReconnect = true;
      };

      // The provider creates a fresh MCP server per Port, so a reconnect must
      // run `initialize` again: `initialInitializeResult` only applies to
      // transports that preserve a server-side session (e.g. Streamable HTTP).
      // Cached tools stay in place until the new list arrives, so the model
      // never sees the tool surface flicker during a reconnect.
      const client = await createMCPClient({
        transport,
        clientName: 'lumo',
        version: chrome.runtime.getManifest().version,
        onUncaughtError: (error) => {
          // A transport-level failure leaves the cached client unusable. Keep
          // the logical session, but force a reconnect on the next call.
          console.warn(`[MCP:${this.config.id}] Uncaught transport error:`, error);
          this.needsReconnect = true;
        },
      });

      // Chain the SDK's own close handler as well: it marks the client closed,
      // and our flag makes the next tool call reconnect instead of reusing it.
      const sdkOnClose = transport.onclose;
      transport.onclose = () => {
        sdkOnClose?.();
        this.needsReconnect = true;
      };

      this.client = client;
      this.transport = transport;

      const listed = await client.listTools();
      const prefix = sanitizeNamespace(service.namespace, this.config.id);
      const seen = new Set<string>();
      const definitions: McpToolDefinition[] = [];
      const tools: Record<string, AnyTool> = {};

      for (const definition of listed.tools.slice(0, MAX_TOOLS)) {
        const exposed = `${prefix}_${sanitizeToolName(definition.name)}`;
        if (seen.has(exposed)) continue;
        seen.add(exposed);
        const localName = definition.name;
        const inputSchema =
          (definition.inputSchema as Record<string, unknown> | undefined) ?? {
            type: 'object',
            properties: {},
          };

        definitions.push({
          name: exposed,
          description: definition.description ?? '',
          inputSchema,
        });
        tools[exposed] = tool({
          description: definition.description ?? '',
          inputSchema: jsonSchema(inputSchema),
          execute: async (args: unknown) =>
            this.callTool(localName, (args as Record<string, unknown>) ?? {}),
        });
      }

      this.toolDefinitions = definitions;
      this.aiTools = tools;
      this.needsReconnect = false;
      this.setStatus('connected');
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureConnected();
    const client = this.client;
    if (!client) throw new Error('The extension provider is not connected.');
    return client.callTool({ name, arguments: args });
  }

  private async ensureConnected(): Promise<void> {
    // The Port can close without the SDK client reporting it through a field we
    // can read, so liveness is taken from the transport itself.
    if (this.client && !this.needsReconnect && !this.transport?.isClosed) return;
    await this.connect();
    if (!this.client || this.needsReconnect || this.transport?.isClosed) {
      throw new Error(this.error ?? 'Could not reconnect to the extension provider.');
    }
  }

  private async closeSession(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.transport = null;
    if (client) {
      try {
        await client.close();
      } catch {
        // The Port may already be gone.
      }
    }
  }

  private fail(message: string): void {
    this.error = message;
    this.setStatus('error');
  }

  private setStatus(status: McpServerStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStateChange?.();
  }
}
