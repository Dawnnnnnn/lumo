/**
 * The `sh` tool — one execution surface for the whole browser.
 *
 * Programmatic mode exposes four tools: `file_read`, `file_write`, `file_edit`
 * and `sh`. Everything else is reachable from the script through `mcp`:
 *
 *   mcp call page-interact.page_snapshot | jq -r '.content[0].text' | grep Submit
 *   mcp call network-monitor.network_requests | jq '.content[0].text | fromjson'
 *
 * The filesystem is the same IndexedDB library the file tools use, so a script
 * can write a file and the model can read it with `file_read` (and vice versa).
 *
 * This module is deliberately light: it owns the tool's declaration and result
 * shape, while the interpreter (just-bash, QuickJS, the commands) lives behind a
 * dynamic import in `./runtime/execute`. `lib/ai.ts` imports this file for the
 * programmatic tool set, so a static import of the runtime would put the whole
 * interpreter in the side panel for users who never enable the feature.
 */

import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { mcpToModelOutput } from '@/lib/mcp/registry';
import type { ShellResult } from './runtime/execute';
import {
  PROGRAMMATIC_FILE_TOOLS,
  SHELL_INPUT_SCHEMA,
  SHELL_TOOL_DESCRIPTION,
  SHELL_TOOL_NAME,
  type ShellToolContext,
} from './descriptor';

export {
  PROGRAMMATIC_FILE_TOOLS,
  SHELL_INPUT_SCHEMA,
  SHELL_TOOL_DESCRIPTION,
  SHELL_TOOL_NAME,
  shellToolDescriptor,
  type ShellToolContext,
} from './descriptor';

export type { ShellResult } from './runtime/execute';

/**
 * Replace the flat MCP tool list with four tools: three file tools and `sh`.
 *
 * A missing file tool is omitted rather than replaced, so a registry that failed
 * to connect the file server cannot advertise a tool with no executor; `sh` is
 * always present because it is built here, not discovered.
 */
export function buildProgrammaticToolSet(
  allTools: ToolSet,
  context: ShellToolContext = {},
): ToolSet {
  const picked: ToolSet = {};
  for (const name of PROGRAMMATIC_FILE_TOOLS) {
    const fileTool = allTools[name];
    if (fileTool) picked[name] = fileTool;
  }
  picked[SHELL_TOOL_NAME] = createShellTool(context) as ToolSet[string];
  return picked;
}

export function createShellTool(context: ShellToolContext) {
  return tool({
    description: SHELL_TOOL_DESCRIPTION,
    inputSchema: SHELL_INPUT_SCHEMA,
    execute: async ({ command, cwd, timeoutMs }, options) => {
      let result: ShellResult;
      try {
        // The lazy boundary: only the first `sh` call parses the interpreter.
        // A static import here would put just-bash and QuickJS back into the
        // side-panel chunk for every user, whether or not the mode is on.
        const { executeShell } = await import('./runtime/execute');
        result = await executeShell(
          context,
          { command, ...(cwd ? { cwd } : {}), ...(timeoutMs ? { timeoutMs } : {}) },
          options?.abortSignal,
        );
      } catch (error) {
        result = {
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
          truncated: false,
          attachments: [],
        };
      }

      const summary = {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        ...(result.truncated ? { truncated: true } : {}),
        ...(result.fullOutputPath ? { fullOutputPath: result.fullOutputPath } : {}),
        ...(result.attachments.length > 0
          ? {
              attachments: result.attachments.map(({ path, mimeType }) => ({ path, mimeType })),
            }
          : {}),
      };

      // Return a CallToolResult so the existing registry/model-output path
      // (text + image content parts) handles it unchanged.
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(summary, null, 2) },
          ...result.attachments.map((attachment) => ({
            type: 'image' as const,
            data: attachment.data,
            mimeType: attachment.mimeType,
          })),
        ],
        isError: result.exitCode !== 0,
      };
    },
    toModelOutput: (options) => mcpToModelOutput(options) as never,
  });
}
