/**
 * System-prompt addendum for programmatic mode.
 *
 * Kept short because the `sh` tool description already carries the command
 * syntax. What the model cannot infer from schemas is the *shape* of the
 * environment: four tools, a shared filesystem, and discovery-first MCP access.
 */

import { PROGRAMMATIC_FILE_TOOLS, SHELL_TOOL_NAME } from './descriptor';

export const PROGRAMMATIC_TOOLS_PROMPT = `## Programmatic mode

You have four tools: ${PROGRAMMATIC_FILE_TOOLS.join(', ')} and ${SHELL_TOOL_NAME}.

\`${SHELL_TOOL_NAME}\` executes a bash-like script. Its filesystem is shared with the file tools:
\`/notes.md\` and the file path \`notes.md\` are the same file, and \`/skills\`
is writable like any other directory. Use pipes, redirections, variables,
functions and loops. Common commands are available (ls, cat, grep, sed, awk,
jq, sort, uniq, head, tail, wc, find, xargs, curl, node).

Every MCP server is a shell command:

    mcp list
    mcp tools <server>
    mcp describe <server>.<tool>
    mcp call <server>.<tool> '<json>' [--output path] [--raw]

Discover a tool's schema before calling it; do not guess parameter names.
Pass JSON positionally or on stdin. Images are written under tmp/ and are also
visible to file_read. When output is large, keep it in tmp/ and inspect it with
grep/head/tail instead of printing everything.

For work that is awkward as a pipeline, \`node -e '<script>'\` runs JavaScript
(QuickJS) with top-level await, timers, \`await exec('command')\` to run
shell commands, \`require\` for path/os/fs/crypto, and \`fetch\`. Use
\`await tools['<server>']['<tool>'](params)\` (bracket access, because server ids
contain hyphens) to call MCP tools from JavaScript. There is no node_modules and
no full Node stdlib: \`import\` statements are rewritten to the built-in shims,
but a package you would normally \`npm install\` is not available.

Prefer reading over writing, and confirm destructive or irreversible actions
with the user before running them.`;
