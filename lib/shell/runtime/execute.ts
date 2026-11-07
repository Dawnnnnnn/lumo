/**
 * The shell runtime: just-bash, the browser commands and the VFS bridge.
 *
 * Kept behind a dynamic import (`lib/shell/tool.ts`) so an install that never
 * enables programmatic tools does not parse ~1.5 MB of interpreter at side-panel
 * startup. Everything here is process-local; nothing in this file may be
 * imported by `lib/ai.ts`, the prompt, or history conversion.
 */

import { Bash } from 'just-bash/browser';
import type { SecureFetch } from 'just-bash';
import { TMP_DIR, LumoFileSystem } from '../vfs';
import { hostTimeZone } from '../env';
import { withKeyLock } from '../lock';
import { createMcpCommand } from '../mcp-command';
import type { ShellAttachment } from '../images';
import { createNodeCommand } from '../node-command';
import { createArchiveCommands } from '../archive-command';
import { createIconvCommand } from '../iconv-command';
import { createYqCommand } from '../yq-command';
import type { ShellToolContext } from '../descriptor';
import type { ShellResult } from '../result';
import { createToolGateway } from '@/lib/tools/gateway';
import { MAX_TIMER_DELAY_MS, NO_TIMEOUT_MS } from './limits';

/**
 * What the model sees before the full output is spilled to `tmp/`.
 *
 * These are context-size limits, not execution limits: they match the harness's
 * standard 2000-line / 50 KB tool-output preview. The interpreter itself is not
 * capped at this size — `normal` limits allow up to 256 MiB, and the model reads
 * the rest through the spill path.
 */
const MAX_OUTPUT_LINES = 2000;
const MAX_OUTPUT_CHARS = 50_000;

/**
 * Monotonic suffix for spilled output.
 *
 * Parallel `sh` calls can start in the same millisecond; without it, the second
 * spill would overwrite the first and both call results would name one file.
 */
let spillCounter = 0;

export type { ShellResult } from '../result';

interface FetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
  url: string;
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) {
    const lines = text.split('\n');
    if (lines.length <= MAX_OUTPUT_LINES) return { text, truncated: false };
    return { text: lines.slice(0, MAX_OUTPUT_LINES).join('\n'), truncated: true };
  }
  return { text: text.slice(0, MAX_OUTPUT_CHARS), truncated: true };
}

/**
 * Unrestricted host fetch.
 *
 * The shell's `curl` is intentionally full-featured here: the extension already
 * holds `<all_urls>` and every MCP server is a network client, so a second
 * allow-list would only create a false sense of containment. The isolation that
 * matters is that scripts cannot reach `chrome.*` and JavaScript runs in QuickJS.
 */
function hostFetch(): SecureFetch {
  return async (url, options = {}): Promise<FetchResult> => {
    const response = await globalThis.fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers as HeadersInit | undefined,
      body: options.body as BodyInit | undefined,
      redirect: options.followRedirects === false ? 'manual' : 'follow',
      signal: options.signal,
    });
    const body = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body,
      url: response.url || url,
    };
  };
}

