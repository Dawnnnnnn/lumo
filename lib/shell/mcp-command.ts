/**
 * `mcp` — the shell's window onto every MCP server.
 *
 * The command is deliberately a *discovery* interface first:
 *
 *   mcp list
 *   mcp tools <server>
 *   mcp describe <server>.<tool>
 *   mcp call <server>.<tool> '<json>' [--output path] [--quiet] [--raw] [--json]
 *
 * Tool schemas are never injected into the system prompt. The model asks for the
 * one it needs, which keeps 31 built-ins plus every external server from turning
 * into tens of thousands of prompt tokens.
 *
 * Resolution, normalization and invocation live in the {@link ToolGateway}; this
 * command only parses arguments and formats the answer. Images are written into
 * the shared VFS (`tmp/`) by {@link materializeToolImages} and collected in
 * `attachments`; the shell tool turns those into model-visible image parts. The
 * same file is readable by `file_read` on the next turn.
 */

import { defineCommand, type ExecResult, type ResolvedCommandContext } from 'just-bash/browser';
import type { ByteString } from 'just-bash';
import {
  createToolGateway,
  isTextPart,
  type NormalizedToolResult,
  type ToolGateway,
} from '@/lib/tools/gateway';
import {
  materializeToolImages,
  textOfContent,
  type ShellAttachment,
  type SpilledImage,
} from './images';
import { bytesFromBase64 } from '@/lib/encoding';
import { IMAGE_EXTENSIONS } from '@/lib/mcp/image-types';

/** Extensions that make `--output` mean "write the image bytes". */
const IMAGE_OUTPUT_EXTENSIONS = new Set([
  ...Object.values(IMAGE_EXTENSIONS),
  'jpeg',
  'avif',
]);

