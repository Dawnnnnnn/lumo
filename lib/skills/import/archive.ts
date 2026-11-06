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
 * - admission is decided from the archive's central directory *before* an entry
 *   is inflated, so a decompression bomb fails as an error rather than as a
 *   frozen tab, and a large-but-honest package still installs.
 */
import { unzipSync } from 'fflate';
import { normalizeFilePath } from '@/lib/mcp/file-storage';
import type { PackageFile } from './types';

/**
 * Ceiling on what one package may expand to, as a *structural* guard.
 *
 * This is deliberately not a product limit: a skill is instructions plus the
 * assets it ships, and refusing one for being big is the wrong trade — 32 MB used
 * to be a hard wall here and a data-heavy skill simply could not be installed.
 * What still has to be impossible is an archive declaring more than the tab can
 * hold: every entry is admitted from the central directory's `originalSize`, so a
 * bomb is rejected before a single byte is inflated. Anything under the ceiling
 * installs, however large.
 */
export const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;

/**
 * Ceiling on the number of files one package may hold.
 *
 * The same reasoning as `MAX_EXPANDED_BYTES`: installing writes one record per
 * file, so an archive of a million empty files would stall the install long
 * before it ran out of space. A skill of five thousand files is already far
 * beyond anything hand-written.
 */
export const MAX_PACKAGE_FILES = 5_000;

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
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
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
  /**
   * Refusal reasons, in the order they were detected.
   *
   * A list rather than a single value because it is written from the admission
   * callback: one slot per rejected entry is still one slot in practice, since the
   * first refusal stops admitting anything else.
   */
  const refusals: string[] = [];
  let declaredBytes = 0;
  let admittedFiles = 0;

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      /**
       * Admission control, in the one place that can refuse an entry *before* it
       * is inflated. `unzipSync` calls this with the central directory's declared
       * sizes, so the cost of a rejected bomb is a header read, not a
       * decompression — and a package under the ceiling is admitted whole, with no
       * compressed-size cap and no per-file cap of its own.
       */
      filter: (entry) => {
        if (refusals.length > 0) return false;
        // Directory entries carry no content of their own.
        if (entry.name.endsWith('/')) return false;

        // Debris is skipped before it is decompressed: a GitHub zip otherwise
        // pays for inflating `.git/` just to throw it away.
        const path = normalizeFilePath(entry.name);
        if (path === null || isIgnoredPackagePath(path)) return false;

        declaredBytes += entry.originalSize;
        admittedFiles += 1;

        if (declaredBytes > MAX_EXPANDED_BYTES) {
          refusals.push(`archive expands beyond ${describeSize(MAX_EXPANDED_BYTES)}`);
          return false;
        }
        if (admittedFiles > MAX_PACKAGE_FILES) {
          refusals.push(`archive holds more than ${MAX_PACKAGE_FILES} files`);
          return false;
        }
        return true;
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `not a readable zip archive (${message})` };
  }

  const refusal = refusals[0];
  if (refusal !== undefined) return { ok: false, error: refusal };

  // Everything present was already admitted and normalised by the filter; this
  // pass only re-derives the path it keyed the entry under.
  const files: PackageFile[] = [];
  for (const [rawPath, data] of Object.entries(entries)) {
    const path = normalizeFilePath(rawPath);
    if (path === null || isIgnoredPackagePath(path)) continue;
    files.push({ path, data });
  }

  return { ok: true, files };
}
