/**
 * The port between "something that wants to call a tool" and the MCP registry.
 *
 * The shell used to reach into `mcpRegistry` directly, from two places, and each
 * place re-implemented resolution, normalization and image handling. That made
 * the shell the one call path immune to any policy added to the registry wrapper
 * (audit, rate limits, redaction), and it tied every shell command to the AI
 * SDK's `Tool` object.
 *
 * Everything that calls a tool outside the model's own tool loop goes through
 * this interface instead: name resolution with ambiguity errors, a snapshot of
 * the tool surface taken when the caller starts, a deadline, and one
 * normalization of the result.
 */

import { combineAbortSignals } from '@/lib/abort';
import { mcpRegistry, normalizeToCallToolResult } from '@/lib/mcp/registry';
import type { McpServerState } from '@/lib/mcp/types';

/** Ceiling for a single tool invocation made outside the model loop. */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export interface ToolServerSummary {
  id: string;
  name: string;
  status: string;
  enabled: boolean;
  builtin: boolean;
  toolCount: number;
  error?: string;
}

export interface ToolSummary {
  name: string;
  description: string;
  inputSchema: unknown;
}

export type ToolContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data?: string; path?: string; mimeType: string }
  | { type: string; [key: string]: unknown };

/** Narrow to a text part (`type` is a string on the loose member too). */
export function isTextPart(part: ToolContentPart): part is { type: 'text'; text: string } {
  return part.type === 'text' && typeof (part as { text?: unknown }).text === 'string';
}

/** Narrow to an image part, inline (`data`) or already spilled (`path`). */
export function isImagePart(
  part: ToolContentPart,
): part is { type: 'image'; data?: string; path?: string; mimeType: string } {
  return part.type === 'image' && typeof (part as { mimeType?: unknown }).mimeType === 'string';
}

export interface NormalizedToolResult {
  content: ToolContentPart[];
  isError: boolean;
  /** Present when the tool returned structured content alongside text. */
  structuredContent?: unknown;
}

export interface ToolInvokeOptions {
  conversationId?: string;
  signal?: AbortSignal;
  /** Overrides {@link DEFAULT_TOOL_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** The subset of an AI SDK tool the gateway needs to execute. */
interface ExecutableTool {
  execute: (
    input: unknown,
    options: {
      toolCallId: string;
      messages: unknown[];
      abortSignal?: AbortSignal;
    },
  ) => unknown;
}

export interface ToolGateway {
  /** Servers visible to this caller, snapshotted when the gateway was created. */
  listServers(): ToolServerSummary[];
  listTools(serverId: string): ToolSummary[];
  resolveServer(query: string): ToolServerSummary;
  resolveTool(serverId: string, query: string): ToolSummary;
  invoke(
    serverId: string,
    toolName: string,
    params: unknown,
    options?: ToolInvokeOptions,
  ): Promise<NormalizedToolResult>;
}

/** Loose comparison used for exact matching only — never for prefix routing. */
function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve a server by normalized id or name.
 *
 * One implementation so discovery and invocation cannot disagree about what
 * counts as an exact match.
 */
export function pickServer<T extends { id: string; name: string }>(
  servers: T[],
  query: string,
  describeAvailable: () => string,
): T {
  const wanted = normalizeKey(query);
  const found =
    servers.find((server) => normalizeKey(server.id) === wanted) ??
    servers.find((server) => normalizeKey(server.name) === wanted);
  if (found) return found;
  throw new Error(`Unknown server "${query}". Available: ${describeAvailable()}`);
}

/** Resolve a tool name, refusing ambiguity instead of picking one. */
export function pickTool<T extends { name: string }>(
  tools: T[],
  serverId: string,
  query: string,
): T {
  const exact = tools.find((tool) => tool.name === query);
  if (exact) return exact;

  const wanted = normalizeKey(query);
  const matches = tools.filter((tool) => normalizeKey(tool.name) === wanted);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous tool "${query}" on ${serverId}: ${matches.map((tool) => tool.name).join(', ')}`,
    );
  }
  throw new Error(
    `Unknown tool "${query}" on ${serverId}. Available: ${tools.map((tool) => tool.name).join(', ')}`,
  );
}

function summarize(state: McpServerState): ToolServerSummary {
  return {
    id: state.info.id,
    name: state.info.name,
    status: state.status,
    enabled: state.info.enabled,
    builtin: state.info.builtin,
    toolCount: state.tools.length,
    ...(state.error ? { error: state.error } : {}),
  };
}

export class McpToolGateway implements ToolGateway {
  private readonly states: McpServerState[];

  /**
   * @param states Tool surface captured by the caller. Defaults to the registry
   *   as it is now; the shell passes the same default, which makes its view of
   *   the servers stable for the duration of one script.
   */
  constructor(states: McpServerState[] = mcpRegistry.getAllStates()) {
    this.states = states;
  }

  listServers(): ToolServerSummary[] {
    return this.states.map(summarize);
  }

  listTools(serverId: string): ToolSummary[] {
    return this.requireState(serverId).tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  resolveServer(query: string): ToolServerSummary {
    const summaries = this.states.map(summarize);
    return pickServer(summaries, query, () => summaries.map((server) => server.id).join(', '));
  }

  resolveTool(serverId: string, query: string): ToolSummary {
    const tools = this.requireState(serverId).tools;
    const picked = pickTool(tools, serverId, query);
    return { name: picked.name, description: picked.description, inputSchema: picked.inputSchema };
  }

  async invoke(
    serverId: string,
    toolName: string,
    params: unknown,
    options: ToolInvokeOptions = {},
  ): Promise<NormalizedToolResult> {
    const state = this.requireState(serverId);
    if (state.status !== 'connected' || !state.info.enabled) {
      throw new Error(
        `Tool "${serverId}.${toolName}" is not available (server status: ${state.status}).`,
      );
    }

    const tool = mcpRegistry.getTool(
      serverId,
      toolName,
      options.conversationId ? { conversationId: options.conversationId } : {},
    ) as ExecutableTool | undefined;
    if (!tool || typeof tool.execute !== 'function') {
      throw new Error(`Tool "${serverId}.${toolName}" has no local executor.`);
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const timeoutSignal =
      timeoutMs > 0 && Number.isFinite(timeoutMs) ? AbortSignal.timeout(timeoutMs) : undefined;
    const signal = combineAbortSignals([options.signal, timeoutSignal]);

    const raw = await tool.execute(params, {
      toolCallId: `gateway-${Date.now()}`,
      messages: [],
      ...(signal ? { abortSignal: signal } : {}),
    });
    const result = normalizeToCallToolResult(raw) as NormalizedToolResult;
    // `normalizeToCallToolResult` preserves an existing CallToolResult, so the
    // structured payload rides along untranslated; keep it addressable.
    const structured = (raw as { structuredContent?: unknown } | null)?.structuredContent;
    return structured === undefined ? result : { ...result, structuredContent: structured };
  }

  private requireState(serverId: string): McpServerState {
    const state = this.states.find((candidate) => candidate.info.id === serverId);
    if (!state) throw new Error(`Unknown server "${serverId}"`);
    return state;
  }
}

/** Snapshot the registry as it is right now. */
export function createToolGateway(): ToolGateway {
  return new McpToolGateway();
}

