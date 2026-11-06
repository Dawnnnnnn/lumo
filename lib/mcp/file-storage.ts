/**
 * File Storage Layer - IndexedDB based file storage for FileMCP.
 *
 * ## Paths and directories
 *
 * A file's key *is* its path (`skills/pdf-tools/SKILL.md`), so no id/parentId
 * table sits between the model and the bytes: tool arguments, preview URLs, the
 * conversation attachment list and `@` mentions all name a file the same way.
 * Directories are a semantic layer over that:
 *
 * - the `dirs` store records directories that exist on their own, which is what
 *   lets an empty directory exist at all (and lets a namespace such as `skills/`
 *   be marked as extension-owned);
 * - `listDirectory()` derives every other directory from the paths, so a
 *   directory always contains exactly what its key prefix says it contains, and
 *   deleting its last file removes it rather than leaving an empty husk behind.
 *
 * `meta` duplicates each file's metadata outside the content record. Listing is
 * the most common operation (the options table, the `@` picker, the skills
 * index), and reading it used to mean `getAll()` over a store whose records also
 * carry the blobs.
 *
 * Writes and deletes announce themselves on the event bus, because IndexedDB has
 * no change event of its own and every view of these files (the preview tab, the
 * options file manager, the side panel's conversation file list) would otherwise
 * have to poll to stay correct.
 */
import { emitEvent } from '@/lib/event-bus';

export interface FileMetadata {
  /** File name (unique identifier) */
  name: string;
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** Creation timestamp */
  createdAt: number;
  /** Last modified timestamp */
  updatedAt: number;
  /** Source conversation ID (if created during a chat) */
  conversationId?: string;
}

export interface StoredFile {
  /** File name (primary key) */
  name: string;
  /** File content as Blob */
  content: Blob;
  /** File metadata */
  metadata: FileMetadata;
}

/**
 * Directories owned by the extension rather than by the user.
 *
 * `skills/` holds Agent Skills: the files are instructions for the model, so they
 * are still readable and editable (both by the user and, deliberately, by the
 * model), but they must survive "clear all files" — emptying the file manager
 * is an operation on the user's documents, not on the extension's capabilities.
 */
export const SYSTEM_DIR_PREFIXES: readonly string[] = ['skills/'];

/** Directory namespace a path belongs to. */
export type DirectoryKind = 'user' | 'system';

export interface DirectoryRecord {
  /** Directory path, always with a trailing slash. */
  path: string;
  kind: DirectoryKind;
  /** True when the directory was created on purpose rather than as a parent. */
  explicit: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DirectoryListing {
  /** The listed directory, with a trailing slash (empty string for the root). */
  path: string;
  /** Immediate child directories, each with a trailing slash. */
  directories: string[];
  /** Files directly inside `path`. */
  files: FileMetadata[];
}

/** One file restored from a backup archive. */
export interface RestoreFileEntry {
  name: string;
  content: Blob;
  mimeType: string;
  createdAt: number;
  updatedAt: number;
  conversationId?: string;
}

/** One explicit directory restored from a backup archive. */
export interface RestoreDirectoryEntry {
  path: string;
  explicit: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RestoreFilesResult {
  imported: string[];
  skipped: string[];
}

const DB_NAME = 'lumo-files';
const DB_VERSION = 2;
const STORE_NAME = 'files';
const META_STORE = 'meta';
const DIR_STORE = 'dirs';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalise a file path, or return `null` when it cannot name a file.
 *
 * Backslashes become slashes, duplicate and `.` segments collapse, and leading
 * slashes are dropped, so `//notes/./a.md` and `notes/a.md` are one file rather
 * than two. `..` is rejected instead of resolved: a stored path is an identifier,
 * not a filesystem operation, and silently walking out of a directory would let
 * a malformed tool argument address a different file than the one named.
 */
export function normalizeFilePath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const segments = raw.trim().replace(/\\/g, '/').split('/');
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..' || segment.length > 255) return null;
    parts.push(segment);
  }
  if (parts.length === 0) return null;
  const path = parts.join('/');
  return path.length > 1024 ? null : path;
}

