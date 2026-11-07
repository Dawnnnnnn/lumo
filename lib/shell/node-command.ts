/**
 * `node` — JavaScript execution inside the shell.
 *
 * `just-bash`'s own `js-exec` is Node-only, so the shell supplies its own
 * command backed by QuickJS/WASM. The guest receives a practical subset of
 * Node rather than the full runtime (see `runtime/guest-runtime.js`):
 *
 *  - timers (Node-shaped `Timeout` objects), `TextEncoder`/`TextDecoder`
 *    (honouring the label, `fatal` and BOM rules), `atob`/`btoa`, `URL`,
 *    `Buffer`, `AbortController`/`AbortSignal`, `Headers`/`Request`/`Response`,
 *  - `crypto` randomness plus `createHash`/`createHmac`/`timingSafeEqual`,
 *  - `require` for a built-in set: path, os, util, events, fs, fs/promises,
 *    crypto, buffer, child_process, url, timers, timers/promises, assert,
 *    zlib, stream, querystring, string_decoder, perf_hooks, process, console,
 *  - `require('./relative.js')` and `require('./data.json')` resolved against
 *    the VFS before the VM starts (see `prepareModules`),
 *  - top-level `import`/`export` statements (downgraded to the CJS shims),
 *  - `tools.<server>.<tool>(params)` and `mcp.*` — every MCP server,
 *  - `fs.*` — the shared VFS,
 *  - `fetch(url, init)` — host fetch, matching the shell's unrestricted `curl`,
 *  - `exec(command[, options][, callback])` — runs a shell command in the same
 *    interpreter and captures stdout/stderr/exit code.
 *
 * Host calls return QuickJS promises and are settled from the host side. The
 * sync VM is driven by `runtime.executePendingJobs()`; the pump wakes as soon
 * as a bridge call settles instead of polling, so `await` costs one host
 * microtask turn rather than a timer tick.
 *
 * Errors keep their `code`/`errno`/`syscall`/`path` properties across the
 * bridge (`errorHandle`), because guest code branches on `err.code`.
 */

import { defineCommand, type ExecResult, type ResolvedCommandContext } from 'just-bash/browser';
import type { ByteString } from 'just-bash';
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSWASMModule,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import wasmUrl from '@jitl/quickjs-wasmfile-release-sync/wasm?url';
import {
  gunzipSync as fflateGunzipSync,
  gzipSync as fflateGzipSync,
  unzlibSync,
  zlibSync,
} from 'fflate';
import {
  createToolGateway,
  type NormalizedToolResult,
  type ToolGateway,
} from '@/lib/tools/gateway';
import { materializeToolImages, type ShellAttachment } from './images';
import { base64FromBytes as base64Of, bytesFromBase64 as bytesOfBase64, bytesFromLatin1 } from '@/lib/encoding';
import { combineAbortSignals as combineSignals } from '@/lib/abort';
import { TMP_DIR } from './vfs';
import { MAX_TIMER_DELAY_MS, NO_TIMEOUT_MS } from './runtime/limits';
import guestRuntimeSource from './runtime/guest-runtime.js?raw';

function extensionVersion(): string {
  try {
    const runtime = (globalThis as {
      chrome?: { runtime?: { getManifest?: () => { version?: string } } };
    }).chrome;
    return runtime?.runtime?.getManifest?.().version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
/**
 * Fetch bodies larger than this are cut off and reported as truncated.
 *
 * This is a host-memory guard for `fetch`, not a shell-output cap: bodies above
 * MAX_INLINE_FETCH_BYTES are already spilled to the VFS instead of crossing the
 * JSON bridge.
 */
const MAX_FETCH_BYTES = 64 * 1024 * 1024;
/**
 * Bodies above this size are written to the VFS instead of the JSON bridge.
 *
 * Two reasons: a multi-hundred-KB string travelling as JSON (plus its base64
 * copy) is the most expensive bridge call a script can make, and QuickJS's
 * `JS_FreeRuntime` occasionally asserts on a leaked object after a large
 * inline response body. Spilling keeps every bridge payload small.
 */
const MAX_INLINE_FETCH_BYTES = 128 * 1024;
/**
 * QuickJS stack size.
 *
 * The engine requires a finite stack (there is no "infinite" setting). 2 MiB
 * was too tight for ordinary recursive utilities; this wasm build fails to
 * initialize at 6 MiB, so 5 MiB is the engine ceiling, not a product choice.
 */
const MAX_STACK_SIZE_BYTES = 5 * 1024 * 1024;

let modulePromise: Promise<QuickJSWASMModule> | undefined;

async function getQuickJSModule(): Promise<QuickJSWASMModule> {
  if (!modulePromise) {
    modulePromise = newQuickJSWASMModuleFromVariant(
      newVariant(variant, {
        // Vite emits the wasm asset and gives us its URL, which avoids relying
        // on `import.meta.url` resolution inside a pre-bundled dependency.
        wasmBinary: () => fetch(wasmUrl).then((response) => response.arrayBuffer()),
      }),
    );
  }
  return modulePromise;
}

function decodeStdin(stdin: ByteString): string {
  // `ctx.stdin` is a latin1-shaped byte string; decode the bytes as UTF-8 so a
  // piped script is not mangled.
  return new TextDecoder('utf-8').decode(bytesFromLatin1(stdin as unknown as string));
}

interface NodeArgs {
  code?: string;
  script?: string;
  print: boolean;
  check: boolean;
  version: boolean;
  help: boolean;
  args: string[];
}

function parseArgs(args: string[]): NodeArgs {
  const parsed: NodeArgs = { print: false, check: false, version: false, help: false, args: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '-e' || arg === '--eval') {
      parsed.code = args[++i] ?? '';
      parsed.args = args.slice(i + 1);
      return parsed;
    }
    if (arg === '--eval=') {
      parsed.code = '';
      return parsed;
    }
    if (arg === '-p' || arg === '--print') {
      parsed.print = true;
      parsed.code = args[++i] ?? '';
      parsed.args = args.slice(i + 1);
      return parsed;
    }
    if (arg === '--check') {
      parsed.check = true;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      parsed.version = true;
      return parsed;
    }
    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
      return parsed;
    }
    // Accepted and ignored: they change nothing in a WASM runtime but scripts
    // and agents probe for them.
    if (
      arg === '--no-warnings' ||
      arg === '--trace-warnings' ||
      arg === '--enable-source-maps' ||
      arg === '--no-deprecation' ||
      arg === '--throw-deprecation' ||
      arg === '--experimental-strip-types' ||
      arg === '--no-experimental-strip-types' ||
      arg.startsWith('--max-old-space-size=') ||
      arg.startsWith('--stack-size=') ||
      arg.startsWith('--input-type=')
    ) {
      continue;
    }
    if (arg === '--input-type') {
      i += 1;
      continue;
    }
    if (arg === '-') {
      parsed.script = '-';
      parsed.args = args.slice(i + 1);
      return parsed;
    }
    if (arg.startsWith('-') && arg !== '-') {
      throw new Error(`node: bad option: ${arg}`);
    }
    parsed.script = arg;
    parsed.args = args.slice(i + 1);
    return parsed;
  }
  return parsed;
}

