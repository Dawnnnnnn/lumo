/**
 * IndexedDB-backed filesystem for the shell.
 *
 * `just-bash` exposes an asynchronous `IFileSystem`, which maps cleanly onto the
 * extension's `fileStorage`, with two exceptions:
 *
 *  - `getAllPaths()` and `resolvePath()` are synchronous. IndexedDB is not, so
 *    the adapter keeps a path index in memory and revalidates it against the
 *    `files:changed` bus before every async operation (a `file_write`, another
 *    shell, or the file manager may have changed the store since the last call).
 *  - `symlink`, `link` and `readlink` have no equivalent in the flat storage
 *    model. They report `ENOSYS` rather than pretending to succeed.
 *  - Modes and mtimes are POSIX-shaped metadata with no storage column: they
 *    live for one execution, which is enough for `tar`/`unzip` to round-trip
 *    within a script but not a durable permission system.
 *
 * The VFS root `/` is the storage root. `/notes.md` and the `file_*` tool path
 * `notes.md` therefore name the same file, which is what makes shell pipelines
 * and the file tools interchangeable.
 */

import type {
  BufferEncoding,
  CpOptions,
  CreateExclusiveOptions,
  FileContent,
  FileSystemFactory,
  FsStat,
  IFileSystem,
  InitialFiles,
  MkdirOptions,
  RmOptions,
} from 'just-bash/browser';
import type { ByteString } from 'just-bash';

/** Local shapes for the two interfaces the browser entry does not re-export. */
interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}
interface WriteFileOptions {
  encoding?: BufferEncoding;
}
interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}
import {
  fileStorage,
  inferMimeType,
  type DirectoryRecord,
  type FileMetadata,
} from '@/lib/mcp/file-storage';
import { onEvent } from '@/lib/event-bus-core';
import {
  bytesFromAscii,
  bytesFromBase64,
  bytesFromHex,
  bytesFromLatin1,
  bytesFromText,
  latin1FromBytes,
  textFromBytes,
} from '@/lib/encoding';

const ROOT = '/';

/**
 * Monotonic counter of storage changes observed by this context.
 *
 * The VFS index is synchronous but IndexedDB is not, so a write made by another
 * tool (`file_write`, the options page, another shell) has to invalidate the
 * index. `files:changed` is already the single announcement every writer makes;
 * this counter turns it into an O(1) staleness check instead of a per-instance
 * subscription per path.
 */
let storeRevision = 0;
let watchingStore = false;

function watchStore(): void {
  if (watchingStore) return;
  watchingStore = true;
  onEvent('files:changed', () => {
    storeRevision += 1;
  });
}

const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

/** Normalize an absolute or relative VFS path, clamping at `/`. */
export function normalizeVfsPath(path: string): string {
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const joined = out.join('/');
  return absolute ? `/${joined}` : joined;
}

/** Resolve `path` against `base`, POSIX-style. */
export function resolveVfsPath(base: string, path: string): string {
  if (path.startsWith('/')) return normalizeVfsPath(path);
  return normalizeVfsPath(`${base}/${path}`);
}

function toStorePath(path: string): string {
  const normalized = normalizeVfsPath(path).replace(/\/+$/, '');
  return normalized === '' || normalized === ROOT ? '' : normalized.replace(/^\/+/, '');
}

function toVfsPath(storePath: string): string {
  return storePath === '' ? ROOT : `/${storePath}`;
}

/**
 * POSIX device paths the shell may redirect to.
 *
 * They are virtual: nothing is stored. Without this, `cmd 2>/dev/null` (and
 * `>/dev/null`, which just-bash resolves through `fs.writeFile`) created a real
 * zero-byte `dev/null` in the file library. Its last segment rendered as a file
 * named "null" in the conversation's file bar, even though the script had only
 * read files.
 */
type DeviceKind = 'dir' | 'null' | 'zero';

