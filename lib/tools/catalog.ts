/**
 * The descriptor catalogue: what a stored tool call needs in order to be
 * converted back into a model prompt.
 *
 * `convertToModelMessages` consults exactly two things per tool: its input
 * schema and its `toModelOutput`. It never executes anything. Passing a live
 * tool set therefore forced the chat layer to build real executors just to replay
 * history — which is why `sh` used to be constructed even when programmatic mode
 * was off, and why a call to a tool from a server that is now disconnected
 * collapsed to "tool no longer available".
 *
 * The catalogue is that dependency inverted: one cheap pass over the registry's
 * declarations, including servers that are registered but not connected, plus the
 * shell's descriptor (which is intentionally not a registered server).
 */

import type { ToolSet } from 'ai';
import { mcpRegistry, mcpToModelOutput } from '@/lib/mcp/registry';
import { SHELL_TOOL_NAME, shellToolDescriptor } from '@/lib/shell/descriptor';

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
  toModelOutput: (options: { toolCallId: string; input: unknown; output: unknown }) => unknown;
}

type ModelOutputFn = ToolDescriptor['toModelOutput'];

/**
 * Declarations for every tool this installation knows about.
 *
 * A first registration wins, mirroring `McpRegistry.getAllAITools`: a later
 * server cannot take over a built-in's name.
 */
export function buildToolCatalog(): Map<string, ToolDescriptor> {
  const catalog = new Map<string, ToolDescriptor>();

  for (const state of mcpRegistry.getAllStates()) {
    // A server that fails to build its definitions must not break history
    // conversion for every other tool; fall back to the shared mapping.
    let aiTools: Record<string, { toModelOutput?: ModelOutputFn }> = {};
    try {
      aiTools = (mcpRegistry.getServer(state.info.id)?.getAITools() ?? {}) as typeof aiTools;
    } catch {
      aiTools = {};
    }
    for (const definition of state.tools) {
      if (catalog.has(definition.name)) continue;
      catalog.set(definition.name, {
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        // External tools may ship their own mapping; built-ins fall back to the
        // shared CallToolResult conversion.
        toModelOutput: aiTools[definition.name]?.toModelOutput ?? mcpToModelOutput,
      });
    }
  }

  catalog.set(SHELL_TOOL_NAME, { ...shellToolDescriptor });
  return catalog;
}

/**
 * Build the tool map `convertToModelMessages` accepts.
 *
 * The entries carry no `execute`: they are declarations, and a call to one would
 * be a bug rather than a silently wrong tool invocation.
 */
export function buildConversionToolSet(
  catalog: Map<string, ToolDescriptor> = buildToolCatalog(),
): ToolSet {
  const tools: Record<string, unknown> = {};
  for (const descriptor of catalog.values()) {
    tools[descriptor.name] = {
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      toModelOutput: descriptor.toModelOutput,
    };
  }
  return tools as ToolSet;
}
