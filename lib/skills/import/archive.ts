/**
 * Zip unpacking and archive hygiene.
 *
 * A skill archive is attacker-controlled in the general case (a downloaded
 * bundle, a GitHub tarball), so nothing here trusts its contents:
 *
 * - paths are normalised through the storage layer's own rules, which *reject*
 *   `..` instead of resolving it — an archive cannot address a file outside the
 *   skill it is installing;
 * - editor and OS debris (`__MACOSX/`, `.DS_Store`, dot-directories, `.git`,
 *   `node_modules`) is dropped, because a GitHub zip otherwise installs Git's
 *   object database next to the skill;
 * - the expansion is bounded by size and file count, so a decompression bomb
 *   fails as an error rather than as a frozen tab.
 */
import { unzipSync } from 'fflate';
import { normalizeFilePath } from '@/lib/mcp/file-storage';
import type { PackageFile } from './types';

/** Largest archive we are willing to decompress (compressed size). */
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
/** Largest single file we accept from an archive. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Largest number of files a package may expand to. */
export const MAX_PACKAGE_FILES = 500;

/** Directories that never belong to a skill. */
const IGNORED_SEGMENTS = new Set(['__MACOSX', 'node_modules']);

/** Per-file debris some OSes and editors add. */
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/**
 * Whether a path is packaging noise rather than skill content.
 *
 * Any dot-prefixed segment is dropped: `.git/` in a GitHub archive, `.vscode/`,
 * `.DS_Store` — none of them can be instructions, and `.staging-*` directories
 * written by the installer must never be re-imported either.
 */
export function isIgnoredPackagePath(path: string): boolean {
  const segments = path.split('/');
  if (segments.some((segment) => segment.startsWith('.') || IGNORED_SEGMENTS.has(segment))) {
    return true;
  }
  const base = segments[segments.length - 1] ?? '';
  return IGNORED_FILES.has(base);
}

export type UnpackResult =
  | { ok: true; files: PackageFile[] }
  | { ok: false; error: string };

function describeSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Expand a zip archive into package files.
 *
 * Keeps the directory structure as-is: the caller decides which directory is a
 * skill root, so an archive holding `repo-main/skills/a/SKILL.md` and
 * `repo-main/skills/b/SKILL.md` yields two skills without any special casing.
 */
export function unpackZipArchive(bytes: Uint8Array): UnpackResult {
  if (bytes.length > MAX_ARCHIVE_BYTES) {
    return {
      ok: false,
      error: `archive is ${describeSize(bytes.length)}, over the ${describeSize(MAX_ARCHIVE_BYTES)} limit`,
    };
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `not a readable zip archive (${message})` };
  }

  const files: PackageFile[] = [];
  let total = 0;

  for (const [rawPath, data] of Object.entries(entries)) {
    // Directory entries carry no content of their own.
    if (rawPath.endsWith('/')) continue;

    const path = normalizeFilePath(rawPath);
    // `normalizeFilePath` rejects `..` and empty paths; skipping is the safe
    // answer, and the surrounding skills still install.
    if (path === null) continue;
    if (isIgnoredPackagePath(path)) continue;

    if (data.length > MAX_FILE_BYTES) {
      return { ok: false, error: `"${path}" is ${describeSize(data.length)}, over the per-file limit` };
    }
    total += data.length;
    if (total > MAX_ARCHIVE_BYTES) {
      return { ok: false, error: `archive expands beyond the ${describeSize(MAX_ARCHIVE_BYTES)} limit` };
    }

    files.push({ path, data });
    if (files.length > MAX_PACKAGE_FILES) {
      return { ok: false, error: `archive holds more than ${MAX_PACKAGE_FILES} files` };
    }
  }

  return { ok: true, files };
}
