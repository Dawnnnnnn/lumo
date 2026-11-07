/**
 * `tar`, `zip` and `unzip` for the browser shell.
 *
 * just-bash's node bundle has `tar`, but the browser build excludes it, and
 * there is no `zip` at all. Archives are one of the most common things an agent
 * needs to read or produce (`npm pack` output, exported site bundles, log
 * dumps), and `fflate` already ships with the extension, so these commands are
 * rebuilt here on top of the VFS.
 *
 * Binary payloads travel as `stdoutKind: 'bytes'` latin1 strings, which is the
 * shell's byte-shaped pipe contract.
 */

import { defineCommand, type ExecResult, type ResolvedCommandContext } from 'just-bash/browser';
import {
  gzipSync as fflateGzipSync,
  gunzipSync as fflateGunzipSync,
  unzipSync as fflateUnzipSync,
  zipSync as fflateZipSync,
} from 'fflate';
import { bytesFromLatin1, latin1FromBytes } from '@/lib/encoding';

/**
 * Reject archive entries that do not name a path strictly inside the target.
 *
 * An archive is untrusted input (it can arrive through `curl` from anywhere).
 * `resolvePath` clamps `..` at the filesystem root, so a traversal cannot escape
 * the VFS — but it *can* escape the `-d` directory and overwrite any user file,
 * which is exactly the "zip slip" failure. Absolute paths and drive letters are
 * rejected for the same reason.
 */
function safeEntryName(name: string): string | null {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) return null;
  return segments.filter((segment) => segment !== '' && segment !== '.').join('/');
}

async function readBinary(ctx: ResolvedCommandContext, path: string): Promise<Uint8Array> {
  if (typeof ctx.fs.readFileBuffer === 'function') return ctx.fs.readFileBuffer(path);
  return bytesFromLatin1(await ctx.fs.readFile(path, 'latin1'));
}

interface TypedEntry {
  name: string;
  isDirectory: boolean;
}

/** `readdirWithFileTypes` is optional on IFileSystem; fall back to stat calls. */
async function readdirTyped(
  ctx: ResolvedCommandContext,
  path: string,
): Promise<TypedEntry[]> {
  if (typeof ctx.fs.readdirWithFileTypes === 'function') {
    const entries = await ctx.fs.readdirWithFileTypes(path);
    return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory }));
  }
  const names = await ctx.fs.readdir(path);
  const out: TypedEntry[] = [];
  for (const name of names) {
    const stat = await ctx.fs.stat(ctx.fs.resolvePath(path, name));
    out.push({ name, isDirectory: stat.isDirectory });
  }
  return out;
}

async function writeBinary(
  ctx: ResolvedCommandContext,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf('/')) || '/';
  await ctx.fs.mkdir(parent, { recursive: true }).catch(() => undefined);
  await ctx.fs.writeFile(path, bytes);
}

function bytesResult(bytes: Uint8Array): ExecResult {
  return { stdout: latin1FromBytes(bytes), stderr: '', exitCode: 0, stdoutKind: 'bytes' };
}

function fail(message: string, code = 1): ExecResult {
  return { stdout: '', stderr: `${message}\n`, exitCode: code };
}

/* -------------------------------------------------------------------------- */
/* zip / unzip                                                                */
/* -------------------------------------------------------------------------- */

async function collectPaths(
  ctx: ResolvedCommandContext,
  target: string,
  recursive: boolean,
  prefix: string,
  out: Array<{ archivePath: string; absolute: string }>,
): Promise<void> {
  const absolute = ctx.fs.resolvePath(ctx.cwd, target);
  if (await ctx.fs.exists(absolute)) {
    const stat = await ctx.fs.stat(absolute);
    if (stat.isDirectory) {
      if (!recursive) {
        throw new Error('zip: is a directory (use -r)');
      }
      const base = prefix || target.replace(/\/+$/, '');
      const entries = await readdirTyped(ctx, absolute);
      for (const entry of entries) {
        await collectPaths(
          ctx,
          ctx.fs.resolvePath(absolute, entry.name),
          recursive,
          `${base}/${entry.name}`,
          out,
        );
      }
      return;
    }
    out.push({ archivePath: prefix || target, absolute });
    return;
  }
  // Glob-less convenience: allow a literal path that vanished to fail loudly.
  throw new Error(`zip: cannot stat '${target}'`);
}