function deviceKind(path: string): DeviceKind | undefined {
  const normalized = normalizeVfsPath(path);
  if (normalized === '/dev') return 'dir';
  if (normalized === '/dev/null') return 'null';
  if (normalized === '/dev/zero') return 'zero';
  return undefined;
}

/** Device stat: no size, and a stable identity so `-ef` comparisons work. */
function deviceStat(kind: Exclude<DeviceKind, 'dir'>): FsStat {
  return {
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    mode: 0o666,
    size: 0,
    mtime: new Date(0),
    identity: `dev:${kind}`,
  };
}

function decodeBytes(bytes: Uint8Array, encoding?: BufferEncoding | null): string {
  return textFromBytes(bytes, encoding);
}

/**
 * The write-side counterpart of {@link decodeBytes}.
 *
 * just-bash hands string payloads to `writeFile`/`appendFile` in two different
 * shapes and says which one via the encoding argument: `"utf8"` for text (an
 * `echo` argument) and `"binary"` for a pipe payload, which is a latin1 byte
 * string — one char per byte. Encoding both with `TextEncoder` silently
 * double-encodes the byte string (`需要` -> `é\u009c\u0080` in the file) and
 * destroys binary payloads, because every byte >= 0x80 becomes two bytes.
 */
function encodeBytes(content: FileContent, encoding?: BufferEncoding | null): Uint8Array {
  if (typeof content !== 'string') return content;
  switch (encoding) {
    case 'binary':
    case 'latin1':
      return bytesFromLatin1(content);
    case 'base64':
      return bytesFromBase64(content);
    case 'hex':
      return bytesFromHex(content);
    case 'ascii':
      return bytesFromAscii(content);
    default:
      return bytesFromText(content);
  }
}

/** Text written as a string keeps the store's text-content sniffing. */
function isTextEncoding(encoding?: BufferEncoding | null): boolean {
  return encoding === undefined || encoding === null || encoding === 'utf8' || encoding === 'utf-8';
}

function writeEncoding(options?: WriteFileOptions | BufferEncoding): BufferEncoding | undefined {
  return typeof options === 'string' ? options : options?.encoding;
}

function byteString(bytes: Uint8Array): ByteString {
  return latin1FromBytes(bytes) as unknown as ByteString;
}

/**
 * Build a POSIX-flavoured error with the metadata Node's `fs` attaches.
 *
 * The code has to live on the object, not just in the message: guest scripts
 * branch on `err.code === 'ENOENT'`, and a message-only code silently takes the
 * wrong branch.
 */
function fsError(
  code: string,
  message: string,
  details: { path?: string; dest?: string; syscall?: string } = {},
): Error {
  const error = new Error(message) as Error & {
    code?: string;
    errno?: number;
    syscall?: string;
    path?: string;
    dest?: string;
  };
  error.code = code;
  error.errno = -errnoFor(code);
  if (details.syscall) error.syscall = details.syscall;
  if (details.path !== undefined) error.path = details.path;
  if (details.dest !== undefined) error.dest = details.dest;
  return error;
}

function errnoFor(code: string): number {
  switch (code) {
    case 'ENOENT':
      return 2;
    case 'EIO':
      return 5;
    case 'EBADF':
      return 9;
    case 'EACCES':
      return 13;
    case 'EBUSY':
      return 16;
    case 'EEXIST':
      return 17;
    case 'ENOTDIR':
      return 20;
    case 'EISDIR':
      return 21;
    case 'EINVAL':
      return 22;
    case 'ENOSPC':
      return 28;
    case 'ENOTEMPTY':
      return 39;
    default:
      return 1;
  }
}

function enoent(path: string, syscall = 'open'): Error {
  return fsError('ENOENT', `ENOENT: no such file or directory, ${syscall} '${path}'`, { path, syscall });
}

function enotdir(path: string): Error {
  return fsError('ENOTDIR', `ENOTDIR: not a directory, scandir '${path}'`, { path, syscall: 'scandir' });
}