/** Whether the requested output path names an image by extension. */
function isImageOutputPath(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return false;
  return IMAGE_OUTPUT_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

export type { ShellAttachment } from './images';

export interface McpCommandOptions {
  conversationId?: string;
  /** Filled by the command; read by the shell tool after `exec()`. */
  attachments?: ShellAttachment[];
  /**
   * Where tool calls go. Defaults to the registry; injecting one lets the
   * caller share a single tool-surface snapshot across `mcp` and `node`.
   */
  gateway?: ToolGateway;
}

/** How many `mcp batch` lines may be in flight at once. */
const BATCH_CONCURRENCY = 4;

function decodeStdin(stdin: ByteString): string {
  // `ctx.stdin` is a latin1-shaped byte string; decode it as UTF-8 so JSON
  // passed through a pipe is not mangled.
  const latin1 = stdin as unknown as string;
  const bytes = Uint8Array.from(latin1, (char) => char.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function firstLine(value: string): string {
  const line = value.split('\n')[0] ?? '';
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

function help(): ExecResult {
  return {
    stdout: [
      'Usage:',
      '  mcp list [--json]',
      '  mcp tools <server> [--json]',
      '  mcp describe <server>.<tool>',
      '  mcp call <server>.<tool> [<json>] [--params <json>] [--output <path>] [--quiet] [--raw] [--json]',
      '  mcp call --server <id> --tool <name> [--params <json>]',
      '  mcp batch < <jsonl>',
      '',
      'Notes:',
      '  - Parameters can be passed positionally, with --params, or on stdin.',
      '  - Images are written under tmp/ and printed as paths.',
      '  - --output writes image bytes when the path is an image (or the result is image-only);',
      '    otherwise it writes the text result.',
      '  - --quiet suppresses stdout, so --output can be used without echoing the payload.',
      '  - A tool failure sets a non-zero exit code and writes to stderr.',
    ].join('\n') + '\n',
    stderr: '',
    exitCode: 0,
  };
}

interface CallArgs {
  server?: string;
  tool?: string;
  params?: string;
  output?: string;
  raw: boolean;
  json: boolean;
  quiet: boolean;
  positional: string[];
}

function parseCallArgs(args: string[]): CallArgs {
  const parsed: CallArgs = { raw: false, json: false, quiet: false, positional: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    switch (arg) {
      case '--server':
      case '-s':
        parsed.server = args[++i];
        break;
      case '--tool':
      case '-t':
        parsed.tool = args[++i];
        break;
      case '--params':
      case '-p':
        parsed.params = args[++i];
        break;
      case '--output':
      case '-o':
        parsed.output = args[++i];
        break;
      case '--raw':
        parsed.raw = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--quiet':
      case '-q':
        parsed.quiet = true;
        break;
      case '--':
        parsed.positional.push(...args.slice(i + 1));
        i = args.length;
        break;
      default:
        parsed.positional.push(arg);
    }
  }

  if (!parsed.server || !parsed.tool) {
    const target = parsed.positional.shift();
    if (target) {
      const dot = target.indexOf('.');
      if (dot > 0) {
        parsed.server = parsed.server ?? target.slice(0, dot);
        parsed.tool = parsed.tool ?? target.slice(dot + 1);
      }
    }
  }
  if (!parsed.params && parsed.positional.length > 0) {
    parsed.params = parsed.positional.shift();
  }
  return parsed;
}

async function writeOutput(
  ctx: ResolvedCommandContext,
  path: string,
  data: string | Uint8Array,
): Promise<string> {
  const absolute = ctx.fs.resolvePath(ctx.cwd, path);
  const parent = absolute.slice(0, absolute.lastIndexOf('/')) || '/';
  await ctx.fs.mkdir(parent, { recursive: true }).catch(() => undefined);
  await ctx.fs.writeFile(absolute, data);
  return absolute;
}

interface CallOutcome {
  isError: boolean;
  content: NormalizedToolResult;
  images: SpilledImage[];
  text: string;
  attachments: ShellAttachment[];
}

async function callTool(
  ctx: ResolvedCommandContext,
  gateway: ToolGateway,
  options: McpCommandOptions,
  serverQuery: string,
  toolQuery: string,
  params: unknown,
): Promise<CallOutcome> {
  const server = gateway.resolveServer(serverQuery);
  const definition = gateway.resolveTool(server.id, toolQuery);
  const result = await gateway.invoke(server.id, definition.name, params, {
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    signal: ctx.signal,
  });

  const materialized = await materializeToolImages(ctx.fs, result.content, { attach: true });

  const textParts: string[] = [];
  if (result.structuredContent !== undefined && !materialized.content.some(isTextPart)) {
    textParts.push(JSON.stringify(result.structuredContent));
  }
  // `textOfContent` renders text parts verbatim and images as `[image] path`,
  // so a pipeline can see where a screenshot landed.
  const rendered = textOfContent(materialized.content);
  if (rendered.length > 0) textParts.push(rendered);
  if (textParts.length === 0 && materialized.content.length > 0) {
    textParts.push(JSON.stringify(materialized.content));
  }

  const text = textParts.join('\n');
  return {
    isError: result.isError,
    content: { ...result, content: materialized.content },
    images: materialized.images,
    text,
    attachments: materialized.attachments,
  };
}

async function runCall(
  ctx: ResolvedCommandContext,
  gateway: ToolGateway,
  options: McpCommandOptions,
  args: string[],
): Promise<ExecResult> {
  const parsed = parseCallArgs(args);
  if (!parsed.server || !parsed.tool) {
    return {
      stdout: '',
      stderr: 'mcp call: expected <server>.<tool> or --server/--tool\n',
      exitCode: 2,
    };
  }

  const stdinText = decodeStdin(ctx.stdin).trim();
  const rawParams = parsed.params ?? (stdinText.length > 0 ? stdinText : '{}');
  let params: unknown;
  try {
    params = rawParams.length > 0 ? JSON.parse(rawParams) : {};
  } catch (error) {
    return {
      stdout: '',
      stderr: `mcp call: invalid JSON parameters: ${error instanceof Error ? error.message : String(error)}\n`,
      exitCode: 2,
    };
  }

  try {
    const outcome = await callTool(ctx, gateway, options, parsed.server, parsed.tool, params);
    const materialized = outcome.content;

    // The shell tool reads this array after `exec()`; without it the image is
    // written to tmp/ but never reaches the model or the transcript.
    options.attachments?.push(...outcome.attachments);

    if (parsed.output) {
      // Image bytes win when the requested path names an image, even if the
      // tool also returned a caption: `page_screenshot --output shot.png` must
      // produce a PNG, not its "Screenshot captured" line. An image-only result
      // still writes bytes to any path, and everything else writes text.
      const hasText = materialized.content.some((part) => part.type === 'text');
      const writeImage =
        outcome.images.length === 1 && (!hasText || isImageOutputPath(parsed.output));
      if (writeImage) {
        await writeOutput(ctx, parsed.output, bytesFromBase64(outcome.images[0]!.data));
      } else {
        await writeOutput(ctx, parsed.output, outcome.text);
      }
    }

    let stdout: string;
    if (parsed.json) {
      stdout = JSON.stringify(outcome.content, null, 2) ?? '';
    } else if (parsed.raw) {
      stdout = materialized.content.find(isTextPart)?.text ?? outcome.text;
    } else {
      stdout = outcome.text;
    }

    if (outcome.isError) {
      return {
        stdout: '',
        stderr: `${stdout || 'Tool returned an error.'}\n`,
        exitCode: 1,
      };
    }
    return {
      stdout: parsed.quiet || stdout.length === 0 ? '' : `${stdout}\n`,
      stderr: '',
      exitCode: 0,
    };
  } catch (error) {
    return {
      stdout: '',
      stderr: `mcp call: ${error instanceof Error ? error.message : String(error)}\n`,
      exitCode: 1,
    };
  }
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
async function mapSettled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        try {
          results[index] = { status: 'fulfilled', value: await worker(items[index]!, index) };
        } catch (reason) {
          results[index] = { status: 'rejected', reason };
        }
      }
    }),
  );
  return results;
}

