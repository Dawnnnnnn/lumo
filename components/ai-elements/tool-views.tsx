import { SHELL_TOOL_NAME } from '@/lib/shell/descriptor';
import { parseShellResult } from '@/lib/shell/result';
import {
  ShellToolInput,
  ShellToolOutput,
  shellToolExitCode,
  shellToolSummary,
  type ToolView,
} from './shell-tool';

/**
 * Specialised tool renderers, keyed by tool name.
 *
 * The generic card handles every MCP tool well enough; a few need more (a shell
 * result is a JSON summary hiding an exit code). Keeping that knowledge in a
 * registry means the card stays generic — no `name === 'sh'` branch, no
 * payload parsing in the layout code — and adding a view is additive.
 */
const VIEWS: Record<string, ToolView> = {
  [SHELL_TOOL_NAME]: {
    ltr: true,
    summarize: (part) => shellToolSummary(part.input),
    // A script that exits non-zero is a failure even though the tool call
    // resolved; the result only carries the exit code once output arrives.
    failed: (part) => (shellToolExitCode(part.output) ?? 0) !== 0,
    renderInput: (part) => <ShellToolInput input={part.input} />,
    // `undefined` means "not a shell result": fall back to the generic output
    // rather than rendering nothing (a resumed transcript can hold a shape this
    // build no longer recognises).
    renderOutput: (part) =>
      parseShellResult(part.output) ? <ShellToolOutput output={part.output} /> : undefined,
  },
};

export function toolViewFor(name: string): ToolView | undefined {
  return VIEWS[name];
}

export type { ToolView } from './shell-tool';