function eisdir(path: string): Error {
  return fsError('EISDIR', `EISDIR: illegal operation on a directory, read '${path}'`, {
    path,
    syscall: 'read',
  });
}

function enosys(name: string): Error {
  return fsError('ENOSYS', `ENOSYS: ${name} is not supported by the extension filesystem`);
}

function eexist(path: string): Error {
  return fsError('EEXIST', `EEXIST: file already exists, mkdir '${path}'`, { path, syscall: 'mkdir' });
}

function enotempty(path: string): Error {
  return fsError('ENOTEMPTY', `ENOTEMPTY: directory not empty, rmdir '${path}'`, {
    path,
    syscall: 'rmdir',
  });
}

export interface LumoFileSystemOptions {
  /** Files written by the shell are associated with this conversation. */
  conversationId?: string;
}

export class LumoFileSystem implements IFileSystem {
  private readonly conversationId?: string;
  /** Store path (no leading slash) -> metadata. */
  private files = new Map<string, FileMetadata>();
  /** Store paths of directories, without a trailing slash. `''` is the root. */
  private dirs = new Set<string>(['']);
  /** Absolute VFS paths, for the synchronous glob index. */
  private allPaths = new Set<string>([ROOT]);
  /** Directory mtimes from the `dirs` store, so `stat` is deterministic. */
  private dirTimes = new Map<string, number>();
  private modes = new Map<string, number>();
  private mtimes = new Map<string, Date>();
  /** `storeRevision` captured by the last refresh or own write. */
  private revision = -1;
  /** Sorted absolute paths for glob expansion; rebuilt after any index change. */
  private sortedPaths: string[] | null = null;

  constructor(options: LumoFileSystemOptions = {}) {
    this.conversationId = options.conversationId;
    watchStore();
  }

  /**
   * Rebuild the synchronous index from IndexedDB.
   *
   * Called before a shell execution and again whenever another writer is
   * detected. Writes update the index in place, so a script sees its own effects
   * immediately without another round trip.
   */
  async refresh(): Promise<void> {
    const startedAt = storeRevision;
    const [files, directories] = await Promise.all([
      fileStorage.listFiles(),
      fileStorage.listDirectories(),
    ]);

    this.files = new Map(files.map((file) => [file.name, file]));
    this.dirs = new Set(['']);
    this.allPaths = new Set([ROOT]);
    this.sortedPaths = null;
    this.dirTimes = new Map();

    for (const record of directories) {
      const path = record.path.replace(/\/+$/, '');
      this.addDir(path);
      this.dirTimes.set(path, record.updatedAt);
    }
    for (const file of files) {
      this.files.set(file.name, file);
      this.addFile(file.name);
      this.ensureAncestors(file.name);
    }

    // Drop metadata for paths that are gone: `mv` refreshes mid-script, and a
    // mode remembered for a path another script deleted is just a leak.
    for (const path of this.modes.keys()) {
      if (!this.files.has(path) && !this.dirs.has(path)) this.modes.delete(path);
    }
    for (const path of this.mtimes.keys()) {
      if (!this.files.has(path) && !this.dirs.has(path)) this.mtimes.delete(path);
    }
    // A change that landed while the listing was in flight makes this snapshot
    // incomplete; leave the revision mismatched so the next call lists again.
    this.revision = startedAt === storeRevision ? storeRevision : -1;
  }

  /**
   * Refresh the index when another writer changed the store.
   *
   * Called at the start of every async filesystem operation. Reading a file
   * already goes to IndexedDB for its bytes; this is about existence, listing
   * and metadata, which are served from the index.
   */
  private async syncIfStale(): Promise<void> {
    if (this.revision !== storeRevision) await this.refresh();
  }

  /** Mark this instance's own write as seen, so it does not trigger a refresh. */
  private acceptOwnWrite(): void {
    this.revision = storeRevision;
  }