export async function executeShell(
  context: ShellToolContext,
  input: { command: string; cwd?: string; timeoutMs?: number },
  abortSignal?: AbortSignal,
): Promise<ShellResult> {
  // One script at a time per conversation: the VFS index and the read-modify-
  // write sequences inside a script cannot be made atomic by IndexedDB.
  return withKeyLock(`sh:${context.conversationId ?? 'global'}`, async () => {
    const fs = new LumoFileSystem({ conversationId: context.conversationId });
    await fs.refresh();

    // One tool surface for the whole script: `mcp` and `node` see the same
    // snapshot, and an invocation never needs a second gateway.
    const gateway = createToolGateway();
    const attachments: ShellAttachment[] = [];
    const mcp = createMcpCommand({
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      attachments,
      gateway,
    });

    // No implicit timeout: the caller may bound a script explicitly, otherwise
    // it runs until it finishes or the turn is aborted. The sentinel exists only
    // because browser timers cannot represent Infinity safely.
    const requested = input.timeoutMs;
    const timeoutMs =
      requested !== undefined && requested > 0
        ? Math.max(1_000, Math.min(requested, MAX_TIMER_DELAY_MS))
        : NO_TIMEOUT_MS;
    const timeZone = hostTimeZone();
    const bash = new Bash({
      fs,
      cwd: '/',
      env: {
        HOME: '/',
        PWD: '/',
        USER: 'lumo',
        SHELL: '/bin/bash',
        ...(timeZone ? { TZ: timeZone } : {}),
        ...(context.conversationId ? { LUMO_CONVERSATION_ID: context.conversationId } : {}),
      },
      customCommands: [
        mcp,
        createNodeCommand({
          ...(context.conversationId ? { conversationId: context.conversationId } : {}),
          gateway,
          attachments,
        }),
        ...createArchiveCommands(),
        createIconvCommand(),
        createYqCommand(),
      ],
      // `normal` is just-bash's compatibility profile: 64 MiB source/heredoc/
      // string, 512 MiB live/input bytes, 256 MiB output, 1 GiB archives. The
      // previous `hardened` values (8 MiB source, 10 MiB string, 64 MiB live,
      // 10 MiB output) were security defaults for untrusted compute, not limits
      // this product needs.
      executionLimitProfile: 'normal',
      executionLimits: {
        maxExecutionTimeMs: timeoutMs,
        // No configurable budgets: the interpreter's own counters stay at the
        // engine's maximum safe integer, so only available memory/stack stops a
        // pathological script. The settings page intentionally exposes none of
        // these.
        maxCommandCount: Number.MAX_SAFE_INTEGER,
        maxLoopIterations: Number.MAX_SAFE_INTEGER,
        maxCallDepth: Number.MAX_SAFE_INTEGER,
        maxExecDepth: Number.MAX_SAFE_INTEGER,
        maxSubstitutionDepth: Number.MAX_SAFE_INTEGER,
        maxSourceDepth: Number.MAX_SAFE_INTEGER,
        // No artificial allocation/source ceilings. The panel's JS heap and
        // the browser's storage quota are the real limits; a fixed 64 MiB live
        // budget made legitimate large-file pipelines fail for no benefit.
        maxSourceBytes: Number.MAX_SAFE_INTEGER,
        maxHeredocSize: Number.MAX_SAFE_INTEGER,
        maxLiveBytes: Number.MAX_SAFE_INTEGER,
        maxStringLength: Number.MAX_SAFE_INTEGER,
        maxInputBytes: Number.MAX_SAFE_INTEGER,
        // No output ceiling either: the model still sees only the 2000-line /
        // 50 KB preview, and the full text is spilled to tmp/. A fixed 256 MiB
        // just-bash cap would fail a legitimate large `cat` before that path.
        maxOutputSize: Number.MAX_SAFE_INTEGER,
      },
      fetch: hostFetch(),
    });

    const result = await bash.exec(input.command, {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(abortSignal ? { signal: abortSignal } : {}),
      // Heredocs and indented scripts keep their leading whitespace.
      rawScript: true,
    });

    const stdout = truncate(result.stdout);
    const stderr = truncate(result.stderr);
    const truncated = stdout.truncated || stderr.truncated;

    let fullOutputPath: string | undefined;
    if (truncated) {
      spillCounter += 1;
      const name = `sh-${Date.now()}-${spillCounter}.txt`;
      const path = `/${TMP_DIR}/${name}`;
      const parts = [result.stdout];
      if (result.stderr.length > 0) parts.push('--- stderr ---', result.stderr);
      try {
        await fs.mkdir(`/${TMP_DIR}`, { recursive: true }).catch(() => undefined);
        await fs.writeFile(path, parts.join('\n'));
        fullOutputPath = path;
      } catch {
        // A failed spill (quota, torn-down context) must not cost the model the
        // preview it already has. Report the truncation without a path instead.
        stderr.text += '\n[full output could not be written to tmp/]';
      }
    }

    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: result.exitCode,
      truncated,
      ...(fullOutputPath ? { fullOutputPath } : {}),
      attachments,
    };
  });
}