const zip = defineCommand('zip', async (args, ctx): Promise<ExecResult> => {
  const recursive = args.includes('-r') || args.includes('-R');
  const rest = args.filter((arg) => !arg.startsWith('-'));
  if (rest.length < 2) return fail('usage: zip [-r] archive.zip file...', 2);
  const [archive, ...targets] = rest as [string, ...string[]];
  const files: Record<string, Uint8Array> = {};
  try {
    for (const target of targets) {
      const collected: Array<{ archivePath: string; absolute: string }> = [];
      await collectPaths(ctx, target, recursive, '', collected);
      for (const item of collected) {
        files[item.archivePath.replace(/^\/+/, '')] = await readBinary(ctx, item.absolute);
      }
    }
  } catch (error) {
    return fail(`zip: ${error instanceof Error ? error.message : String(error)}`);
  }
  const bytes = fflateZipSync(files, { level: 6 });
  if (archive === '-') return bytesResult(bytes);
  const absolute = ctx.fs.resolvePath(ctx.cwd, archive);
  await writeBinary(ctx, absolute, bytes);
  return { stdout: `  adding: ${Object.keys(files).length} file(s)\n`, stderr: '', exitCode: 0 };
});

function zipEntries(bytes: Uint8Array): Record<string, Uint8Array> {
  return fflateUnzipSync(bytes);
}

const unzip = defineCommand('unzip', async (args, ctx): Promise<ExecResult> => {
  let list = false;
  let print = false;
  let outputDir: string | undefined;
  // Non-interactive unzip skips an existing file unless `-o` is given. Silently
  // replacing one — which this command used to do, because `overwrite` was
  // parsed and then discarded — is indistinguishable from a correct extraction
  // until the user notices their file changed.
  let overwrite = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '-l') list = true;
    else if (arg === '-p') print = true;
    else if (arg === '-o') overwrite = true;
    else if (arg === '-n') overwrite = false;
    else if (arg === '-d') outputDir = args[++i];
    else if (arg.startsWith('-d') && arg.length > 2) outputDir = arg.slice(2);
    else if (arg.startsWith('-')) return fail(`unzip: invalid option -- '${arg.slice(1)}'`, 2);
    else rest.push(arg);
  }
  if (rest.length === 0) return fail('usage: unzip [-l|-p] [-d dir] [-o|-n] archive.zip [file...]', 2);
  const [archive, ...filters] = rest as [string, ...string[]];
  let bytes: Uint8Array;
  try {
    bytes = await readBinary(ctx, ctx.fs.resolvePath(ctx.cwd, archive));
  } catch {
    return fail(`unzip: cannot find or open ${archive}`, 9);
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = zipEntries(bytes);
  } catch (error) {
    return fail(`unzip: ${error instanceof Error ? error.message : String(error)}`, 9);
  }
  const names = Object.keys(entries).filter(
    (name) => filters.length === 0 || filters.some((filter) => name === filter || name.startsWith(`${filter.replace(/\/+$/, '')}/`)),
  );
  if (list) {
    const lines = ['  Length      Date    Time    Name', '---------  ---------- -----   ----'];
    let total = 0;
    for (const name of names) {
      const size = entries[name]!.length;
      total += size;
      lines.push(`${String(size).padStart(9)}  ---------- -----   ${name}`);
    }
    lines.push('---------                     -------');
    lines.push(`${String(total).padStart(9)}                     ${names.length} file(s)`);
    return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0 };
  }
  if (print) {
    const chunks = names.map((name) => entries[name]!);
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return bytesResult(merged);
  }
  const base = outputDir ? ctx.fs.resolvePath(ctx.cwd, outputDir) : ctx.cwd;
  const written: string[] = [];
  const kept: string[] = [];
  const rejected: string[] = [];
  for (const name of names) {
    const safe = safeEntryName(name);
    if (safe === null) {
      rejected.push(name);
      continue;
    }
    const target = ctx.fs.resolvePath(base, safe);
    if (name.endsWith('/')) {
      await ctx.fs.mkdir(target, { recursive: true });
      continue;
    }
    if (!overwrite && (await ctx.fs.exists(target))) {
      kept.push(safe);
      continue;
    }
    await writeBinary(ctx, target, entries[name]!);
    written.push(safe);
  }
  const header = `Archive:  ${archive}\n`;
  const body = written.map((name) => `  inflating: ${name}`).concat(
    kept.map((name) => `  skipping:  ${name} (exists; use -o to overwrite)`),
    rejected.map((name) => `  unsafe:    ${name} (skipped)`),
  ).join('\n');
  const stderr = rejected.length > 0 ? `${rejected.length} unsafe archive entr(ies) skipped\n` : '';
  return { stdout: `${header}${body}${body ? '\n' : ''}`, stderr, exitCode: 0 };
});

