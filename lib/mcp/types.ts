import type { Tool } from 'ai';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any, any, any>;

/**
 * MCP Server transport types - extensible for future protocols
 */
export type McpTransportType = 'builtin' | 'http-stream' | 'sse' | 'webmcp' | 'extension';

/**
 * MCP Server status
 */
export type McpServerStatus = 'connected' | 'disconnected' | 'error' | 'connecting';

/**
 * Tool definition as exposed by an MCP server
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's input parameters */
  inputSchema: Record<string, unknown>;
}

/**
 * MCP Server metadata for display and management
 */
export interface McpServerInfo {
  /** Unique identifier for this server */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of the server's purpose */
  description: string;
  /** Transport type */
  transport: McpTransportType;
  /** Whether this is a built-in server that cannot be removed */
  builtin: boolean;
  /** Whether this server is enabled */
  enabled: boolean;
  /** Server icon (lucide icon name or URL) */
  icon?: string;
  /**
   * MCP protocol revision the client and server agreed on, once connected.
   *
   * MCP has two eras: `2026-07-28` and later declare a version per request,
   * while `2025-11-25` and earlier negotiate one in the `initialize` handshake.
   * Showing the negotiated revision is the only way to tell which one an
   * endpoint ended up on without a log dive, so it is surfaced for external
   * servers only.
   */
  protocolVersion?: string;
}

/**
 * Configuration for an external MCP server (HTTP Stream / SSE)
 */
export interface McpHttpServerConfig {
  id: string;
  name: string;
  description: string;
  transport: 'http-stream' | 'sse';
  url: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

/**
 * Configuration for a WebMCP server
 */
export interface McpWebMcpServerConfig {
  id: string;
  name: string;
  description: string;
  transport: 'webmcp';
  /** The origin/URL pattern where WebMCP tools are exposed */
  origin: string;
  enabled: boolean;
}

/**
 * Union type for all external MCP server configurations
 */
export type McpExternalServerConfig = McpHttpServerConfig | McpWebMcpServerConfig;

/**
 * WebMCP tool definition reported from a page's document.modelContext
 */
export interface WebMcpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Per-tab WebMCP state tracked by the background service worker
 */
export interface WebMcpTabState {
  tabId: number;
  /** Tab title at last report */
  title: string;
  /** Tab URL at last report */
  url: string;
  /** Tools registered on this tab */
  tools: WebMcpToolInfo[];
  /** Timestamp of last tool report */
  lastUpdated: number;
}

/**
 * Configuration for an extension provider (an installed extension that speaks
 * the L0 probe + standard MCP over a runtime Port).
 */
export interface McpExtensionProviderConfig {
  /** Chrome extension ID. */
  id: string;
  enabled: boolean;
  /** User-visible override; the provider's self-reported name is the default. */
  label?: string;
}

/**
 * MCP settings stored in chrome.storage
 */
export interface McpSettings {
  /** External MCP server configurations */
  servers: McpExternalServerConfig[];
  /** Disabled built-in server IDs */
  disabledBuiltins: string[];
  /** Whether WebMCP discovery and injection is enabled */
  webmcpEnabled: boolean;
  /** Installed extensions that expose an MCP endpoint. */
  extensionProviders: McpExtensionProviderConfig[];
}

/**
 * Runtime state of an MCP server including tools and status
 */
export interface McpServerState {
  info: McpServerInfo;
  status: McpServerStatus;
  tools: McpToolDefinition[];
  error?: string;
}

/**
 * Context passed to tool execution at stream creation time.
 * Each stream call creates its own closure over this context,
 * ensuring parallel streams (multiple panels) don't conflict.
 */
export interface McpToolExecutionContext {
  /** The conversation ID associated with the current stream */
  conversationId?: string;
}

/**
 * The abstract interface that all MCP server implementations must follow.
 * This enables different transport types to be registered uniformly.
 */
export interface IMcpServer {
  /** Get server metadata */
  getInfo(): McpServerInfo;

  /** Connect to the server and discover tools */
  connect(): Promise<void>;

  /** Disconnect from the server */
  disconnect(): Promise<void>;

  /** Get current connection status */
  getStatus(): McpServerStatus;

  /** Get the list of available tools */
  getTools(): McpToolDefinition[];

  /** 
   * Get AI SDK compatible tools object.
   * Returns a record of tool name -> AI SDK tool definition.
   * @param context Optional execution context (e.g. conversationId) captured in closures.
   */
  getAITools(context?: McpToolExecutionContext): Record<string, AnyTool>;

  /** Get error message if status is 'error' */
  getError(): string | undefined;
}