  private addDir(storePath: string): void {
    this.sortedPaths = null;
    let current = storePath;
    while (current !== '') {
      this.dirs.add(current);
      this.allPaths.add(toVfsPath(current));
      const slash = current.lastIndexOf('/');
      current = slash === -1 ? '' : current.slice(0, slash);
    }
    this.allPaths.add(ROOT);
  }

  private addFile(storePath: string): void {
    this.allPaths.add(toVfsPath(storePath));
    this.sortedPaths = null;
  }

  private ensureAncestors(storePath: string): void {
    const slash = storePath.lastIndexOf('/');
    if (slash === -1) return;
    this.addDir(storePath.slice(0, slash));
  }

  private dropPath(storePath: string): void {
    this.sortedPaths = null;
    this.files.delete(storePath);
    this.dirs.delete(storePath);
    this.allPaths.delete(toVfsPath(storePath));
    this.dirTimes.delete(storePath);
  }

  private isDirectory(storePath: string): boolean {
    return storePath === '' || this.dirs.has(storePath);
  }

  private isFile(storePath: string): boolean {
    return this.files.has(storePath);
  }

  private requireFile(storePath: string, displayPath: string): FileMetadata {
    const meta = this.files.get(storePath);
    if (!meta) {
      if (this.isDirectory(storePath)) throw eisdir(displayPath);
      throw enoent(displayPath);
    }
    return meta;
  }

  private requireDirectory(storePath: string, displayPath: string): void {
    if (!this.isDirectory(storePath)) {
      if (this.isFile(storePath)) throw enotdir(displayPath);
      throw enoent(displayPath);
    }
  }

