/**
 * Zip reading and the small amount of format parsing every backup shares.
 *
 * The archive is user-supplied, so nothing here trusts it: paths are normalised
 * through the storage layer's rules (which reject `..` rather than resolving it),
 * and admission is decided from the zip's central directory before an entry is
 * inflated, so a decompression bomb fails as an error rather than as a frozen
 * options page.
 */
import { strFromU8, unzipSync } from 'fflate';
import type { BackupGroup, BackupManifest, BackupStats } from './types';

export const BACKUP_FORMAT = 'lumo-backup';
export const BACKUP_VERSION = 1;

export const MANIFEST_PATH = 'manifest.json';
export const CONFIG_PATH = 'config/config.json';
export const CONVERSATION_INDEX_PATH = 'conversations/index.json';
export const CONVERSATION_RECORD_DIR = 'conversations/records/';
export const CONVERSATION_BLOB_DIR = 'conversations/blobs/';
export const FILE_INDEX_PATH = 'files/manifest.json';
export const FILE_DATA_PREFIX = 'files/data/';

/**
 * Ceiling on what one archive may expand to.
 *
 * Structural, not a product limit: it is the point beyond which a synchronous
 * inflate would exhaust the options page rather than produce a usable backup.
 */
export const MAX_BACKUP_EXPANDED_BYTES = 1024 * 1024 * 1024;

/** Ceiling on entry count, so a million empty files cannot stall the import. */
export const MAX_BACKUP_FILES = 50_000;

export type BackupErrorCode =
  | 'not-zip'
  | 'too-large'
  | 'missing-manifest'
  | 'invalid-manifest'
  | 'unsupported-version'
  | 'corrupt';

export class BackupError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode, message: string) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

const GROUPS: BackupGroup[] = ['conversations', 'files', 'config'];

/**
 * Canonicalise a path inside the archive.
 *
 * Deliberately not `normalizeFilePath`: that function caps the whole path at the
 * storage layer's 1024-character limit, while an archive path adds a prefix
 * (`files/data/`) to a name that was already near that limit. The rules that
 * matter for safety are kept — no `..`, no absolute paths, bounded segments —
 * and the total is only bounded enough to keep a zip entry sane.
 */
export function normalizeArchivePath(raw: string): string | null {
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
  return path.length > 4096 ? null : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBackupGroup(value: unknown): value is BackupGroup {
  return typeof value === 'string' && (GROUPS as string[]).includes(value);
}

const EMPTY_STATS: BackupStats = {
  conversations: 0,
  conversationBlobs: 0,
  files: 0,
  fileBytes: 0,
};

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Expand a zip into a path-keyed entry map.
 *
 * Directory entries are dropped: this format never needs one, and a directory
 * record is declared in `files/manifest.json` where it can carry its own
 * metadata. Every remaining path is canonicalised, so `a//b`, `a/./b` and
 * `a/b` are one entry and an archive cannot address anything outside itself.
 */
export function readZipEntries(bytes: Uint8Array): Record<string, Uint8Array> {
  const refusals: string[] = [];
  let declaredBytes = 0;
  let admittedFiles = 0;

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (entry) => {
        if (refusals.length > 0) return false;
        if (entry.name.endsWith('/')) return false;

        const path = normalizeArchivePath(entry.name);
        if (path === null) return false;

        declaredBytes += entry.originalSize;
        admittedFiles += 1;

        if (declaredBytes > MAX_BACKUP_EXPANDED_BYTES) {
          refusals.push('archive expands beyond the size limit');
          return false;
        }
        if (admittedFiles > MAX_BACKUP_FILES) {
          refusals.push('archive holds too many files');
          return false;
        }
        return true;
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BackupError('not-zip', `not a readable zip archive (${message})`);
  }

  const refusal = refusals[0];
  if (refusal !== undefined) throw new BackupError('too-large', refusal);

  const normalized: Record<string, Uint8Array> = {};
  for (const [rawPath, data] of Object.entries(entries)) {
    const path = normalizeArchivePath(rawPath);
    if (path !== null) normalized[path] = data;
  }
  return normalized;
}

/** Read and parse one JSON entry, or `null` when it is absent. */
export function readJsonEntry<T>(entries: Record<string, Uint8Array>, path: string): T | null {
  const data = entries[path];
  if (data === undefined) return null;
  try {
    return JSON.parse(strFromU8(data)) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BackupError('corrupt', `invalid JSON at ${path} (${message})`);
  }
}

/** Parse a required JSON entry. */
export function requireJsonEntry<T>(entries: Record<string, Uint8Array>, path: string): T {
  const value = readJsonEntry<T>(entries, path);
  if (value === null) throw new BackupError('corrupt', `missing ${path}`);
  return value;
}

/** Validate and normalise `manifest.json`. */
export function parseManifest(entries: Record<string, Uint8Array>): BackupManifest {
  const raw = readJsonEntry<unknown>(entries, MANIFEST_PATH);
  if (raw === null) throw new BackupError('missing-manifest', 'missing manifest.json');
  if (!isRecord(raw)) throw new BackupError('invalid-manifest', 'manifest is not an object');

  if (raw.format !== BACKUP_FORMAT) {
    throw new BackupError('invalid-manifest', 'not a Lumo backup');
  }

  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new BackupError('invalid-manifest', 'manifest version is missing or invalid');
  }
  if (version > BACKUP_VERSION) {
    throw new BackupError(
      'unsupported-version',
      `backup version ${version} is newer than this build understands`,
    );
  }

  if (!Array.isArray(raw.contents) || raw.contents.length === 0) {
    throw new BackupError('invalid-manifest', 'manifest contents are missing');
  }
  const contents = [...new Set(raw.contents.filter(isBackupGroup))];
  if (contents.length === 0) {
    throw new BackupError('invalid-manifest', 'manifest contents are invalid');
  }

  const statsRaw = isRecord(raw.stats) ? raw.stats : {};
  const stats: BackupStats = {
    conversations: numberOrZero(statsRaw.conversations),
    conversationBlobs: numberOrZero(statsRaw.conversationBlobs),
    files: numberOrZero(statsRaw.files),
    fileBytes: numberOrZero(statsRaw.fileBytes),
  };

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '',
    contents,
    stats,
  };
}

export function emptyStats(): BackupStats {
  return { ...EMPTY_STATS };
}

/** UTF-8 bytes of a pretty-printed JSON document. */
export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}
