/**
 * The `sh` tool's declaration, kept free of the runtime.
 *
 * History conversion, the model prompt and the UI all need to name the tool and
 * describe its input, but only execution needs just-bash and QuickJS. Splitting
 * the declaration out means a turn that happens to contain an old `sh` call can
 * be converted back into a model prompt without loading the interpreter, and a
 * single constant names the tool everywhere instead of five literal `'sh'`s.
 */

import { z } from 'zod';
import { mcpToModelOutput } from '@/lib/mcp/registry';

/** The one tool that executes scripts. Referenced by UI, prompt and fingerprint. */
export const SHELL_TOOL_NAME = 'sh';

/** Per-call scope: which conversation owns files the script writes. */
export interface ShellToolContext {
  conversationId?: string;
}

/**
 * The file tools the model keeps in programmatic mode.
 *
 * Everything else the flat list used to expose is reachable from `sh` instead.
 */
export const PROGRAMMATIC_FILE_TOOLS = ['file_read', 'file_write', 'file_edit'] as const;

export const SHELL_INPUT_SCHEMA = z.object({
  command: z.string().describe('Bash script to execute'),
  cwd: z.string().optional().describe('Working directory (default: /)'),
  timeoutMs: z
    .number()
    .optional()
    .describe('Wall-clock limit in milliseconds. Omit for no limit.'),
});

export const SHELL_TOOL_DESCRIPTION = [
  'Execute a bash script. The filesystem is shared with file_read/file_write/file_edit.',
  'Supports pipes, redirections, variables, functions, loops, globs, grep/sed/awk/jq,',
  'curl, tar, zip/unzip, yq, iconv, and JavaScript via `node` (timers, Buffer,',
  'crypto hashes, zlib, fetch, require of builtins and relative files, ESM syntax,',
  'child_process.exec, MCP tools).',
  '',
  'Not available in a browser extension: sockets (http/net/dns), processes,',
  'synchronous fs/exec, python3, sqlite3, symlinks. `fs.*Sync` fails with the',
  '`await` form to use instead.',
  '',
  'MCP tools are shell commands:',
  '  mcp list',
  '  mcp tools <server>',
  '  mcp describe <server>.<tool>',
  "  mcp call <server>.<tool> '<json>' [--output path] [--raw]",
  '',
  'Use mcp tools/describe to discover parameters; do not guess schemas.',
  'Images are written under tmp/ and can be read with file_read.',
  'Large output is truncated; the full text path is reported.',
].join('\n');

/**
 * A definition usable for `convertToModelMessages` without an executor.
 *
 * `toModelOutput` is the only field the AI SDK consults when replaying stored
 * tool results, so this is what lets a transcript written in one mode stay
 * readable in the other.
 */
export const shellToolDescriptor = {
  name: SHELL_TOOL_NAME,
  description: SHELL_TOOL_DESCRIPTION,
  inputSchema: SHELL_INPUT_SCHEMA,
  toModelOutput: (options: { toolCallId: string; input: unknown; output: unknown }) =>
    mcpToModelOutput(options),
} as const;