/**
 * Canonicalise a directory path with a trailing slash. The root is `''`.
 * Returns `null` for paths that cannot name a directory.
 */
export function normalizeDirPath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '/' || trimmed === '.') return '';
  const file = normalizeFilePath(trimmed);
  return file === null ? null : `${file}/`;
}

/** Parent directory of a file path, with a trailing slash (`''` at the root). */
export function parentDirPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '' : path.slice(0, index + 1);
}

/** Final segment of a file or directory path. */
export function baseName(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf('/');
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/**
 * A free path derived from `name`, using the `name (1).ext` convention.
 *
 * Kept local to the storage layer (rather than importing `uniqueFileName` from
 * `file-import`) so a backup restore does not depend on the drag-and-drop rules,
 * and so the whole batch can be checked against one in-memory set instead of
 * one IndexedDB round trip per candidate.
 */
function uniqueFilePath(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;

  const lastSlash = name.lastIndexOf('/');
  const dir = lastSlash >= 0 ? name.slice(0, lastSlash + 1) : '';
  const base = name.slice(dir.length);
  const lastDot = base.lastIndexOf('.');
  const stem = lastDot <= 0 ? base : base.slice(0, lastDot);
  const ext = lastDot <= 0 ? '' : base.slice(lastDot);

  for (let n = 1; ; n += 1) {
    const candidate = `${dir}${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Whether a path belongs to an extension-owned area such as `skills/`. */
export function isSystemPath(path: string): boolean {
  return SYSTEM_DIR_PREFIXES.some((prefix) => path.startsWith(prefix) || path === prefix);
}

/** Directory namespace for a normalized path. */
export function directoryKind(path: string): DirectoryKind {
  return isSystemPath(path) ? 'system' : 'user';
}

/** Every ancestor directory of `dir`, outermost first, excluding the root. */
function ancestorDirPaths(dir: string): string[] {
  const result: string[] = [];
  let current = dir;
  while (current !== '') {
    result.unshift(current);
    current = parentDirPath(current.slice(0, -1));
  }
  return result;
}

/**
 * Key range covering every descendant of a directory.
 *
 * `\uffff` is a sentinel above any character a path segment may contain, which
 * makes the bound a prefix scan rather than a scan of the whole store.
 */
function dirRange(dir: string): IDBKeyRange | undefined {
  if (typeof IDBKeyRange === 'undefined') return undefined;
  return IDBKeyRange.bound(dir, `${dir}\uffff`);
}

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * Open (or create) the IndexedDB database for file storage.
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'name' });
        store.createIndex('createdAt', 'metadata.createdAt', { unique: false });
        store.createIndex('conversationId', 'metadata.conversationId', { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        const store = db.createObjectStore(META_STORE, { keyPath: 'name' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('conversationId', 'conversationId', { unique: false });
      }
      if (!db.objectStoreNames.contains(DIR_STORE)) {
        db.createObjectStore(DIR_STORE, { keyPath: 'path' });
      }
      const oldVersion = event.oldVersion ?? 0;
      if (oldVersion > 0 && oldVersion < 2) {
        backfillMetadata(request.transaction);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      // Another context (a preview tab opened before the update) still holds a
      // connection at the old version. It closes itself via `onversionchange`,
      // so this only has to record that the upgrade is waiting.
      console.warn('[lumo] File storage upgrade is blocked by an open tab.');
    };
  });
}

/**
 * Copy v1 metadata into the `meta` store.
 *
 * Runs inside the upgrade transaction, so a failure aborts the version change
 * rather than leaving half a database behind. Directories are not written: they
 * are derived from the paths that exist, and the `dirs` store is reserved for
 * directories that were created on purpose.
 */
function backfillMetadata(tx: IDBTransaction | null): void {
  if (!tx) return;
  const files = tx.objectStore(STORE_NAME);
  const meta = tx.objectStore(META_STORE);
  const cursorRequest = files.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    const record = cursor.value as StoredFile;
    if (record?.metadata?.name) {
      meta.put(record.metadata);
    }
    cursor.continue();
  };
}

/**
 * Infer MIME type from file name extension.
 */
export function inferMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    // Text
    txt: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    csv: 'text/csv',
    xml: 'text/xml',
    // Code
    js: 'text/javascript',
    ts: 'text/typescript',
    jsx: 'text/javascript',
    tsx: 'text/typescript',
    json: 'application/json',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    toml: 'text/toml',
    py: 'text/x-python',
    rb: 'text/x-ruby',
    go: 'text/x-go',
    rs: 'text/x-rust',
    java: 'text/x-java',
    c: 'text/x-c',
    cpp: 'text/x-c++',
    h: 'text/x-c',
    hpp: 'text/x-c++',
    sh: 'text/x-shellscript',
    bash: 'text/x-shellscript',
    zsh: 'text/x-shellscript',
    bat: 'text/x-bat',
    cmd: 'text/x-bat',
    ps1: 'text/x-powershell',
    psm1: 'text/x-powershell',
    sql: 'text/x-sql',
    graphql: 'text/x-graphql',
    vue: 'text/x-vue',
    svelte: 'text/x-svelte',
    // Config / Data
    ini: 'text/plain',
    cfg: 'text/plain',
    conf: 'text/plain',
    env: 'text/plain',
    log: 'text/plain',
    dockerfile: 'text/plain',
    makefile: 'text/plain',
    gitignore: 'text/plain',
    editorconfig: 'text/plain',
    properties: 'text/plain',
    lock: 'text/plain',
    // Images
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    // Others
    pdf: 'application/pdf',
    zip: 'application/zip',
    tar: 'application/x-tar',
    gz: 'application/gzip',
  };
  // Direct extension match
  if (mimeMap[ext]) return mimeMap[ext];

  // Handle dot-prefixed config files (e.g. ".gitignore", ".editorconfig")
  const basename = filename.split('/').pop()?.split('\\').pop()?.toLowerCase() || '';
  const basenameNoExt = basename.startsWith('.') ? basename.slice(1) : '';
  if (basenameNoExt && mimeMap[basenameNoExt]) return mimeMap[basenameNoExt];

  // Handle well-known extensionless files
  const knownTextFiles = ['makefile', 'dockerfile', 'rakefile', 'gemfile', 'procfile', 'license', 'readme', 'changelog'];
  if (knownTextFiles.includes(basename)) return 'text/plain';

  return 'application/octet-stream';
}

/**
 * Detect whether a Blob (or its leading bytes) looks like a plain-text file.
 *
 * Reads the first 8 KB and checks for non-text bytes. The heuristic mirrors
 * what `git` and the UNIX `file` command use:
 * - NULL bytes (0x00) → binary
 * - Control chars except TAB (0x09), LF (0x0A), CR (0x0D) → binary
 * - Bytes ≥ 0x80 are allowed (UTF-8 multibyte)
 *
 * Returns `true` if the sample looks like text, `false` otherwise.
 */
export async function isLikelyTextContent(blob: Blob): Promise<boolean> {
  const SAMPLE_SIZE = 8192; // 8 KB
  const slice = blob.slice(0, SAMPLE_SIZE);
  const buffer = await slice.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    // Allow TAB, LF, CR, and printable ASCII + high bytes (UTF-8)
    if (b === 0x00) return false;
    if (b < 0x08) return false;
    if (b > 0x0d && b < 0x20) return false;
  }
  return true;
}

/**
 * Determine the preview category for a file.
 */
export type PreviewCategory = 'image' | 'text' | 'unsupported';

export function getPreviewCategory(mimeType: string): PreviewCategory {
  if (mimeType.startsWith('image/')) return 'image';
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml'
  ) {
    return 'text';
  }
  return 'unsupported';
}

/**
 * Get the code language identifier from MIME type (for syntax highlighting).
 */
export function getLanguageFromMime(mimeType: string): string | undefined {
  const langMap: Record<string, string> = {
    'text/javascript': 'javascript',
    'text/typescript': 'typescript',
    'text/css': 'css',
    'text/html': 'html',
    'text/markdown': 'markdown',
    'text/xml': 'xml',
    'text/yaml': 'yaml',
    'text/toml': 'toml',
    'text/x-python': 'python',
    'text/x-ruby': 'ruby',
    'text/x-go': 'go',
    'text/x-rust': 'rust',
    'text/x-java': 'java',
    'text/x-c': 'c',
    'text/x-c++': 'cpp',
    'text/x-shellscript': 'bash',
    'text/x-sql': 'sql',
    'text/x-graphql': 'graphql',
    'text/x-vue': 'vue',
    'text/x-svelte': 'svelte',
    'text/csv': 'csv',
    'application/json': 'json',
    'application/xml': 'xml',
  };
  return langMap[mimeType];
}

/**
 * Code-unit comparison, deliberately not `localeCompare`.
 *
 * Paths identify records, and a listing whose order depends on the user's locale
 * would make the skills index (built from these listings) differ between
 * browsers with identical contents.
 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * File storage singleton for managing files in IndexedDB.
 */
class FileStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private getDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB().then((db) => {
        // A newer version opened elsewhere must not be blocked by this context.
        // Dropping the cached promise makes the next call reopen at that version.
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        return db;
      });
    }
    return this.dbPromise;
  }

  /**
   * Write a file (create or overwrite).
   *
   * The content record, its metadata row and any missing parent directories are
   * written in one transaction: a file listed with no metadata row (or the other
   * way round) would be a half-visible file, and the two stores are read by
   * different views.
   */
  async writeFile(
    name: string,
    content: string | Blob,
    options?: { conversationId?: string; mimeType?: string },
  ): Promise<FileMetadata> {
    const path = normalizeFilePath(name);
    if (path === null) throw new Error(`Invalid file path: "${name}"`);

    let mimeType = options?.mimeType || inferMimeType(path);
    const blob = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content;

    // Content sniffing: when extension-based detection falls back to
    // octet-stream, probe the actual bytes to see if it's plain text.
    if (mimeType === 'application/octet-stream') {
      // String content is always text; for Blobs, sample leading bytes.
      if (typeof content === 'string' || await isLikelyTextContent(blob)) {
        mimeType = 'text/plain';
      }
    }
    const now = Date.now();

    // Check if file already exists to preserve createdAt
    const existing = await this.getMetadata(path);
    const createdAt = existing?.createdAt || now;

    const metadata: FileMetadata = {
      name: path,
      mimeType,
      size: blob.size,
      createdAt,
      updatedAt: now,
      conversationId: options?.conversationId || existing?.conversationId,
    };

    const db = await this.getDB();
    const tx = db.transaction([STORE_NAME, META_STORE], 'readwrite');
    const done = transactionDone(tx);

    const storedFile: StoredFile = { name: path, content: blob, metadata };
    tx.objectStore(STORE_NAME).put(storedFile);
    tx.objectStore(META_STORE).put(metadata);

    await done;

    // Announced here rather than in the MCP tools because this is the only
    // path every writer shares: `file_write`, `file_edit` and `file_patch`
    // all land here, and so would any future caller that would otherwise
    // have to remember to announce itself.
    emitEvent('files:changed', { names: [path], reason: 'write' });
    return metadata;
  }


  /**
   * Read a file's content as text.
   */
  async readFileAsText(name: string): Promise<string | null> {
    const file = await this.getFile(name);
    if (!file) return null;
    return file.content.text();
  }

  /**
   * Read a file's content as Blob.
   */
  async readFileAsBlob(name: string): Promise<Blob | null> {
    const file = await this.getFile(name);
    if (!file) return null;
    return file.content;
  }

  /**
   * Get a file with its content.
   */
  async getFile(name: string): Promise<StoredFile | null> {
    const path = normalizeFilePath(name) ?? name;
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(path);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get only file metadata (without content).
   */
  async getMetadata(name: string): Promise<FileMetadata | null> {
    const path = normalizeFilePath(name) ?? name;
    const db = await this.getDB();
    const tx = db.transaction(META_STORE, 'readonly');
    const record = await requestAsPromise(
      tx.objectStore(META_STORE).get(path) as IDBRequest<FileMetadata | undefined>,
    );
    if (record) return record;

    // A database written before the metadata store existed, or one whose
    // backfill never ran: read through to the content record instead of
    // reporting a file that is plainly there as missing.
    const file = await this.getFile(path);
    return file?.metadata ?? null;
  }

  /**
   * List all file metadata, newest first.
   *
   * Reads the metadata store, so listing never deserialises a blob.
   */
  async listFiles(): Promise<FileMetadata[]> {
    const db = await this.getDB();
    const tx = db.transaction(META_STORE, 'readonly');
    const rows = await requestAsPromise(
      tx.objectStore(META_STORE).getAll() as IDBRequest<FileMetadata[]>,
    );
    return (rows || []).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * List every file under a directory, at any depth, sorted by path.
   */
  async listByPrefix(dirPath: string): Promise<FileMetadata[]> {
    const dir = normalizeDirPath(dirPath);
    if (dir === null) throw new Error(`Invalid directory path: "${dirPath}"`);
    if (dir === '') return this.listFiles();

    const db = await this.getDB();
    const tx = db.transaction(META_STORE, 'readonly');
    const range = dirRange(dir);
    const rows = await requestAsPromise(
      tx.objectStore(META_STORE).getAll(range) as IDBRequest<FileMetadata[]>,
    );
    // Without `IDBKeyRange` (a test environment, or a degraded embedder) the
    // request returns the whole store, so the prefix still has to be applied.
    const scoped = range ? rows || [] : (rows || []).filter((row) => row.name.startsWith(dir));
    return scoped.sort((a, b) => compareStrings(a.name, b.name));
  }

  /**
   * List one directory: its immediate subdirectories and its own files.
   *
   * Subdirectories are derived from the paths that exist plus the `dirs` store,
   * so a directory created explicitly appears even while it is empty.
   */
  async listDirectory(dirPath: string): Promise<DirectoryListing> {
    const dir = normalizeDirPath(dirPath);
    if (dir === null) throw new Error(`Invalid directory path: "${dirPath}"`);

    const all = dir === '' ? await this.listFiles() : await this.listByPrefix(dir);
    const files: FileMetadata[] = [];
    const directories = new Set<string>();

    for (const file of all) {
      const rest = file.name.slice(dir.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        files.push(file);
      } else {
        directories.add(`${dir}${rest.slice(0, slash + 1)}`);
      }
    }

    for (const record of await this.listDirectories()) {
      if (record.path === dir || !record.path.startsWith(dir)) continue;
      const rest = record.path.slice(dir.length);
      if (!rest.slice(0, -1).includes('/')) directories.add(record.path);
    }

    return { path: dir, directories: [...directories].sort(), files };
  }

  /** Every recorded directory, outermost first. */
  async listDirectories(): Promise<DirectoryRecord[]> {
    const records = await this.readDirectoryRecords();
    return [...records.values()].sort((a, b) => compareStrings(a.path, b.path));
  }

  private async readDirectoryRecords(): Promise<Map<string, DirectoryRecord>> {
    const db = await this.getDB();
    const tx = db.transaction(DIR_STORE, 'readonly');
    const rows = await requestAsPromise(
      tx.objectStore(DIR_STORE).getAll() as IDBRequest<DirectoryRecord[]>,
    );
    return new Map((rows || []).map((record) => [record.path, record]));
  }

  /** Create a directory, including any missing ancestors. */
  async createDirectory(dirPath: string): Promise<DirectoryRecord> {
    const dir = normalizeDirPath(dirPath);
    if (dir === null) throw new Error(`Invalid directory path: "${dirPath}"`);
    if (dir === '') throw new Error('The storage root always exists');

    const now = Date.now();
    const known = await this.readDirectoryRecords();
    const db = await this.getDB();
    const tx = db.transaction(DIR_STORE, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(DIR_STORE);

    const record = (path: string, explicit: boolean): DirectoryRecord => ({
      path,
      kind: directoryKind(path),
      explicit,
      createdAt: known.get(path)?.createdAt ?? now,
      updatedAt: now,
    });
    for (const ancestor of ancestorDirPaths(dir)) store.put(record(ancestor, false));
    store.put(record(dir, true));

    await done;
    emitEvent('files:changed', { names: [], reason: 'write' });
    return record(dir, true);
  }

  /**
   * Delete an empty directory. Refuses while anything still lives under it, so a
   * mis-targeted delete cannot take a directory tree with it.
   */
  async deleteDirectory(dirPath: string): Promise<boolean> {
    const dir = normalizeDirPath(dirPath);
    if (dir === null) throw new Error(`Invalid directory path: "${dirPath}"`);
    if (dir === '') throw new Error('The storage root cannot be deleted');

    const listing = await this.listDirectory(dir);
    if (listing.files.length > 0 || listing.directories.length > 0) {
      throw new Error(`Directory "${dir}" is not empty`);
    }

    const db = await this.getDB();
    const tx = db.transaction(DIR_STORE, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(DIR_STORE).delete(dir);
    await done;
    emitEvent('files:changed', { names: [], reason: 'delete' });
    return true;
  }

  /**
   * Move or rename a file, or every file under a directory.
   *
   * A path that names an existing file is moved as a file; otherwise it is read
   * as a directory prefix. Moving into a name that is already taken fails instead
   * of merging, because a merge is unrecoverable and this is the only copy.
   */
  async movePath(
    fromPath: string,
    toPath: string,
  ): Promise<{ moved: string[]; to: string }> {
    const fromFile = normalizeFilePath(fromPath);
    const toFile = normalizeFilePath(toPath);
    if (fromFile === null) throw new Error(`Invalid source path: "${fromPath}"`);
    if (toFile === null) throw new Error(`Invalid target path: "${toPath}"`);
    if (fromFile === toFile) return { moved: [], to: toFile };

    const treatAsDirectory = fromPath.trim().endsWith('/') || (await this.getMetadata(fromFile)) === null;
    const sources = treatAsDirectory
      ? await this.listByPrefix(normalizeDirPath(fromFile) ?? `${fromFile}/`)
      : [await this.getMetadata(fromFile)].filter((m): m is FileMetadata => m !== null);

    if (sources.length === 0) throw new Error(`Nothing found at "${fromFile}"`);
    if (treatAsDirectory && toFile.startsWith(`${fromFile}/`)) {
      throw new Error('A directory cannot be moved inside itself');
    }

    const fromPrefix = treatAsDirectory ? `${fromFile}/` : fromFile;
    const toPrefix = treatAsDirectory ? `${toFile}/` : toFile;

    const planned: Array<{ from: FileMetadata; to: string; content: Blob }> = [];
    for (const source of sources) {
      const target = treatAsDirectory ? `${toPrefix}${source.name.slice(fromPrefix.length)}` : toPrefix;
      if (target === source.name) continue;
      const content = await this.readFileAsBlob(source.name);
      if (!content) throw new Error(`File "${source.name}" disappeared while moving`);
      if (await this.exists(target)) throw new Error(`Target "${target}" already exists`);
      planned.push({ from: source, to: target, content });
    }
    if (planned.length === 0) return { moved: [], to: toPrefix };

    const db = await this.getDB();
    const knownDirs = await this.readDirectoryRecords();
    const tx = db.transaction([STORE_NAME, META_STORE, DIR_STORE], 'readwrite');
    const done = transactionDone(tx);
    const fileStore = tx.objectStore(STORE_NAME);
    const metaStore = tx.objectStore(META_STORE);
    const dirStore = tx.objectStore(DIR_STORE);
    const now = Date.now();

    for (const item of planned) {
      const metadata: FileMetadata = { ...item.from, name: item.to, updatedAt: now };
      fileStore.put({ name: item.to, content: item.content, metadata } satisfies StoredFile);
      fileStore.delete(item.from.name);
      metaStore.put(metadata);
      metaStore.delete(item.from.name);
    }
    for (const dir of ancestorDirPaths(parentDirPath(toPrefix))) {
      if (knownDirs.has(dir)) continue;
      dirStore.put({
        path: dir,
        kind: directoryKind(dir),
        explicit: false,
        createdAt: now,
        updatedAt: now,
      } satisfies DirectoryRecord);
    }
    if (treatAsDirectory) {
      for (const record of knownDirs.values()) {
        if (!record.path.startsWith(fromPrefix)) continue;
        dirStore.delete(record.path);
        const target = `${toPrefix}${record.path.slice(fromPrefix.length)}`;
        dirStore.put({ ...record, path: target, kind: directoryKind(target), updatedAt: now });
      }
    }

    await done;

    const names = planned.flatMap((item) => [item.from.name, item.to]);
    emitEvent('files:changed', { names, reason: 'write' });
    return { moved: planned.map((item) => item.to), to: toPrefix };
  }

  /**
   * Delete a file by name.
   */
  async deleteFile(name: string): Promise<boolean> {
    const path = normalizeFilePath(name) ?? name;
    const db = await this.getDB();
    const tx = db.transaction([STORE_NAME, META_STORE], 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(STORE_NAME).delete(path);
    tx.objectStore(META_STORE).delete(path);
    await done;
    emitEvent('files:changed', { names: [path], reason: 'delete' });
    return true;
  }

  /**
   * Delete a file, or every file under a directory prefix.
   *
   * The bulk form exists for destructive acts on a whole namespace — deleting an
   * installed skill. Done file by file that is one transaction *and one
   * `files:changed` event* per file, and every event rebuilds the skills index
   * and refreshes each open view, so a ten-file skill announced ten partial
   * states. Here it is one transaction and one event naming everything removed.
   *
   * Directory records at or under the prefix go with the files, so no empty husk
   * is left behind for `listDirectory()` to advertise.
   *
   * @returns The paths that were deleted.
   */
  async deletePath(path: string): Promise<string[]> {
    const normalized = normalizeFilePath(path);
    if (normalized === null) throw new Error(`Invalid path: "${path}"`);

    const treatAsDirectory =
      path.trim().endsWith('/') || (await this.getMetadata(normalized)) === null;
    const prefix = treatAsDirectory ? `${normalized}/` : normalized;
    const names = treatAsDirectory
      ? (await this.listByPrefix(prefix)).map((file) => file.name)
      : [normalized];

    // Read the directory records *before* opening the write transaction: an
    // await inside it would queue a second transaction behind this one and
    // deadlock the pair.
    const knownDirs: Map<string, DirectoryRecord> = treatAsDirectory
      ? await this.readDirectoryRecords()
      : new Map();

    const db = await this.getDB();
    const tx = db.transaction([STORE_NAME, META_STORE, DIR_STORE], 'readwrite');
    const done = transactionDone(tx);
    const fileStore = tx.objectStore(STORE_NAME);
    const metaStore = tx.objectStore(META_STORE);
    const dirStore = tx.objectStore(DIR_STORE);

    for (const name of names) {
      fileStore.delete(name);
      metaStore.delete(name);
    }
    for (const record of knownDirs.values()) {
      if (record.path.startsWith(prefix)) dirStore.delete(record.path);
    }

    await done;

    if (names.length === 0) return [];
    emitEvent('files:changed', { names, reason: 'delete' });
    return names;
  }

  /**
   * Delete every stored file the user owns.
   *
   * Directories in `SYSTEM_DIR_PREFIXES` (today: `skills/`) are kept: emptying
   * the file manager is an operation on the user's documents, and a skill is an
   * installed capability rather than a document. Deleting one is an explicit act
   * on that skill's own files.
   *
   * The names are collected *before* the stores are cleared because the change
   * event's contract is to list what was affected — subscribers showing a single
   * file (the preview tab) filter on that list, and an empty one would leave
   * them displaying a file that no longer exists.
   *
   * @returns How many files were deleted.
   */
  async clearFiles(): Promise<number> {
    const removable = (await this.listFiles())
      .map((file) => file.name)
      .filter((name) => !isSystemPath(name));
    if (removable.length === 0) return 0;

    const db = await this.getDB();
    const tx = db.transaction([STORE_NAME, META_STORE], 'readwrite');
    const done = transactionDone(tx);
    const fileStore = tx.objectStore(STORE_NAME);
    const metaStore = tx.objectStore(META_STORE);
    for (const name of removable) {
      fileStore.delete(name);
      metaStore.delete(name);
    }
    await done;
    emitEvent('files:changed', { names: removable, reason: 'delete' });
    return removable.length;
  }

  /**
   * Restore files and explicit directories from a backup archive.
   *
   * A restore is a bulk write, so it takes one transaction and announces one
   * `files:changed` event instead of one per file. Without that, importing a
   * library with a hundred files would rebuild the skills index a hundred times
   * and leave every open file view flickering through partial states.
   *
   * Collision policy is deliberately non-destructive by default:
   * - a user file that already occupies the path is renamed (`report (1).md`),
   * - a file under a system namespace (`skills/`) is skipped, because renaming
   *   `SKILL.md` to `SKILL (1).md` would corrupt an installed skill,
   * - `overwrite` restores the exact paths from the archive instead.
   *
   * Invalid paths are skipped rather than aborting the batch: one malformed entry
   * must not throw away the rest of a backup.
   */
  async restoreFiles(
    entries: RestoreFileEntry[],
    directories: RestoreDirectoryEntry[] = [],
    { overwrite = false }: { overwrite?: boolean } = {},
  ): Promise<RestoreFilesResult> {
    const existing = await this.listFiles();
    const taken = new Set(existing.map((file) => file.name));
    const now = Date.now();
    const plannedFiles: StoredFile[] = [];
    const imported: string[] = [];
    const skipped: string[] = [];

    for (const entry of entries) {
      const path = normalizeFilePath(entry.name);
      if (path === null) {
        skipped.push(entry.name);
        continue;
      }

      let target = path;
      if (taken.has(target) && !overwrite) {
        if (isSystemPath(target)) {
          skipped.push(path);
          continue;
        }
        target = uniqueFilePath(target, taken);
      }

      taken.add(target);
      const mimeType = entry.mimeType || inferMimeType(target);
      const content =
        entry.content.type === mimeType
          ? entry.content
          : entry.content.slice(0, entry.content.size, mimeType);
      const metadata: FileMetadata = {
        name: target,
        mimeType,
        size: content.size,
        createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : now,
        updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : now,
        conversationId: entry.conversationId,
      };

      plannedFiles.push({ name: target, content, metadata });
      imported.push(target);
    }

    const knownDirs = await this.readDirectoryRecords();
    const plannedDirs = new Map<string, DirectoryRecord>();
    for (const entry of directories) {
      const path = normalizeDirPath(entry.path);
      if (path === null || path === '') continue;
      const previous = knownDirs.get(path) ?? plannedDirs.get(path);
      plannedDirs.set(path, {
        path,
        kind: directoryKind(path),
        explicit: entry.explicit || previous?.explicit === true,
        createdAt: previous?.createdAt ?? (Number.isFinite(entry.createdAt) ? entry.createdAt : now),
        updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : now,
      });
    }

    if (plannedFiles.length === 0 && plannedDirs.size === 0) {
      return { imported, skipped };
    }

    const db = await this.getDB();
    const tx = db.transaction([STORE_NAME, META_STORE, DIR_STORE], 'readwrite');
    const done = transactionDone(tx);
    const fileStore = tx.objectStore(STORE_NAME);
    const metaStore = tx.objectStore(META_STORE);
    const dirStore = tx.objectStore(DIR_STORE);

    for (const file of plannedFiles) {
      fileStore.put(file);
      metaStore.put(file.metadata);
    }
    for (const directory of plannedDirs.values()) dirStore.put(directory);

    await done;
    emitEvent('files:changed', { names: imported, reason: 'write' });
    return { imported, skipped };
  }

  /**
   * Check if a file exists.
   */
  async exists(name: string): Promise<boolean> {
    const path = normalizeFilePath(name) ?? name;
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.count(path);
      request.onsuccess = () => resolve(request.result > 0);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get files by conversation ID.
   */
  async getFilesByConversation(conversationId: string): Promise<FileMetadata[]> {
    const all = await this.listFiles();
    return all.filter((f) => f.conversationId === conversationId);
  }

  /**
   * Get the object URL for a file (for preview/download).
   * Caller must revoke the URL when done.
   */
  async getObjectUrl(name: string): Promise<string | null> {
    const blob = await this.readFileAsBlob(name);
    if (!blob) return null;
    return URL.createObjectURL(blob);
  }
}

/** Singleton instance */
export const fileStorage = new FileStorage();
