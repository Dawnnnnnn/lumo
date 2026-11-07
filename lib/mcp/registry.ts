import type { IMcpServer, McpServerState, McpToolExecutionContext, AnyTool } from './types';

/**
 * Check if a value is already a MCP CallToolResult structure.
 * CallToolResult: { content: [{type: "text", text}, {type: "image", data, mimeType}, ...], isError?: boolean }
 */
function isCallToolResult(value: unknown): value is {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
} {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.content);
}

/** Parse a `data:<mime>;base64,<payload>` URL into its parts. */
function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | undefined {
  const comma = dataUrl.indexOf(',');
  if (comma <= 0) return undefined;
  const header = dataUrl.slice(5, comma); // strip leading "data:"
  return { mimeType: header.split(';')[0] || 'image/png', data: dataUrl.slice(comma + 1) };
}

/**
 * Normalize a tool execute result into MCP CallToolResult format.
 * - If already a CallToolResult, return as-is (images preserved).
 * - If it's an error-shaped object { error: "..." }, wrap as isError: true.
 * - Otherwise wrap the value as a text content part.
 *
 * Images must be declared explicitly by the tool, as a
 * `{ type: 'image', data, mimeType }` content part (see `page_screenshot`).
 * Scanning arbitrary results for `data:image/` strings was tried and removed:
 * any tool that merely *reports* image URLs — `page_evaluate` returning
 * `img.src`, `page_query_selector_all` returning attributes — had its payload
 * rewritten into an image part plus a `[image NNKB]` placeholder, destroying
 * the data the caller asked for. Truncated data URLs made it worse, rendering
 * as a blank box sized by a PNG header with no pixels behind it.
 */
export function normalizeToCallToolResult(result: unknown): {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError: boolean;
} {
  // Already a CallToolResult
  if (isCallToolResult(result)) {
    return result as { content: Array<{ type: string; [key: string]: unknown }>; isError: boolean };
  }

  // A bare base64 image data-URL
  if (typeof result === 'string') {
    if (result.startsWith('data:image/')) {
      const parsed = parseDataUrl(result);
      if (parsed) {
        return { content: [{ type: 'image', data: parsed.data, mimeType: parsed.mimeType }], isError: false };
      }
    }
    return { content: [{ type: 'text', text: result }], isError: false };
  }

  // Error-shaped object from built-in tools: { error: "message" }
  if (
    result &&
    typeof result === 'object' &&
    typeof (result as Record<string, unknown>).error === 'string' &&
    Object.keys(result as object).length <= 2
  ) {
    return {
      content: [{ type: 'text', text: (result as Record<string, unknown>).error as string }],
      isError: true,
    };
  }

  // Normal result — stringify and wrap
  const text = typeof result === 'string' ? result : JSON.stringify(result) ?? '';
  return {
    content: [{ type: 'text', text }],
    isError: false,
  };
}

/**
 * Convert a normalized CallToolResult into a model-friendly output.
 *
 * Results carrying image content become `content` parts — the native format
 * both Anthropic (`tool_result` image blocks) and OpenAI Responses
 * (`input_image` in function outputs) understand. Text-only results keep the
 * legacy `json` shape so existing tools keep a byte-identical model prompt.
 */
export function mcpToModelOutput({
  output,
}: {
  toolCallId: string;
  input: unknown;
  output: unknown;
}): unknown {
  const result = output as {
    content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
  } | null;
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) {
    return { type: 'json', value: output as never };
  }
  if (!result.content.some((part) => part.type === 'image')) {
    // Preserve legacy behavior: plain results are stringified as JSON.
    return { type: 'json', value: output as never };
  }
  return {
    type: 'content',
    value: result.content.map((part) => {
      if (part.type === 'text') {
        return { type: 'text' as const, text: part.text ?? '' };
      }
      if (part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
        return {
          type: 'file' as const,
          mediaType: part.mimeType,
          data: { type: 'data' as const, data: part.data },
        };
      }
      return { type: 'text' as const, text: JSON.stringify(part) };
    }),
  };
}

/**
 * Wrap a tool's execute function so its output is always a CallToolResult.
 * External MCP tools (from @ai-sdk/mcp) already ship their own `toModelOutput`,
 * so it is only added for tools that don't define one.
 */