/** #!/usr/bin/env node is a comment for Node; the wrapper makes it a syntax error. */
function stripShebang(source: string): string {
  return source.startsWith('#!') ? source.replace(/^#![^\n]*\n?/, '') : source;
}

/**
 * Downgrade line-anchored ESM syntax to the CommonJS shims.
 *
 * `evalCode` compiles scripts, so `import`/`export` are syntax errors. Agents
 * write ESM constantly; rewriting the dominant statements is enough to make
 * those scripts run, and anything unusual still fails loudly at the same place.
 */
function downgradeEsm(source: string, scriptUrl: string): string {
  if (!/^[ \t]*(?:import|export)[\s{*]/m.test(source)) return source;

  let code = source;

  // `export default function f() {}` → keep the declaration, drop the keyword.
  code = code.replace(/^([ \t]*)export\s+default\s+(?=(?:async\s+)?(?:function|class)\b)/gm, '$1');
  // `export default <expression>` → a binding nobody imports, but it must stay
  // evaluated in order.
  code = code.replace(
    /^([ \t]*)export\s+default\s+([^\n]+;?)[ \t]*$/gm,
    '$1const __lumo_default_export = $2',
  );
  // `export const x` / `export function f` / `export class C`
  code = code.replace(
    /^([ \t]*)export\s+(?=(?:const|let|var|function|class|async)\b)/gm,
    '$1',
  );
  // `export { a, b as c }` and `export * from './m'` have no consumer here.
  code = code.replace(/^[ \t]*export\s*\{[^}]*\}\s*(?:from\s*['"][^'"]+['"])?;?[ \t]*$/gm, '');
  code = code.replace(/^[ \t]*export\s+\*[^\n]*$/gm, '');

  // `import ... from 'spec'` (may span lines)
  code = code.replace(
    /^([ \t]*)import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\3;?[ \t]*$/gm,
    (match, indent: string, clause: string, _quote: string, spec: string) => {
      const { defaultName, namespaceName, named } = parseImportClause(clause);
      const parts: string[] = [];
      const namespace = `(await __lumo_esm(${JSON.stringify(spec)}))`;
      if (defaultName) parts.push(`const ${defaultName} = ${namespace}.default;`);
      if (namespaceName) parts.push(`const ${namespaceName} = ${namespace};`);
      if (named) parts.push(`const ${named} = ${namespace};`);
      if (parts.length === 0) parts.push(`await __lumo_esm(${JSON.stringify(spec)});`);
      return parts.map((part) => indent + part).join('\n');
    },
  );
  // bare `import 'spec'`
  code = code.replace(
    /^([ \t]*)import\s+(['"])([^'"]+)\2;?[ \t]*$/gm,
    (_match, indent: string, _quote: string, spec: string) =>
      `${indent}await __lumo_esm(${JSON.stringify(spec)});`,
  );

  const url = JSON.stringify(scriptUrl);
  const dirUrl = JSON.stringify(scriptUrl.replace(/\/[^/]*$/, '/'));
  code = code.replace(/\bimport\.meta\.url\b/g, url);
  code = code.replace(/\bimport\.meta\.dirname\b/g, dirUrl);
  code = code.replace(/\bimport\.meta\.filename\b/g, url);
  return code;
}

function parseImportClause(clause: string): {
  defaultName?: string;
  namespaceName?: string;
  named?: string;
} {
  let rest = clause.trim();
  let defaultName: string | undefined;
  let namespaceName: string | undefined;
  let named: string | undefined;

  const commaAt = rest.indexOf(',');
  if (!rest.startsWith('{') && !rest.startsWith('*')) {
    const head = commaAt === -1 ? rest : rest.slice(0, commaAt);
    defaultName = head.trim();
    rest = commaAt === -1 ? '' : rest.slice(commaAt + 1).trim();
  }
  if (rest.startsWith('*')) {
    namespaceName = rest.replace(/^\*\s*(?:as\s+)?/, '').trim();
  } else if (rest.startsWith('{')) {
    const inner = rest.replace(/^\{/, '').replace(/\}\s*$/, '').trim();
    named = inner.length > 0 ? `{ ${inner} }` : undefined;
  }
  return {
    ...(defaultName ? { defaultName } : {}),
    ...(namespaceName ? { namespaceName } : {}),
    ...(named ? { named } : {}),
  };
}

async function readSource(ctx: ResolvedCommandContext, parsed: NodeArgs): Promise<string> {
  if (parsed.code !== undefined) return parsed.code;
  if (parsed.script && parsed.script !== '-') {
    const absolute = ctx.fs.resolvePath(ctx.cwd, parsed.script);
    return ctx.fs.readFile(absolute);
  }
  return decodeStdin(ctx.stdin);
}

interface HostPayload {
  [key: string]: unknown;
}

interface HostOptions {
  conversationId?: string;
  /** Nesting level of this node invocation (0 for the shell tool). */
  depth: number;
  deadline: number;
  timeoutMs: number;
  cleanup: Array<() => void>;
  gateway: ToolGateway;
  maxNestingDepth: number;
  /**
   * Images produced by `tools.*` calls in this invocation.
   *
   * The shell tool shares this array with `mcp call`, so a screenshot from
   * either surface reaches the model. The guest still only receives a path:
   * base64 must not cross the bridge.
   */
  attachments: ShellAttachment[];
  /**
   * In-flight calls owned by *this* VM.
   *
   * Previously module-level maps keyed by a guest-chosen id, which let one
   * script abort another script's `fetch`/`exec` and made parallel runs share a
   * namespace they never agreed on. Scoping them to the invocation is the fix.
   */
  execControllers: Map<string, AbortController>;
  fetchControllers: Map<string, AbortController>;
}

/** Resolve a guest path against the guest's cwd (which `process.chdir` may move). */
function resolvePath(ctx: ResolvedCommandContext, payload: HostPayload, key = 'path'): string {
  const base = typeof payload.cwd === 'string' ? payload.cwd : ctx.cwd;
  return ctx.fs.resolvePath(base, String(payload[key] ?? ''));
}

function decodeData(payload: HostPayload): string | Uint8Array {
  const data = String(payload.data ?? '');
  if (payload.encoding === 'base64') return bytesOfBase64(data);
  if (payload.encoding === 'hex') {
    const clean = data.replace(/[^0-9a-fA-F]/g, '');
    const bytes = new Uint8Array(Math.floor(clean.length / 2));
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  if (payload.encoding === 'latin1' || payload.encoding === 'binary') {
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 1) bytes[i] = data.charCodeAt(i) & 0xff;
    return bytes;
  }
  return data;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') out[key] = item;
  }
  return out;
}

/** Abort-aware sleep used by both `sleep()` and the guest timers. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // Browsers clamp delays above 2^31-1 to 1 ms; keep the sentinel constructible.
    const timer = setTimeout(resolve, Math.min(ms, MAX_TIMER_DELAY_MS));
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function handleHostCall(
  kind: string,
  payload: HostPayload,
  ctx: ResolvedCommandContext,
  options: HostOptions,
): Promise<unknown> {
  if (kind === 'tool') {
    const server = String(payload.server ?? '');
    const toolName = String(payload.tool ?? '');
    const result = await options.gateway.invoke(server, toolName, payload.params ?? {}, {
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      signal: ctx.signal,
    });
    // The guest only needs a path: `file_read` (or the next turn) can show the
    // image, and a base64 body would cross the bridge twice. The bytes are
    // still attached to the shell result, because a model that called
    // `tools.<server>.<tool>()` should see the image the same way a `mcp call`
    // does.
    const materialized = await materializeToolImages(ctx.fs, result.content, { attach: true });
    options.attachments.push(...materialized.attachments);
    return { ...result, content: materialized.content } satisfies NormalizedToolResult;
  }

  if (kind === 'mcp.describe') {
    const serverQuery = String(payload.server ?? '');
    const toolName = String(payload.tool ?? '');
    const server = options.gateway.resolveServer(serverQuery);
    return options.gateway.resolveTool(server.id, toolName);
  }

  if (kind === 'fs.read') {
    return ctx.fs.readFile(
      resolvePath(ctx, payload),
      payload.encoding as 'utf8' | 'base64' | 'hex' | 'binary' | 'latin1' | 'ascii' | undefined,
    );
  }
  if (kind === 'fs.write' || kind === 'fs.append') {
    const path = resolvePath(ctx, payload);
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    await ctx.fs.mkdir(parent, { recursive: true }).catch(() => undefined);
    const data = decodeData(payload);
    if (kind === 'fs.append') await ctx.fs.appendFile(path, data);
    else await ctx.fs.writeFile(path, data);
    return { ok: true };
  }
  if (kind === 'fs.readdir') {
    const path = resolvePath(ctx, payload);
    if (payload.withFileTypes && typeof ctx.fs.readdirWithFileTypes === 'function') {
      return (await ctx.fs.readdirWithFileTypes(path)).map((entry) => ({
        name: entry.name,
        isFile: entry.isFile,
        isDirectory: entry.isDirectory,
        isSymbolicLink: entry.isSymbolicLink,
      }));
    }
    return ctx.fs.readdir(path);
  }
  if (kind === 'fs.stat') {
    const stat = await ctx.fs.stat(resolvePath(ctx, payload));
    return {
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
      isSymbolicLink: stat.isSymbolicLink,
      size: stat.size,
      mode: stat.mode,
      mtime: stat.mtime.getTime(),
    };
  }
  if (kind === 'fs.exists') {
    return ctx.fs.exists(resolvePath(ctx, payload));
  }
  if (kind === 'fs.mkdir') {
    await ctx.fs.mkdir(resolvePath(ctx, payload), {
      recursive: payload.recursive !== false,
    });
    return resolvePath(ctx, payload);
  }
  if (kind === 'fs.rm') {
    await ctx.fs.rm(resolvePath(ctx, payload), {
      recursive: payload.recursive === true,
      force: payload.force === true,
    });
    return { ok: true };
  }
  if (kind === 'fs.rename') {
    await ctx.fs.mv(resolvePath(ctx, payload, 'from'), resolvePath(ctx, payload, 'to'));
    return { ok: true };
  }
  if (kind === 'fs.copy') {
    await ctx.fs.cp(resolvePath(ctx, payload, 'from'), resolvePath(ctx, payload, 'to'));
    return { ok: true };
  }
  if (kind === 'fs.chmod') {
    await ctx.fs.chmod(resolvePath(ctx, payload), Number(payload.mode ?? 0));
    return { ok: true };
  }
  if (kind === 'fs.utimes') {
    const mtime = new Date(Number(payload.mtime ?? Date.now()));
    await ctx.fs.utimes(resolvePath(ctx, payload), mtime, mtime);
    return { ok: true };
  }
  if (kind === 'fs.realpath') {
    return ctx.fs.realpath(resolvePath(ctx, payload));
  }

  if (kind === 'fetch') {
    const url = String(payload.url ?? '');
    if (!url) throw new Error('fetch: URL is required');
    const abortId = typeof payload.abortId === 'string' ? payload.abortId : '';
    const controller = abortId ? new AbortController() : undefined;
    if (controller && abortId) {
      options.fetchControllers.set(abortId, controller);
      options.cleanup.push(() => {
        options.fetchControllers.delete(abortId);
      });
    }

    const init: RequestInit = {};
    if (payload.method !== undefined) init.method = String(payload.method);
    if (payload.headers !== undefined) init.headers = payload.headers as HeadersInit;
    if (payload.body !== undefined) {
      init.body = (payload.bodyEncoding === 'base64'
        ? bytesOfBase64(String(payload.body))
        : String(payload.body)) as BodyInit;
    }
    if (payload.redirect !== undefined) init.redirect = payload.redirect as RequestRedirect;
    if (payload.credentials !== undefined) init.credentials = payload.credentials as RequestCredentials;
    if (payload.cache !== undefined) init.cache = payload.cache as RequestCache;
    if (payload.mode !== undefined) init.mode = payload.mode as RequestMode;
    if (payload.keepalive !== undefined) init.keepalive = payload.keepalive === true;

    const timeoutMs = Number(payload.timeoutMs);
    const timeoutSignal =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? AbortSignal.timeout(Math.min(timeoutMs, MAX_TIMER_DELAY_MS))
        : undefined;
    const signal = combineSignals([ctx.signal, controller?.signal, timeoutSignal]);
    if (signal) init.signal = signal;

    try {
      const response = await globalThis.fetch(url, init);
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const truncated = bytes.length > MAX_FETCH_BYTES;
      const body = bytes.slice(0, MAX_FETCH_BYTES);
      // `forEach` merges duplicate headers, which destroys Set-Cookie. Keep the
      // pairs so the guest can append them individually.
      const headerPairs: Array<[string, string]> = [];
      const cookies =
        typeof (response.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
          ? (response.headers as { getSetCookie: () => string[] }).getSetCookie()
          : [];
      response.headers.forEach((value, key) => {
        if (cookies.length > 0 && key.toLowerCase() === 'set-cookie') return;
        headerPairs.push([key, value]);
      });
      for (const cookie of cookies) headerPairs.push(['set-cookie', cookie]);

      const meta = {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        url: response.url || url,
        redirected: response.redirected,
        type: response.type,
        headers: headerPairs,
        size: bytes.length,
        truncated,
      };
      if (body.length > MAX_INLINE_FETCH_BYTES) {
        // Hand back a path: the guest reads it with `await response.text()`
        // (or the shell reads it with grep/jq) and the bridge stays small.
        const path = `/${TMP_DIR}/fetch-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}.bin`;
        await ctx.fs.mkdir(`/${TMP_DIR}`, { recursive: true }).catch(() => undefined);
        await ctx.fs.writeFile(path, body);
        return { ...meta, bodyPath: path };
      }
      return {
        ...meta,
        text: new TextDecoder('utf-8', { fatal: false }).decode(body),
        base64: base64Of(body),
      };
    } finally {
      if (abortId) options.fetchControllers.delete(abortId);
    }
  }

  if (kind === 'fetch.abort') {
    options.fetchControllers.get(String(payload.id ?? ''))?.abort();
    options.fetchControllers.delete(String(payload.id ?? ''));
    return { ok: true };
  }

  if (kind === 'sleep' || kind === 'timer.wait') {
    const requested = Number(payload.ms ?? 0);
    const ms = Math.max(
      0,
      Math.min(
        Number.isFinite(requested) ? requested : 0,
        kind === 'timer.wait' ? options.timeoutMs : options.deadline - Date.now(),
        MAX_TIMER_DELAY_MS,
      ),
    );
    await wait(ms, ctx.signal);
    return { ok: true };
  }

  if (kind === 'crypto.randomUUID') {
    return globalThis.crypto.randomUUID();
  }
  if (kind === 'crypto.randomBytes') {
    const length = Math.max(0, Math.min(Number(payload.length ?? 16), 65_536));
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return base64Of(bytes);
  }

  if (kind === 'exec') {
    if (typeof ctx.exec !== 'function') {
      throw new Error('exec is not available in this shell context');
    }
    const command = String(payload.command ?? '');
    if (command.trim() === '') throw new Error('exec: command is required');
    const depth = options.depth + 1;
    if (depth > options.maxNestingDepth) {
      throw new Error(`exec: maximum node nesting depth (${options.maxNestingDepth}) reached`);
    }

    const id = String(payload.id ?? `exec-${Date.now()}`);
    const remaining = Math.max(1, options.deadline - Date.now());
    const requested = Number(payload.timeoutMs ?? 0);
    const timeoutMs = Math.max(
      1,
      Math.min(remaining, Number.isFinite(requested) && requested > 0 ? requested : remaining),
    );
    const controller = new AbortController();
    options.execControllers.set(id, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.min(timeoutMs, MAX_TIMER_DELAY_MS));
    const signal = combineSignals([ctx.signal, controller.signal]);

    try {
      const result = await ctx.exec(command, {
        cwd: typeof payload.cwd === 'string' ? ctx.fs.resolvePath(ctx.cwd, payload.cwd) : ctx.cwd,
        env: {
          ...stringRecord(payload.env),
          // Display only: the real depth is the per-shell counter in
          // `createNodeCommand`, which the guest cannot influence.
          LUMO_NODE_DEPTH: String(depth),
        },
        ...(payload.stdin !== undefined ? { stdin: String(payload.stdin) } : {}),
        ...(signal ? { signal } : {}),
      });
      const stderr = timedOut
        ? `${result.stderr}${result.stderr === '' || result.stderr.endsWith('\n') ? '' : '\n'}exec: timed out after ${timeoutMs}ms\n`
        : result.stderr;
      return {
        stdout: result.stdout,
        stderr,
        exitCode: timedOut ? 124 : result.exitCode,
      };
    } catch (error) {
      if (timedOut) {
        return {
          stdout: '',
          stderr: `exec: timed out after ${timeoutMs}ms\n`,
          exitCode: 124,
        };
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options.execControllers.delete(id);
    }
  }

  if (kind === 'exec.kill') {
    options.execControllers.get(String(payload.id ?? ''))?.abort();
    return { ok: true };
  }

  throw new Error(`Unknown host call: ${kind}`);
}

/** Synchronous host calls (QuickJS can call these without a promise). */
function handleSyncCall(kind: string, payload: HostPayload): unknown {
  if (kind === 'crypto.randomUUID') return globalThis.crypto.randomUUID();
  if (kind === 'crypto.randomBytes') {
    const length = Math.max(0, Math.min(Number(payload.length ?? 16), 65_536));
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return base64Of(bytes);
  }
  if (kind === 'crypto.randomInt') {
    const min = Math.trunc(Number(payload.min ?? 0));
    const max = Math.trunc(Number(payload.max ?? Number.MAX_SAFE_INTEGER));
    if (!(max > min)) throw new RangeError('randomInt: max must be greater than min');
    const span = max - min;
    if (span <= 0x1_0000_0000) {
      const limit = Math.floor(0x1_0000_0000 / span) * span;
      const view = new Uint32Array(1);
      let value = 0;
      do {
        globalThis.crypto.getRandomValues(view);
        value = view[0]!;
      } while (value >= limit);
      return min + (value % span);
    }
    const bytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(bytes);
    let value = 0;
    for (const byte of bytes) value = value * 256 + byte;
    return min + Math.floor((value / 2 ** 64) * span);
  }
  if (kind === 'zlib.gzip') {
    const bytes = bytesOfBase64(String(payload.data ?? ''));
    return base64Of(fflateGzipSync(bytes, { level: Number(payload.level ?? 6) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }));
  }
  if (kind === 'zlib.gunzip') {
    const bytes = bytesOfBase64(String(payload.data ?? ''));
    return base64Of(fflateGunzipSync(bytes));
  }
  if (kind === 'intl.format') {
    const type = String(payload.type ?? 'date');
    const locales = payload.locale === undefined ? undefined : String(payload.locale);
    const options = (payload.options ?? {}) as Record<string, unknown>;
    const value = payload.value;
    switch (type) {
      case 'date':
        return new Intl.DateTimeFormat(locales, options as Intl.DateTimeFormatOptions).format(
          new Date(Number(value)),
        );
      case 'number':
        return new Intl.NumberFormat(locales, options as Intl.NumberFormatOptions).format(
          Number(value),
        );
      case 'collator':
        return new Intl.Collator(locales, options as Intl.CollatorOptions).compare(
          String(value),
          String(payload.other ?? ''),
        );
      case 'list':
        return new Intl.ListFormat(locales, options as Intl.ListFormatOptions).format(
          (Array.isArray(value) ? value : []).map(String),
        );
      case 'plural':
        return new Intl.PluralRules(locales, options as Intl.PluralRulesOptions).select(Number(value));
      case 'relative':
        return new Intl.RelativeTimeFormat(
          locales,
          options as Intl.RelativeTimeFormatOptions,
        ).format(Number(value), String(payload.unit ?? 'second') as Intl.RelativeTimeFormatUnit);
      default:
        throw new Error(`intl.format: unknown formatter ${type}`);
    }
  }
  if (kind === 'intl.resolved') {
    const type = String(payload.type ?? 'date');
    const locales = payload.locale === undefined ? undefined : String(payload.locale);
    const options = (payload.options ?? {}) as Record<string, unknown>;
    const formatter =
      type === 'number'
        ? new Intl.NumberFormat(locales, options as Intl.NumberFormatOptions)
        : type === 'collator'
          ? new Intl.Collator(locales, options as Intl.CollatorOptions)
          : new Intl.DateTimeFormat(locales, options as Intl.DateTimeFormatOptions);
    return formatter.resolvedOptions();
  }
  if (kind === 'zlib.deflate') {
    return base64Of(zlibSync(bytesOfBase64(String(payload.data ?? '')), { level: Number(payload.level ?? 6) as 6 }));
  }
  if (kind === 'zlib.inflate') {
    return base64Of(unzlibSync(bytesOfBase64(String(payload.data ?? ''))));
  }
  if (kind === 'encoding.decode') {
    const label = String(payload.encoding ?? 'utf-8');
    const bytes = bytesOfBase64(String(payload.data ?? ''));
    return new TextDecoder(label, {
      fatal: payload.fatal === true,
      ignoreBOM: payload.ignoreBOM === true,
    }).decode(bytes);
  }
  if (kind === 'os.info') {
    const nav = globalThis.navigator as
      | { hardwareConcurrency?: number; deviceMemory?: number; userAgent?: string }
      | undefined;
    const cpus = Math.max(1, Math.trunc(nav?.hardwareConcurrency ?? 4));
    const totalmem = Math.max(1, Number(nav?.deviceMemory ?? 8)) * 1024 ** 3;
    return {
      cpus,
      totalmem,
      freemem: Math.round(totalmem * 0.5),
      hostname: 'lumo',
      homedir: '/',
      tmpdir: '/tmp',
      username: 'lumo',
      platform: 'linux',
      arch: 'x64',
    };
  }
  throw new Error(`Unknown sync call: ${kind}`);
}

interface PreludeModule {
  path: string;
  source: string;
}

interface PreludeConfig {
  env: Record<string, string>;
  cwd: string;
  scriptDir: string;
  scriptPath: string;
  argv: string[];
  timeoutMs: number;
  version: string;
  servers: Array<{ id: string; name: string; tools: string[] }>;
  modules: PreludeModule[];
}

/**
 * The guest runtime is a real `.js` file imported as text: writing it as a TS
 * template literal made every backtick and `${` an escape hazard, and this code
 * is plain JavaScript by design.
 */
function buildPrelude(config: PreludeConfig): string {
  return `globalThis.__lumo_config = ${JSON.stringify(config)};\n${guestRuntimeSource}\n`;
}

function describeError(dump: unknown): string {
  if (typeof dump === 'string') return dump;
  if (dump && typeof dump === 'object') {
    const record = dump as { stack?: unknown; message?: unknown; name?: unknown };
    const name = typeof record.name === 'string' ? record.name : 'Error';
    const message = typeof record.message === 'string' ? record.message : '';
    const head = message ? `${name}: ${message}` : name;
    if (typeof record.stack === 'string') {
      return record.stack.startsWith(head) ? record.stack : `${head}\n${record.stack}`;
    }
    return head;
  }
  try {
    return JSON.stringify(dump);
  } catch {
    return String(dump);
  }
}

const BUILTIN_MODULES = new Set([
  'path',
  'path/posix',
  'path/win32',
  'os',
  'util',
  'events',
  'fs',
  'fs/promises',
  'crypto',
  'buffer',
  'child_process',
  'url',
  'timers',
  'timers/promises',
  'process',
  'console',
  'assert',
  'assert/strict',
  'zlib',
  'stream',
  'querystring',
  'string_decoder',
  'perf_hooks',
  'constants',
  'readline',
  'readline/promises',
  'module',
]);

function isBuiltinModule(spec: string): boolean {
  return BUILTIN_MODULES.has(spec.startsWith('node:') ? spec.slice(5) : spec);
}

const MODULE_EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.json', '/index.js', '/index.json'];

/**
 * Collect every `require('./x')` / `import x from './x'` target from the VFS.
 *
 * `require` must be synchronous inside the VM and the VFS is IndexedDB-backed,
 * so the modules are read here (async, in the host) and handed to the guest as
 * a path→source map. Bare specifiers that are not builtins cannot resolve at
 * all: there is no `node_modules` in the browser.
 */
async function prepareModules(
  ctx: ResolvedCommandContext,
  entrySource: string,
  scriptDir: string,
): Promise<PreludeModule[]> {
  const modules: PreludeModule[] = [];
  const seen = new Set<string>();

  const specsOf = (source: string): string[] => {
    const specs = new Set<string>();
    for (const match of source.matchAll(/require\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) {
      specs.add(match[1]!);
    }
    for (const match of source.matchAll(/^[ \t]*(?:import|export)[^\n]*?from\s*['"]([^'"\n]+)['"]/gm)) {
      specs.add(match[1]!);
    }
    for (const match of source.matchAll(/^[ \t]*import\s*['"]([^'"\n]+)['"]/gm)) {
      specs.add(match[1]!);
    }
    return [...specs];
  };

  const resolveSpec = async (spec: string, fromDir: string): Promise<string | undefined> => {
    if (!spec.startsWith('.') && !spec.startsWith('/')) return undefined;
    for (const extension of MODULE_EXTENSIONS) {
      const candidate = ctx.fs.resolvePath(fromDir, `${spec}${extension}`);
      try {
        if (await ctx.fs.exists(candidate)) {
          const stat = await ctx.fs.stat(candidate);
          if (stat.isFile) return candidate;
        }
      } catch {
        // Missing candidate: try the next extension.
      }
    }
    return undefined;
  };

  let frontier: Array<{ spec: string; fromDir: string }> = specsOf(entrySource).map((spec) => ({
    spec,
    fromDir: scriptDir,
  }));

  // No depth or byte budget: a relative module graph is finite (cycles are cut
  // by `seen`), and refusing a module the user's script explicitly required is
  // worse than letting the wasm heap be the limit.
  while (frontier.length > 0) {
    const next: Array<{ spec: string; fromDir: string }> = [];
    for (const { spec, fromDir } of frontier) {
      if (isBuiltinModule(spec)) continue;
      const path = await resolveSpec(spec, fromDir);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      let source: string;
      try {
        source = await ctx.fs.readFile(path);
      } catch {
        continue;
      }
      modules.push({ path, source });
      if (!path.endsWith('.json')) {
        const dir = path.slice(0, path.lastIndexOf('/')) || '/';
        for (const nested of specsOf(source)) next.push({ spec: nested, fromDir: dir });
      }
    }
    frontier = next;
  }

  return modules;
}

type EvalResult = { ok: true; value: QuickJSHandle } | { ok: false; error: QuickJSHandle };

/**
 * Build a guest Error with the host error's metadata attached.
 *
 * `newError(message)` alone loses `code`, so `catch (e) { if (e.code === ...) }`
 * silently takes the wrong branch.
 */
function errorHandle(context: QuickJSContext, error: unknown): QuickJSHandle {
  const record = (error ?? {}) as Record<string, unknown>;
  const message =
    typeof record.message === 'string' && record.message.length > 0
      ? record.message
      : String(error);
  const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : 'Error';
  const handle = context.newError(message);
  const attach = (key: string, value: string | number) => {
    try {
      context.newString(String(value)).consume((prop) => context.setProp(handle, key, prop));
    } catch {
      // Read-only property: the message still carries the information.
    }
  };
  attach('name', name);
  // just-bash's own commands often prefix the message instead of setting a
  // property; recovering the code keeps `err.code` branching working.
  if (record.code === undefined) {
    const prefix = /^([A-Z][A-Z0-9]+):/.exec(message);
    if (prefix) attach('code', prefix[1]!);
  }
  for (const key of ['code', 'errno', 'syscall', 'path', 'dest', 'key', 'signal', 'expose']) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') attach(key, value);
  }
  if (typeof record.stack === 'string') attach('stack', record.stack);
  return handle;
}

function buildScript(
  prelude: string,
  source: string,
  options: { print: boolean; expression: boolean },
): string {
  const body = options.expression ? `return (${source}\n);` : source;
  return `
${prelude}
(async () => {
  let __lumo_exit = 0;
  try {
    const __lumo_result = await (async () => {
${body}
    })();
    ${options.print ? 'if (__lumo_result !== undefined) console.log(__lumo_result);' : ''}
    await __lumo_wait_timers();
    // Host calls resolve asynchronously and may have queued user .then
    // callbacks; one 0ms turn lets the VM drain them before output is read.
    await new Promise((resolve) => setTimeout(resolve, 0));
    __lumo_collect_unhandled();
    if (__lumo_unhandled.length > 0) {
      __lumo_exit = 1;
      for (const error of __lumo_unhandled) {
        __lumo_err('Uncaught ' + __lumo_error_text(error));
      }
    }
    if (__lumo_timer_errors.length > 0) {
      __lumo_exit = 1;
      for (const error of __lumo_timer_errors) {
        __lumo_err('Uncaught ' + __lumo_error_text(error));
      }
    }
  } catch (error) {
    // process.exit() in the guest runtime marks the thrown error with the
    // requested code. Parsing the message instead let any error text that
    // contained the marker change the exit status.
    if (error && typeof error.__lumo_process_exit === 'number') {
      __lumo_exit = error.__lumo_process_exit;
    } else {
      __lumo_err(__lumo_error_text(error));
      __lumo_exit = 1;
    }
  }
  __lumo_collect_unhandled();
  if (__lumo_exit === 0 && __lumo_unhandled.length > 0) {
    __lumo_exit = 1;
    for (const error of __lumo_unhandled) {
      __lumo_err('Uncaught ' + __lumo_error_text(error));
    }
  }
  try { __lumo_run_exit_hooks(); } catch (error) { __lumo_err(__lumo_error_text(error)); }
  if (__lumo_exit === 0 && Number(process.exitCode)) {
    __lumo_exit = Number(process.exitCode);
  }
  return JSON.stringify({
    code: __lumo_exit,
    output: __lumo_console_out.join('\\n'),
    error: __lumo_console_err.join('\\n'),
  });
})()
`;
}

interface GuestResult {
  code: number;
  output: string;
  error: string;
}

/**
 * Read the guest's accumulated output without running user code again.
 *
 * Used on every failure path (timeout, unsettled promise) so a script that dies
 * half way still reports what it printed.
 */
function collectGuestResult(context: QuickJSContext): GuestResult | undefined {
  let handle: QuickJSHandle | undefined;
  try {
    const result = context.evalCode(
      `JSON.stringify({
        code: Number(process.exitCode) || (__lumo_timer_errors.length + __lumo_unhandled.length > 0 ? 1 : 0),
        output: __lumo_console_out.join('\\n'),
        error: __lumo_console_err.join('\\n'),
      })`,
      'node-collect.js',
    );
    if (result.error) {
      result.error.dispose();
      return undefined;
    }
    handle = result.value;
    const raw = context.getString(handle);
    return JSON.parse(raw) as GuestResult;
  } catch {
    return undefined;
  } finally {
    try {
      handle?.dispose();
    } catch {
      // The context may already be gone.
    }
  }
}

function toExecResult(result: GuestResult | undefined, fallbackError: string): ExecResult {
  const output = result?.output ?? '';
  const errorOutput = result?.error ?? '';
  const code = result?.code ?? 1;
  const stderr = errorOutput.length > 0 ? errorOutput : fallbackError;
  return {
    stdout: output.length > 0 ? `${output}\n` : '',
    stderr: stderr.length > 0 ? `${stderr.replace(/\n?$/, '\n')}` : '',
    exitCode: Number.isFinite(code) ? code : 1,
  };
}

export function createNodeCommand(
  options: {
    conversationId?: string;
    gateway?: ToolGateway;
    /**
     * Shared with the `mcp` command: images produced by `tools.*` calls are
     * appended here so the shell tool can return them as model-visible parts.
     */
    attachments?: ShellAttachment[];
    /** Tests pin a small budget; production leaves it unbounded. */
    maxNestingDepth?: number;
  } = {},
) {
  const shellAttachments = options.attachments ?? [];
  /**
   * Nesting level of the `node` commands running in *this* shell.
   *
   * The interpreter is one per `Bash`, so a closure counter is exactly the
   * nesting depth: a nested `exec('node ...')` re-enters this command while the
   * outer call is still on the stack. It used to be a module global, which made
   * two unrelated scripts consume each other's budget.
   */
  let activeDepth = 0;

  return defineCommand('node', async (args, ctx): Promise<ExecResult> => {
    const version = extensionVersion();
    let parsed: NodeArgs;
    try {
      parsed = parseArgs(args);
    } catch (error) {
      return {
        stdout: '',
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 9,
      };
    }

    if (parsed.version) {
      return { stdout: `v0.0.0-lumo\n`, stderr: '', exitCode: 0 };
    }
    if (parsed.help) {
      return {
        stdout: [
          'Usage: node [options] [script.js] [arguments]',
          '',
          'Options:',
          '  -e, --eval <script>   evaluate a script',
          '  -p, --print <script>  evaluate and print the result',
          '  --check               syntax check without executing',
          '  -v, --version         print the runtime version',
          '  -                   read the script from stdin',
          '',
          'Subset of Node on QuickJS/WASM: timers, Buffer, crypto hashes, zlib,',
          'fetch, fs (async API), child_process.exec, require() of builtins and',
          'VFS modules, and top-level import/export.',
        ].join('\n') + '\n',
        stderr: '',
        exitCode: 0,
      };
    }

    let source: string;
    try {
      source = stripShebang(await readSource(ctx, parsed));
    } catch (error) {
      return {
        stdout: '',
        stderr: `node: cannot read script: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }

    if (source.length === 0) {
      return { stdout: '', stderr: 'node: empty script\n', exitCode: 2 };
    }

    const env = Object.fromEntries(ctx.env);
    const cwd = ctx.cwd;
    const scriptPath = parsed.script && parsed.script !== '-' ? parsed.script : undefined;
    const scriptDir = scriptPath
      ? ctx.fs.resolvePath(cwd, scriptPath).replace(/\/[^/]*$/, '') || '/'
      : cwd;
    const argv = ['node', ...(parsed.script ? [parsed.script] : []), ...parsed.args];
    // In a shell, `node` inherits the script's remaining budget; standalone it
    // has no practical limit. The cap is a timer-safety ceiling, not a policy.
    const remaining = ctx.executionScope?.remainingTimeMs?.() ?? NO_TIMEOUT_MS;
    const timeoutMs = Math.max(1_000, Math.min(remaining, MAX_TIMER_DELAY_MS));
    const deadline = Date.now() + timeoutMs;
    const maxNestingDepth = options.maxNestingDepth ?? Number.MAX_SAFE_INTEGER;
    const depth = activeDepth;
    activeDepth += 1;
    const gateway = options.gateway ?? createToolGateway();
    const servers = gateway.listServers().map((server) => ({
      id: server.id,
      name: server.name,
      tools: gateway.listTools(server.id).map((tool) => tool.name),
    }));

    let modules: PreludeModule[] = [];
    try {
      modules = await prepareModules(ctx, source, scriptDir);
    } catch {
      modules = [];
    }

    const scriptUrl = `file://${scriptPath ? ctx.fs.resolvePath(cwd, scriptPath) : `/${'node-script.js'}`}`;
    const transformed = downgradeEsm(source, scriptUrl);
    const prelude = buildPrelude({
      env,
      cwd,
      scriptDir,
      scriptPath: scriptUrl.slice('file://'.length),
      argv,
      timeoutMs,
      version,
      servers,
      modules,
    });

    let context: QuickJSContext | undefined;
    let runtime: ReturnType<QuickJSWASMModule['newRuntime']> | undefined;
    let host: QuickJSHandle | undefined;
    let syncHost: QuickJSHandle | undefined;
    const deferreds = new Set<QuickJSDeferredPromise>();
    const cleanupHandlers: Array<() => void> = [];
    const execControllers = new Map<string, AbortController>();
    const fetchControllers = new Map<string, AbortController>();
    let disposed = false;
    let inFlight = 0;
    let wake: (() => void) | undefined;
    const notify = () => {
      const resolve = wake;
      wake = undefined;
      resolve?.();
    };

    try {
      const module = await getQuickJSModule();
      const afterDeadline = shouldInterruptAfterDeadline(deadline);
      runtime = module.newRuntime({
        // No memoryLimitBytes: QuickJS/wasm then grows until the browser heap
        // is exhausted. Setting a fixed ceiling here only made large scripts
        // fail inside the sandbox instead of using the memory that is available.
        maxStackSizeBytes: MAX_STACK_SIZE_BYTES,
        // The deadline is effectively unbounded now, so cancellation is the
        // other way out: the turn's abort signal is checked by the interpreter.
        interruptHandler: (runtime) => afterDeadline(runtime) || ctx.signal?.aborted === true,
      });
      context = runtime.newContext();

      host = context.newFunction('__lumo_host', (kindHandle, payloadHandle) => {
        const kind = context!.getString(kindHandle);
        const raw = context!.getString(payloadHandle);
        const deferred = context!.newPromise();
        deferreds.add(deferred);
        inFlight += 1;
        void (async () => {
          try {
            const payload = raw.length > 0 ? (JSON.parse(raw) as HostPayload) : {};
            const value = await handleHostCall(kind, payload, ctx, {
              ...(options.conversationId ? { conversationId: options.conversationId } : {}),
              depth,
              deadline,
              timeoutMs,
              cleanup: cleanupHandlers,
              gateway,
              maxNestingDepth,
              attachments: shellAttachments,
              execControllers,
              fetchControllers,
            });
            if (disposed || !context) return;
            // `resolve`/`reject` consume the pointer but not the handle: without
            // `consume` every bridge response leaks a string into the VM.
            context.newString(JSON.stringify(value ?? null)).consume((handle) => deferred.resolve(handle));
          } catch (error) {
            if (disposed || !context) return;
            errorHandle(context, error).consume((handle) => deferred.reject(handle));
          } finally {
            inFlight -= 1;
            // The guest may be waiting on this promise; run its continuations and
            // wake the pump. The handle is released here rather than at teardown:
            // a settled promise still owns three VM handles, and a script can
            // issue thousands of bridge calls.
            void deferred.settled
              .then(() => {
                // Release the three VM handles the promise owns *before* any
                // early return: teardown iterates `deferreds`, so a promise
                // removed here but not disposed would leak an object into
                // `JS_FreeRuntime` (which then aborts on its assert).
                deferreds.delete(deferred);
                try {
                  if (deferred.alive) deferred.dispose();
                } catch {
                  // The runtime may already be torn down.
                }
                if (disposed || !runtime) return;
                try {
                  runtime.executePendingJobs();
                } catch {
                  // An earlier guest error already surfaced; the pump will see it.
                }
                notify();
              })
              .catch(() => {
                notify();
              });
          }
        })();
        return deferred.handle;
      });
      context.setProp(context.global, '__lumo_host', host);

      syncHost = context.newFunction('__lumo_sync', (kindHandle, payloadHandle) => {
        const kind = context!.getString(kindHandle);
        const raw = context!.getString(payloadHandle);
        try {
          const payload = raw.length > 0 ? (JSON.parse(raw) as HostPayload) : {};
          return context!.newString(JSON.stringify(handleSyncCall(kind, payload)));
        } catch (error) {
          const record = (error ?? {}) as Record<string, unknown>;
          return context!.newString(
            JSON.stringify({
              __lumo_error: error instanceof Error ? error.message : String(error),
              name: typeof record.name === 'string' ? record.name : 'Error',
              code: typeof record.code === 'string' ? record.code : undefined,
            }),
          );
        }
      });
      context.setProp(context.global, '__lumo_sync', syncHost);

      // `-p` takes an expression (`node -p '1 + 1'`). Compile-check the
      // expression form first; a statement list falls back to the block form.
      let expression = parsed.print;
      if (expression) {
        const probe = `${prelude}\n(async () => {\n  return (${transformed}\n);\n})()`;
        try {
          const compiled = context.evalCode(probe, 'node-probe.js', { compileOnly: true });
          if (compiled.error) {
            compiled.error.dispose();
            expression = false;
          } else {
            compiled.value.dispose();
          }
        } catch {
          expression = false;
        }
      }

      const script = buildScript(prelude, transformed, {
        print: parsed.print,
        expression,
      });

      // `--check` must not run the script. Compiling the same wrapper catches
      // syntax errors without starting the async IIFE — evaluating it first
      // meant a "syntax check" wrote files and could block on `while (true) {}`.
      if (parsed.check) {
        const compiled = context.evalCode(script, 'node-script.js', { compileOnly: true });
        if (compiled.error) {
          const message = describeError(context.dump(compiled.error));
          compiled.error.dispose();
          return { stdout: '', stderr: `node: ${message}\n`, exitCode: 1 };
        }
        compiled.value.dispose();
        return { stdout: '', stderr: '', exitCode: 0 };
      }

      const evaluated: EvalResult = (() => {
        try {
          const result = context!.evalCode(script, 'node-script.js');
          return result.error
            ? { ok: false, error: result.error }
            : { ok: true, value: result.value };
        } catch (error) {
          return { ok: false, error: context!.newError(String(error)) };
        }
      })();

      if (!evaluated.ok) {
        const message = describeError(context.dump(evaluated.error));
        evaluated.error.dispose();
        return {
          stdout: '',
          stderr: `node: ${message}\n`,
          exitCode: 1,
        };
      }

      const promise = evaluated.value;

      let state = context.getPromiseState(promise);
      let steps = 0;
      while (state.type === 'pending' && steps < 200_000) {
        if (ctx.signal?.aborted) {
          promise.dispose();
          return toExecResult(collectGuestResult(context), 'node: script aborted\n');
        }
        if (Date.now() > deadline) {
          promise.dispose();
          return toExecResult(collectGuestResult(context), 'node: script exceeded its deadline\n');
        }
        steps += 1;
        const drained = runtime.executePendingJobs();
        if (drained.error) {
          const message = describeError(context.dump(drained.error));
          drained.error.dispose();
          promise.dispose();
          return toExecResult(collectGuestResult(context), `node: ${message}\n`);
        }
        state = context.getPromiseState(promise);
        if (state.type === 'pending') {
          // Waking here rather than polling keeps sequential `await`s cheap:
          // a bridge call that settles immediately resolves this promise in the
          // same microtask turn. The timeout is only a safety net.
          const next = new Promise<void>((resolve) => {
            wake = resolve;
          });
          let guardTimer: ReturnType<typeof setTimeout> | undefined;
          const guard = new Promise<void>((resolve) => {
            guardTimer = setTimeout(resolve, inFlight > 0 ? 250 : 5);
          });
          await Promise.race([next, guard]);
          if (guardTimer !== undefined) clearTimeout(guardTimer);
        }
      }
      promise.dispose();

      if (state.type === 'pending') {
        return toExecResult(collectGuestResult(context), 'node: script did not settle\n');
      }
      if (state.type === 'rejected') {
        const message = describeError(context.dump(state.error));
        state.error.dispose();
        return toExecResult(collectGuestResult(context), `node: ${message}\n`);
      }

      const raw = context.getString(state.value);
      state.value.dispose();
      return toExecResult(JSON.parse(raw) as GuestResult, '');
    } catch (error) {
      return {
        stdout: '',
        stderr: `node: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    } finally {
      disposed = true;
      activeDepth -= 1;
      for (const cleanup of cleanupHandlers) {
        try {
          cleanup();
        } catch {
          // Cleanup must never turn a successful script into a failed command.
        }
      }
      // Reject every bridge promise still in flight before dropping the
      // context: an undisposed promise handle keeps the whole VM object graph
      // alive and makes QuickJS assert on `JS_FreeRuntime`.
      for (const deferred of deferreds) {
        try {
          if (deferred.alive) {
            if (context?.alive) {
              errorHandle(context, new Error('node: script exited')).consume((handle) =>
                deferred.reject(handle),
              );
            }
            deferred.dispose();
          }
        } catch {
          // Ignore: the runtime may already be interrupted.
        }
      }
      deferreds.clear();
      try { syncHost?.dispose(); } catch { /* ignore */ }
      try { host?.dispose(); } catch { /* ignore */ }
      try { context?.dispose(); } catch { /* ignore */ }
      try {
        runtime?.dispose();
      } catch {
        // The runtime may already be interrupted.
      }
    }
  });
}
