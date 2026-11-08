/**
 * WebMCP Server implementation for the MCP registry.
 *
 * This server aggregates all WebMCP tools discovered across browser tabs.
 * It reads tab states from session storage and executes tools by messaging
 * the appropriate content script through the background service worker.
 *
 * The server is associated with tab IDs - tools from different tabs are
 * namespaced to avoid conflicts (e.g. "tab-123:tool-name").
 */

import { jsonSchema } from 'ai';
import type {
  IMcpServer,
  McpServerInfo,
  McpServerStatus,
  McpToolDefinition,
  AnyTool,
  WebMcpTabState,
} from './types';
import { WEBMCP_SESSION_KEY } from './webmcp-messages';
import {
  WEBMCP_TIMEOUT_FIELD,
  resolveWebMcpTimeoutMs,
} from './webmcp-timeout';

/**
 * Add our budget field to a page tool's schema.
 *
 * Only used when the page declares no `timeout` / `timeoutMs` of its own: the
 * value is consumed by the bridge and stripped from the forwarded arguments, so
 * the page tool never receives a parameter its schema does not define.
 */
function withTimeoutField(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties as Record<string, unknown> | undefined) ?? {};
  return {
    ...schema,
    type: schema.type ?? 'object',
    properties: {
      ...properties,
      [WEBMCP_TIMEOUT_FIELD]: {
        type: 'number',
        description:
          'Execution budget in milliseconds (default 25000, max 600000). ' +
          'Give a long-running tool more time; this argument is not passed to the page tool.',
      },
    },
  };
}

/** Whether the page tool already declares a budget of its own. */
function declaresTimeout(schema: Record<string, unknown>): boolean {
  const properties = (schema.properties as Record<string, unknown> | undefined) ?? {};
  return WEBMCP_TIMEOUT_FIELD in properties || 'timeout' in properties;
}

export class WebMcpServer implements IMcpServer {
  private status: McpServerStatus = 'disconnected';
  private tabStates: WebMcpTabState[] = [];
  private storageListener: ((
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string,
  ) => void) | null = null;
  private onStateChange?: () => void;

  constructor(onStateChange?: () => void) {
    this.onStateChange = onStateChange;
  }

  getInfo(): McpServerInfo {
    return {
      id: 'webmcp',
      name: 'WebMCP',
      description: 'Tools discovered from web pages via WebMCP protocol',
      transport: 'webmcp',
      builtin: true,
      enabled: true,
      icon: 'Globe2',
    };
  }

  async connect(): Promise<void> {
    this.status = 'connecting';

    try {
      // Load initial state from session storage
      await this.refreshTabStates();

      // Listen for changes to the session storage key
      this.storageListener = (changes, areaName) => {
        if (areaName !== 'session') return;
        if (!(WEBMCP_SESSION_KEY in changes)) return;

        const newValue = changes[WEBMCP_SESSION_KEY].newValue as
          | WebMcpTabState[]
          | undefined;
        this.tabStates = newValue || [];
        this.onStateChange?.();
      };

      chrome.storage.onChanged.addListener(this.storageListener);
      this.status = 'connected';
    } catch (err) {
      this.status = 'error';
      console.error('[WebMcpServer] Failed to connect:', err);
    }
  }

  async disconnect(): Promise<void> {
    if (this.storageListener) {
      chrome.storage.onChanged.removeListener(this.storageListener);
      this.storageListener = null;
    }
    this.tabStates = [];
    this.status = 'disconnected';
  }

  getStatus(): McpServerStatus {
    return this.status;
  }

  getTools(): McpToolDefinition[] {
    const tools: McpToolDefinition[] = [];

    for (const tabState of this.tabStates) {
      for (const t of tabState.tools) {
        tools.push({
          name: `webmcp_tab${tabState.tabId}_${t.name}`,
          description: `[Tab ${tabState.tabId}: ${tabState.title}] ${t.description}`,
          inputSchema: t.inputSchema,
        });
      }
    }

    return tools;
  }

  getAITools(): Record<string, AnyTool> {
    const aiTools: Record<string, AnyTool> = {};

    for (const tabState of this.tabStates) {
      for (const t of tabState.tools) {
        const toolId = `webmcp_tab${tabState.tabId}_${t.name}`;
        const tabId = tabState.tabId;
        const toolName = t.name;

        // Pass the original JSON Schema from the page's tool registration
        // so the AI model knows exactly what parameters are expected. When the
        // page declares no timeout of its own, ours is added so the model can
        // grant a long task more time; it is stripped before forwarding.
        const pageSchema = (typeof t.inputSchema === 'string'
          ? (() => { try { return JSON.parse(t.inputSchema as unknown as string); } catch { return { type: 'object', properties: {} }; } })()
          : t.inputSchema) || { type: 'object', properties: {} };
        const pageDeclaresTimeout = declaresTimeout(pageSchema);
        const inputSchemaObj = pageDeclaresTimeout ? pageSchema : withTimeoutField(pageSchema);

        const aiTool: AnyTool = {
          description: `[WebMCP - Tab "${tabState.title}"] ${t.description}`,
          inputSchema: jsonSchema(inputSchemaObj),
          execute: async (args: any) => {
            return this.executeTool(tabId, toolName, args as Record<string, unknown>, {
              stripTimeout: !pageDeclaresTimeout,
            });
          },
        };
        aiTools[toolId] = aiTool;
      }
    }

    return aiTools;
  }

  getError(): string | undefined {
    return this.status === 'error'
      ? 'Failed to connect to WebMCP session storage'
      : undefined;
  }

  // ===========================================================================
  // Public helpers
  // ===========================================================================

  /**
   * Get all current tab states (for UI display).
   */
  getTabStates(): WebMcpTabState[] {
    return this.tabStates;
  }

  /**
   * Refresh tab states from session storage.
   */
  async refreshTabStates(): Promise<void> {
    try {
      const result = await chrome.storage.session.get(WEBMCP_SESSION_KEY);
      this.tabStates =
        (result[WEBMCP_SESSION_KEY] as WebMcpTabState[] | undefined) || [];
    } catch {
      this.tabStates = [];
    }
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  private async executeTool(
    tabId: number,
    toolName: string,
    args: Record<string, unknown>,
    { stripTimeout }: { stripTimeout: boolean },
  ): Promise<unknown> {
    const executionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeoutMs = resolveWebMcpTimeoutMs(args);
    // Our injected field is not part of the page tool's schema; forwarding it
    // would either fail validation or arrive as an unknown extra argument.
    const forwarded =
      stripTimeout && args && typeof args === 'object'
        ? Object.fromEntries(
            Object.entries(args).filter(([key]) => key !== WEBMCP_TIMEOUT_FIELD),
          )
        : args;

    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: 'webmcp:execute-tool',
        executionId,
        toolName,
        args: JSON.stringify(forwarded),
        timeoutMs,
      });

      if (response && response.success) {
        const raw = response.result;
        if (!raw) return { success: true };

        // The polyfill's executeTool returns a JSON-stringified CallToolResult.
        // Parse and return as-is — the registry's wrapToolExecute will detect
        // it as a valid CallToolResult and pass it through unchanged.
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      } else {
        return { error: response?.error || 'Unknown error' };
      }
    } catch (err) {
      return {
        error: `Failed to communicate with tab ${tabId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }
}