function wrapToolExecute(originalTool: AnyTool): AnyTool {
  const originalExecute = (originalTool as any).execute;
  if (typeof originalExecute !== 'function') return originalTool;

  return {
    ...originalTool,
    execute: async (...args: any[]) => {
      const result = await originalExecute(...args);
      return normalizeToCallToolResult(result);
    },
    ...((originalTool as any).toModelOutput == null ? { toModelOutput: mcpToModelOutput } : {}),
  } as AnyTool;
}

/**
 * MCP Registry - manages all MCP server instances (built-in and external).
 * Provides a unified interface to discover tools across all connected servers.
 */
class McpRegistry {
  private servers: Map<string, IMcpServer> = new Map();
  private listeners: Set<() => void> = new Set();

  /**
   * Register an MCP server instance
   */
  register(server: IMcpServer): void {
    const info = server.getInfo();
    this.servers.set(info.id, server);
    this.notifyListeners();
  }

  /**
   * Unregister an MCP server by ID
   */
  unregister(id: string): void {
    const server = this.servers.get(id);
    if (server) {
      server.disconnect().catch(console.error);
      this.servers.delete(id);
      this.notifyListeners();
    }
  }

  /**
   * Get a specific server by ID
   */
  getServer(id: string): IMcpServer | undefined {
    return this.servers.get(id);
  }

  /**
   * Get all registered servers
   */
  getAllServers(): IMcpServer[] {
    return Array.from(this.servers.values());
  }

  /**
   * Get all server states (for UI display)
   */
  getAllStates(): McpServerState[] {
    return this.getAllServers().map((server) => {
      const authError = server.getAuthError?.();
      return {
        info: server.getInfo(),
        status: server.getStatus(),
        tools: server.getTools(),
        error: server.getError(),
        ...(authError ? { authError } : {}),
        ...(server.hasStoredCredentials?.() ? { hasCredentials: true } : {}),
      };
    });
  }

  /**
   * Connect all enabled servers
   */
  async connectAll(): Promise<void> {
    const servers = this.getAllServers().filter(
      (s) => s.getInfo().enabled
    );
    await Promise.allSettled(servers.map((s) => s.connect()));
    this.notifyListeners();
  }

  /**
   * Disconnect all servers
   */
  async disconnectAll(): Promise<void> {
    await Promise.allSettled(
      this.getAllServers().map((s) => s.disconnect())
    );
    this.notifyListeners();
  }

  /**
   * Resolve one tool by server id and tool name.
   *
   * This is the shell's `mcp call` entry point: it must address a tool by the
   * server that owns it instead of by its flat name, because external servers
   * are free to use the same tool name as a built-in.
   */
  getTool(
    serverId: string,
    toolName: string,
    context?: McpToolExecutionContext,
  ): AnyTool | undefined {
    const server = this.servers.get(serverId);
    if (!server) return undefined;
    if (server.getStatus() !== 'connected' || !server.getInfo().enabled) return undefined;
    return server.getAITools(context)[toolName];
  }

  /**
   * Get all AI SDK compatible tools from all connected servers.
   * Returns a merged tools object that can be passed directly to streamText/generateText.
   * All tool execute outputs are normalized to MCP CallToolResult format.
   * @param context Optional execution context captured in tool closures for the current stream.
   */
  getAllAITools(context?: McpToolExecutionContext): Record<string, AnyTool> {
    const allTools: Record<string, AnyTool> = {};
    // `McpRegistry` merges every server into one flat name space, so a later
    // server could silently replace an earlier tool (or a built-in). Track the
    // owner and skip duplicates instead.
    const owners = new Map<string, string>();

    for (const server of this.getAllServers()) {
      if (server.getStatus() === 'connected' && server.getInfo().enabled) {
        const owner = server.getInfo().id;
        const tools = server.getAITools(context);
        for (const [name, t] of Object.entries(tools)) {
          const previous = owners.get(name);
          if (previous) {
            console.warn(
              `[MCP] Tool "${name}" from ${owner} collides with ${previous}; keeping the first registration.`,
            );
            continue;
          }
          owners.set(name, owner);
          allTools[name] = wrapToolExecute(t);
        }
      }
    }

    return allTools;
  }

  /**
   * Subscribe to registry state changes
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Notify all subscribers of a state change.
   * Call after modifying a server's state externally (e.g. connect/disconnect).
   */
  notifyChange(): void {
    this.notifyListeners();
  }

  private notifyListeners(): void {
    this.listeners.forEach((listener) => listener());
  }
}

/** Singleton registry instance */
export const mcpRegistry = new McpRegistry();