/* -------------------------------------------------------------------------- */
/* tar (ustar)                                                                */
/* -------------------------------------------------------------------------- */

const TAR_BLOCK = 512;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function writeTarHeader(path: string, size: number, mode: number, mtime: number, isDirectory: boolean): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK);
  let name = path.replace(/^\/+/, '');
  let prefix = '';
  if (name.length > 100) {
    // ustar splits long names into prefix (155) + name (100).
    const cut = name.length - 100;
    prefix = name.slice(0, cut);
    name = name.slice(cut);
    if (prefix.length > 155) throw new Error(`tar: path too long: ${path}`);
  }
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) header[offset + i] = text.charCodeAt(i) & 0xff;
  };
  write(0, name);
  write(100, octal(mode & 0o7777, 8));
  write(108, octal(0, 8));
  write(116, octal(0, 8));
  write(124, octal(isDirectory ? 0 : size, 12));
  write(136, octal(Math.floor(mtime / 1000), 12));
  header[156] = (isDirectory ? '5' : '0').charCodeAt(0);
  write(257, 'ustar\0');
  write(263, '00');
  write(265, 'lumo');
  write(297, 'lumo');
  write(345, prefix);
  // Checksum: computed with the checksum field filled with spaces.
  for (let i = 148; i < 156; i += 1) header[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i += 1) sum += header[i]!;
  write(148, sum.toString(8).padStart(6, '0') + '\0 ');
  return header;
}

function padToBlock(size: number): number {
  const remainder = size % TAR_BLOCK;
  return remainder === 0 ? 0 : TAR_BLOCK - remainder;
}

async function addTarEntry(
  ctx: ResolvedCommandContext,
  absolute: string,
  archivePath: string,
  chunks: Uint8Array[],
): Promise<void> {
  const stat = await ctx.fs.stat(absolute);
  if (stat.isDirectory) {
    chunks.push(writeTarHeader(`${archivePath.replace(/\/+$/, '')}/`, 0, stat.mode, stat.mtime.getTime(), true));
    const entries = await readdirTyped(ctx, absolute);
    for (const entry of entries) {
      await addTarEntry(
        ctx,
        ctx.fs.resolvePath(absolute, entry.name),
        `${archivePath.replace(/\/+$/, '')}/${entry.name}`,
        chunks,
      );
    }
    return;
  }
  const bytes = await readBinary(ctx, absolute);
  chunks.push(writeTarHeader(archivePath.replace(/^\/+/, ''), bytes.length, stat.mode, stat.mtime.getTime(), false));
  chunks.push(bytes);
  const padding = padToBlock(bytes.length);
  if (padding > 0) chunks.push(new Uint8Array(padding));
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  let text = '';
  for (let i = 0; i < length; i += 1) {
    const code = block[offset + i]!;
    if (code === 0 || code === 0x20) {
      if (text.length > 0) break;
      continue;
    }
    text += String.fromCharCode(code);
  }
  return text.length === 0 ? 0 : parseInt(text, 8);
}