async function runBatch(
  ctx: ResolvedCommandContext,
  gateway: ToolGateway,
  options: McpCommandOptions,
): Promise<ExecResult> {
  const input = decodeStdin(ctx.stdin).trim();
  if (input.length === 0) {
    return { stdout: '', stderr: 'mcp batch: expected JSONL on stdin\n', exitCode: 2 };
  }

  const lines = input.split('\n').map((line) => line.trim()).filter(Boolean);
  // A batch fans out into arbitrary browser operations; running every line at
  // once would let a 500-line file issue 500 concurrent tab operations.
  const settled = await mapSettled(lines, BATCH_CONCURRENCY, async (line, index) => {
    let request: { server?: string; tool?: string; params?: unknown; target?: string };
    try {
      request = JSON.parse(line) as typeof request;
    } catch (error) {
      throw new Error(
        `line ${index + 1}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const target =
      request.target ?? (request.server && request.tool ? `${request.server}.${request.tool}` : undefined);
    if (!target) throw new Error(`line ${index + 1}: expected {server, tool, params} or {target, params}`);
    const dot = target.indexOf('.');
    if (dot <= 0) throw new Error(`line ${index + 1}: target must be <server>.<tool>`);
    return callTool(
      ctx,
      gateway,
      options,
      target.slice(0, dot),
      target.slice(dot + 1),
      request.params ?? {},
    );
  });

  const output: string[] = [];
  let failed = 0;
  settled.forEach((entry, index) => {
    if (entry.status === 'fulfilled') {
      const { isError, text, attachments } = entry.value;
      // Collected in line order, not completion order: images reach the model
      // in the same sequence the script asked for them.
      options.attachments?.push(...attachments);
      if (isError) failed += 1;
      output.push(
        JSON.stringify({
          line: index + 1,
          ok: !isError,
          text,
          attachments: attachments.map((attachment) => ({
            path: attachment.path,
            mimeType: attachment.mimeType,
          })),
        }),
      );
    } else {
      failed += 1;
      output.push(
        JSON.stringify({
          line: index + 1,
          ok: false,
          error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
        }),
      );
    }
  });

  return {
    stdout: `${output.join('\n')}\n`,
    stderr: failed > 0 ? `${failed} of ${lines.length} call(s) failed\n` : '',
    exitCode: failed > 0 ? 1 : 0,
  };
}

export function createMcpCommand(options: McpCommandOptions = {}) {
  // One gateway per shell execution: the server list is snapshotted here, so a
  // script cannot lose a tool mid-run because another context reconnected a
  // server, and every call shares the same resolution rules.
  const gateway = options.gateway ?? createToolGateway();

  return defineCommand('mcp', async (args, ctx) => {
    const [subcommand, ...rest] = args;
    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      return help();
    }

    if (subcommand === 'list' || subcommand === 'servers') {
      const servers = gateway.listServers();
      if (rest.includes('--json')) {
        // Keep the historical field name (`tools` as a count) so a script that
        // parsed this before the gateway existed keeps working.
        const payload = servers.map((server) => ({
          id: server.id,
          name: server.name,
          status: server.status,
          enabled: server.enabled,
          builtin: server.builtin,
          tools: server.toolCount,
          ...(server.error ? { error: server.error } : {}),
        }));
        return {
          stdout: JSON.stringify(payload, null, 2) + '\n',
          stderr: '',
          exitCode: 0,
        };
      }
      const rows = servers.map(
        (server) =>
          `${server.id.padEnd(20)} ${server.status.padEnd(14)} ${String(server.toolCount).padStart(3)}  ${server.name}`,
      );
      return { stdout: `${rows.join('\n')}\n`, stderr: '', exitCode: 0 };
    }

    if (subcommand === 'tools') {
      const query = rest.find((arg) => !arg.startsWith('-'));
      if (!query) return { stdout: '', stderr: 'mcp tools: expected a server\n', exitCode: 2 };
      let server;
      try {
        server = gateway.resolveServer(query);
      } catch (error) {
        return {
          stdout: '',
          stderr: `mcp tools: ${error instanceof Error ? error.message : String(error)}\n`,
          exitCode: 1,
        };
      }
      const tools = gateway.listTools(server.id);

      if (rest.includes('--json')) {
        return { stdout: JSON.stringify(tools, null, 2) + '\n', stderr: '', exitCode: 0 };
      }
      const rows = tools.map((tool) => `${tool.name.padEnd(34)} ${firstLine(tool.description)}`);
      return { stdout: `${rows.join('\n')}\n`, stderr: '', exitCode: 0 };
    }

    if (subcommand === 'describe' || subcommand === 'schema') {
      const query = rest.find((arg) => !arg.startsWith('-'));
      if (!query) return { stdout: '', stderr: 'mcp describe: expected <server>.<tool>\n', exitCode: 2 };
      const dot = query.indexOf('.');
      if (dot <= 0) return { stdout: '', stderr: 'mcp describe: expected <server>.<tool>\n', exitCode: 2 };
      try {
        const server = gateway.resolveServer(query.slice(0, dot));
        const tool = gateway.resolveTool(server.id, query.slice(dot + 1));
        return { stdout: JSON.stringify(tool, null, 2) + '\n', stderr: '', exitCode: 0 };
      } catch (error) {
        return {
          stdout: '',
          stderr: `mcp describe: ${error instanceof Error ? error.message : String(error)}\n`,
          exitCode: 1,
        };
      }
    }

    if (subcommand === 'call') {
      return runCall(ctx, gateway, options, rest);
    }

    if (subcommand === 'batch') {
      return runBatch(ctx, gateway, options);
    }

    return {
      stdout: '',
      stderr: `mcp: unknown subcommand "${subcommand}" (try: mcp help)\n`,
      exitCode: 2,
    };
  });
}