  private statOf(storePath: string, displayPath: string): FsStat {
    const file = this.files.get(storePath);
    if (file) {
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: this.modes.get(storePath) ?? FILE_MODE,
        size: file.size,
        mtime: this.mtimes.get(storePath) ?? new Date(file.updatedAt),
        // The store has no inodes and no hard links, so a path *is* the
        // identity. just-bash's safety checks (mv/cp same-file, find cycles)
        // fall back to "unknown" without this and then refuse the operation.
        identity: `file:${storePath}`,
      };
    }
    if (this.isDirectory(storePath)) {
      // Directory mtimes come from the `dirs` store. Deriving `new Date()` per
      // call made `ls -l`, `find -newer` and tar output depend on when the
      // script happened to run.
      const mtime = this.mtimes.get(storePath) ?? new Date(this.dirTimes.get(storePath) ?? 0);
      return {
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        mode: this.modes.get(storePath) ?? DIR_MODE,
        size: 0,
        mtime,
        identity: `dir:${storePath}`,
      };
    }
    throw enoent(displayPath);
  }

  private children(storePath: string): Array<{ name: string; isFile: boolean; isDirectory: boolean }> {
    this.requireDirectory(storePath, toVfsPath(storePath));
    const prefix = storePath === '' ? '' : `${storePath}/`;
    const names = new Set<string>();

    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) names.add(rest);
      else names.add(rest.slice(0, slash));
    }
    for (const dir of this.dirs) {
      if (dir === storePath || !dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      if (rest !== '' && !rest.includes('/')) names.add(rest);
    }

    return [...names]
      .sort()
      .map((name) => {
        const child = prefix + name;
        return {
          name,
          isFile: this.files.has(child),
          isDirectory: this.dirs.has(child),
        };
      });
  }

  // -------------------------------------------------------------------------
  // IFileSystem
  // -------------------------------------------------------------------------

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    await this.syncIfStale();
    const device = deviceKind(path);
    if (device === 'dir') throw eisdir(path);
    if (device) return '';
    const storePath = toStorePath(path);
    this.requireFile(storePath, path);
    const blob = await fileStorage.readFileAsBlob(storePath);
    if (!blob) throw enoent(path);
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return decodeBytes(new Uint8Array(await blob.arrayBuffer()), encoding);
  }

  async readFileBytes(path: string): Promise<ByteString> {
    await this.syncIfStale();
    const device = deviceKind(path);
    if (device === 'dir') throw eisdir(path);
    if (device) return '' as unknown as ByteString;
    const storePath = toStorePath(path);
    this.requireFile(storePath, path);
    const blob = await fileStorage.readFileAsBlob(storePath);
    if (!blob) throw enoent(path);
    return byteString(new Uint8Array(await blob.arrayBuffer()));
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    await this.syncIfStale();
    const device = deviceKind(path);
    if (device === 'dir') throw eisdir(path);
    if (device) return new Uint8Array();
    const storePath = toStorePath(path);
    this.requireFile(storePath, path);
    const blob = await fileStorage.readFileAsBlob(storePath);
    if (!blob) throw enoent(path);
    return new Uint8Array(await blob.arrayBuffer());
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    await this.syncIfStale();
    const device = deviceKind(path);
    if (device === 'dir') throw eisdir(path);
    // `/dev/null` and `/dev/zero` discard. This is what keeps
    // `cmd 2>/dev/null` from creating a stored file.
    if (device) return;
    const storePath = toStorePath(path);
    if (this.isDirectory(storePath)) throw eisdir(path);

    // No artificial storage quota: this is the user's file library, and the
    // browser already enforces the origin's IndexedDB quota. A fixed ceiling
    // only made legitimate file and archive work fail.
    const encoding = writeEncoding(options);
    // A UTF-8 string stays a string so the store can still sniff extensionless
    // writes as text; everything else is materialised to exact bytes first.
    const asText = typeof content === 'string' && isTextEncoding(encoding);
    const data: string | Blob = asText
      ? (content as string)
      : new Blob([encodeBytes(content, encoding) as unknown as BlobPart], {
          type: inferMimeType(storePath),
        });
    const meta = await fileStorage.writeFile(storePath, data, {
      ...(this.conversationId ? { conversationId: this.conversationId } : {}),
      ...(asText ? {} : { mimeType: inferMimeType(storePath) }),
    });
    this.files.set(storePath, meta);
    this.addFile(storePath);
    this.ensureAncestors(storePath);
    this.mtimes.set(storePath, new Date(meta.updatedAt));
    this.acceptOwnWrite();
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    await this.syncIfStale();
    const device = deviceKind(path);
    if (device === 'dir') throw eisdir(path);
    if (device) return;
    const previous = this.isFile(toStorePath(path))
      ? await this.readFileBuffer(path)
      : new Uint8Array();
    const addition = encodeBytes(content, writeEncoding(options));
    const merged = new Uint8Array(previous.length + addition.length);
    merged.set(previous);
    merged.set(addition, previous.length);
    await this.writeFile(path, merged, options);
  }

  async exists(path: string): Promise<boolean> {
    await this.syncIfStale();
    if (deviceKind(path)) return true;
    const storePath = toStorePath(path);
    return this.isDirectory(storePath) || this.isFile(storePath);
  }

  async stat(path: string): Promise<FsStat> {
    await this.syncIfStale();
    const device = deviceKind(path);
    if (device === 'dir') {
      return {
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        mode: DIR_MODE,
        size: 0,
        mtime: new Date(0),
        identity: 'dev:dir',
      };
    }
    if (device) return deviceStat(device);
    return this.statOf(toStorePath(path), path);
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await this.syncIfStale();
    const device = deviceKind(path);
    // `/dev` already exists virtually; creating anything below it would put a
    // real directory into the library, so only the device itself is a no-op.
    if (device === 'dir') return;
    if (device) throw eexist(path);
    const storePath = toStorePath(path);
    if (storePath === '') return;
    if (this.isFile(storePath)) throw eexist(path);
    if (this.isDirectory(storePath)) {
      if (options?.recursive) return;
      throw eexist(path);
    }
    if (!options?.recursive && !this.isDirectory(this.parentOf(storePath))) {
      throw enoent(this.parentOf(storePath));
    }
    const record = await fileStorage.createDirectory(storePath);
    this.addDir(storePath);
    this.dirTimes.set(storePath, record.updatedAt);
    this.acceptOwnWrite();
  }

  async createExclusive(path: string, options: CreateExclusiveOptions): Promise<void> {
    await this.syncIfStale();
    const device = deviceKind(path);
    if (device) throw eexist(path);
    const storePath = toStorePath(path);
    if (this.isDirectory(storePath) || this.isFile(storePath)) {
      throw eexist(path);
    }
    if (!this.isDirectory(this.parentOf(storePath))) throw enoent(this.parentOf(storePath));
    if (options.directory) {
      await this.mkdir(path, { recursive: false });
      return;
    }
    this.modes.set(storePath, options.mode);
    await this.writeFile(path, '');
  }

  async readdir(path: string): Promise<string[]> {
    await this.syncIfStale();
    const device = deviceKind(path);
    if (device === 'dir') return ['null', 'zero'];
    if (device) throw enotdir(path);
    return this.children(toStorePath(path)).map((child) => child.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    await this.syncIfStale();
    const device = deviceKind(path);
    if (device === 'dir') {
      return ['null', 'zero'].map((name) => ({
        name,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      }));
    }
    if (device) throw enotdir(path);
    return this.children(toStorePath(path)).map((child) => ({
      name: child.name,
      isFile: child.isFile,
      isDirectory: child.isDirectory,
      isSymbolicLink: false,
    }));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    await this.syncIfStale();
    const device = deviceKind(path);
    // Removing a device would only break the next redirect; report it instead
    // of pretending it succeeded.
    if (device) throw fsError('EPERM', `EPERM: cannot remove device: ${path}`, { path, syscall: 'unlink' });
    const storePath = toStorePath(path);
    if (storePath === '') throw fsError('EBUSY', 'EBUSY: cannot remove the filesystem root');

    if (this.isFile(storePath)) {
      await fileStorage.deleteFile(storePath);
      this.dropPath(storePath);
      this.acceptOwnWrite();
      return;
    }
    if (!this.isDirectory(storePath)) {
      if (options?.force) return;
      throw enoent(path);
    }

    const children = this.children(storePath);
    if (children.length > 0 && !options?.recursive) {
      throw enotempty(path);
    }

    // `deletePath` removes every file and directory record under the prefix in
    // one transaction, so a recursive delete is one storage event, not N.
    await fileStorage.deletePath(storePath);
    this.acceptOwnWrite();
    for (const file of [...this.files.keys()]) {
      if (file === storePath || file.startsWith(`${storePath}/`)) this.files.delete(file);
    }
    for (const dir of [...this.dirs]) {
      if (dir === storePath || dir.startsWith(`${storePath}/`)) this.dirs.delete(dir);
    }
    for (const candidate of [...this.allPaths]) {
      const candidateStore = toStorePath(candidate);
      if (candidateStore === storePath || candidateStore.startsWith(`${storePath}/`)) {
        this.allPaths.delete(candidate);
      }
    }
    this.sortedPaths = null;
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    await this.syncIfStale();
    const srcDevice = deviceKind(src);
    const destDevice = deviceKind(dest);
    if (destDevice === 'dir') throw eisdir(dest);
    if (destDevice) return;
    // `cp /dev/null file` is a common way to truncate/create an empty file.
    if (srcDevice === 'dir') throw eisdir(src);
    if (srcDevice) {
      await this.writeFile(dest, new Uint8Array());
      return;
    }
    const from = toStorePath(src);
    const to = toStorePath(dest);

    if (this.isFile(from)) {
      if (this.isDirectory(to)) throw eisdir(dest);
      const bytes = await this.readFileBuffer(src);
      await this.writeFile(dest, bytes);
      return;
    }

    this.requireDirectory(from, src);
    if (!options?.recursive) throw eisdir(src);
    if (this.isFile(to)) throw eexist(dest);

    await this.mkdir(dest, { recursive: true });
    const prefix = from === '' ? '' : `${from}/`;
    for (const [name] of this.files) {
      if (!name.startsWith(prefix)) continue;
      const relative = name.slice(prefix.length);
      const target = `${to}/${relative}`;
      const parent = this.parentOf(target);
      if (parent !== '') await this.mkdir(parent, { recursive: true });
      await this.writeFile(target, await this.readFileBuffer(`/${name}`));
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.syncIfStale();
    if (deviceKind(src) || deviceKind(dest)) {
      throw fsError('EPERM', `EPERM: cannot move device: ${src}`, { path: src, syscall: 'rename' });
    }
    const from = toStorePath(src);
    const to = toStorePath(dest);
    if (from === to) return;
    if (!this.isFile(from) && !this.isDirectory(from)) throw enoent(src);
    if (this.isDirectory(to)) throw eexist(dest);

    if (this.isFile(from)) {
      const parent = this.parentOf(to);
      if (parent !== '') await this.mkdir(parent, { recursive: true });
      // `mv` replaces an existing file (POSIX, and the in-memory filesystem
      // just-bash ships with). `fileStorage.movePath` refuses to merge, so the
      // overwrite is written first and the source removed only afterwards: a
      // failure leaves a readable copy instead of losing the only one.
      if (this.isFile(to)) {
        await this.writeFile(dest, await this.readFileBuffer(src));
        await fileStorage.deleteFile(from);
        this.dropPath(from);
        this.acceptOwnWrite();
        return;
      }
      await fileStorage.movePath(from, to);
      await this.refresh();
      this.acceptOwnWrite();
      return;
    }

    await fileStorage.movePath(`${from}/`, `${to}/`);
    await this.refresh();
    this.acceptOwnWrite();
  }

  resolvePath(base: string, path: string): string {
    return resolveVfsPath(base, path);
  }

  getAllPaths(): string[] {
    // just-bash calls this for every glob; sorting the whole library per call is
    // the most expensive thing a pattern does.
    if (!this.sortedPaths) this.sortedPaths = [...this.allPaths].sort();
    return this.sortedPaths;
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.syncIfStale();
    if (deviceKind(path)) return;
    const storePath = toStorePath(path);
    if (!this.isFile(storePath) && !this.isDirectory(storePath)) throw enoent(path);
    this.modes.set(storePath, mode);
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    await this.syncIfStale();
    if (deviceKind(path)) return;
    const storePath = toStorePath(path);
    if (!this.isFile(storePath) && !this.isDirectory(storePath)) throw enoent(path);
    this.mtimes.set(storePath, mtime);
  }

  async realpath(path: string): Promise<string> {
    await this.syncIfStale();
    const normalized = normalizeVfsPath(path);
    if (deviceKind(normalized)) return normalized;
    const storePath = toStorePath(normalized);
    if (!this.isFile(storePath) && !this.isDirectory(storePath)) throw enoent(path);
    return normalized;
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw enosys(`symlink ${linkPath}`);
  }

  async link(existingPath: string, _newPath: string): Promise<void> {
    throw enosys(`link ${existingPath}`);
  }

  async readlink(path: string): Promise<string> {
    throw enosys(`readlink ${path}`);
  }

  private parentOf(storePath: string): string {
    const slash = storePath.lastIndexOf('/');
    return slash === -1 ? '' : storePath.slice(0, slash);
  }
}

/** Factory signature required by `Bash`'s `fs` option when a factory is used. */
export function createLumoFileSystemFactory(
  options: LumoFileSystemOptions = {},
): FileSystemFactory {
  return (_initialFiles?: InitialFiles) => new LumoFileSystem(options) as unknown as IFileSystem;
}

/** Named store directories the shell treats as temporary space. */
export const TMP_DIR = 'tmp';