function readString(block: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const code = block[offset + i]!;
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

interface TarEntry {
  name: string;
  type: string;
  data: Uint8Array;
  mode: number;
  mtime: number;
}

function parseTar(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  while (offset + TAR_BLOCK <= bytes.length) {
    const block = bytes.subarray(offset, offset + TAR_BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const name = readString(block, 0, 100);
    const prefix = readString(block, 345, 155);
    const size = readOctal(block, 124, 12);
    const mode = readOctal(block, 100, 8) || 0o644;
    const mtime = readOctal(block, 136, 12) * 1000;
    const type = String.fromCharCode(block[156]!);
    const dataStart = offset + TAR_BLOCK;
    const data = bytes.subarray(dataStart, dataStart + size);
    offset = dataStart + size + padToBlock(size);
    if (type === 'L') {
      // GNU long name: the payload is the name for the next entry.
      longName = readString(data, 0, data.length);
      continue;
    }
    if (type === 'x' || type === 'g') continue; // pax headers
    const fullName = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = undefined;
    if (type === '0' || type === '\0' || type === '7' || type === '5') {
      entries.push({ name: fullName, type, data, mode, mtime });
    }
  }
  return entries;
}

const tar = defineCommand('tar', async (args, ctx): Promise<ExecResult> => {
  let mode: 'create' | 'extract' | 'list' = 'create';
  let archive: string | undefined;
  let gzip: 'auto' | 'on' | 'off' = 'auto';
  /** `-k`: keep files that already exist instead of replacing them. */
  let keepExisting = false;
  const paths: string[] = [];

  const setFlag = (flag: string) => {
    if (flag === 'c') mode = 'create';
    else if (flag === 'x') mode = 'extract';
    else if (flag === 't') mode = 'list';
    else if (flag === 'z') gzip = 'on';
    else if (flag === 'k') keepExisting = true;
    else if (flag === 'f') return 'f' as const;
    else if (flag === 'v' || flag === 'p' || flag === 'h') return undefined;
    else throw new Error(`tar: unknown option ${flag}`);
    return undefined;
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '-') {
      paths.push(arg);
      continue;
    }
    if (arg.startsWith('--')) {
      if (arg === '--gzip' || arg === '--gunzip') gzip = 'on';
      else if (arg === '--no-gzip') gzip = 'off';
      else if (arg === '--create') mode = 'create';
      else if (arg === '--extract' || arg === '--get') mode = 'extract';
      else if (arg === '--list') mode = 'list';
      else return fail(`tar: unrecognized option '${arg}'`, 2);
      continue;
    }
    if (arg.startsWith('-') || arg.startsWith('+')) {
      const flags = arg.replace(/^[-+]/, '');
      for (let j = 0; j < flags.length; j += 1) {
        if (setFlag(flags[j]!) === 'f') {
          if (j + 1 < flags.length) {
            archive = flags.slice(j + 1);
            j = flags.length;
          } else {
            archive = args[++i];
          }
        }
      }
      continue;
    }
    // Long-option style: -c... already handled; remaining args are paths.
    paths.push(arg);
  }

  if (!archive) archive = paths.shift();
  if (!archive) return fail('tar: no archive specified (use -f archive.tar)', 2);

  try {
    if (mode === 'create') {
      if (paths.length === 0) return fail('tar: no files or directories specified', 2);
      const chunks: Uint8Array[] = [];
      for (const path of paths) {
        const absolute = ctx.fs.resolvePath(ctx.cwd, path);
        if (!(await ctx.fs.exists(absolute))) return fail(`tar: ${path}: Cannot stat: No such file or directory`, 2);
        await addTarEntry(ctx, absolute, path.replace(/^\/+/, ''), chunks);
      }
      chunks.push(new Uint8Array(TAR_BLOCK * 2));
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const blob = new Uint8Array(total);
      let cursor = 0;
      for (const chunk of chunks) {
        blob.set(chunk, cursor);
        cursor += chunk.length;
      }
      const useGzip = gzip === 'on' || (gzip === 'auto' && /\.(tar\.gz|tgz)$/.test(archive));
      const out = useGzip ? fflateGzipSync(blob) : blob;
      if (archive === '-') return bytesResult(out);
      await writeBinary(ctx, ctx.fs.resolvePath(ctx.cwd, archive), out);
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    const raw = await readBinary(ctx, ctx.fs.resolvePath(ctx.cwd, archive));
    const isGzip = gzip === 'on' || (gzip === 'auto' && raw[0] === 0x1f && raw[1] === 0x8b);
    const bytes = isGzip ? fflateGunzipSync(raw) : raw;
    const entries = parseTar(bytes);
    if (mode === 'list') {
      const lines = entries.map((entry) => {
        const kind = entry.type === '5' ? 'd' : '-';
        return `${kind}rw-r--r-- 0/0 ${String(entry.data.length).padStart(8)} ${entry.name}`;
      });
      return { stdout: `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`, stderr: '', exitCode: 0 };
    }
    const filters = paths;
    const written: string[] = [];
    const rejected: string[] = [];
    for (const entry of entries) {
      if (filters.length > 0 && !filters.some((filter) => entry.name === filter || entry.name.startsWith(`${filter.replace(/\/+$/, '')}/`))) {
        continue;
      }
      const safe = safeEntryName(entry.name);
      if (safe === null) {
        rejected.push(entry.name);
        continue;
      }
      const target = ctx.fs.resolvePath(ctx.cwd, safe);
      if (entry.type === '5') {
        await ctx.fs.mkdir(target, { recursive: true });
        continue;
      }
      if (keepExisting && (await ctx.fs.exists(target))) continue;
      await writeBinary(ctx, target, entry.data);
      if (entry.mode) await ctx.fs.chmod(target, entry.mode).catch(() => undefined);
      if (entry.mtime) await ctx.fs.utimes(target, new Date(entry.mtime), new Date(entry.mtime)).catch(() => undefined);
      written.push(safe);
    }
    return {
      stdout: '',
      stderr: rejected.length > 0 ? `${rejected.length} unsafe archive entr(ies) skipped\n` : '',
      exitCode: 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`tar: ${message}`, 2);
  }
});

export function createArchiveCommands() {
  return [tar, zip, unzip];
}
