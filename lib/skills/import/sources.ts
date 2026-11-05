/**
 * Package sources.
 *
 * Every source only has to answer "give me the files". Zip, dropped folder and
 * the (future) URL/GitHub fetcher all end up here, so the discovery and install
 * stages never learn where a skill came from. `read()` is lazy: nothing is
 * fetched or decompressed until an import is actually requested.
 */
import { SKILL_FILE_NAME } from '../constants';
import { unpackZipArchive } from './archive';
import type { PackageFile, SkillPackageSource } from './types';

/** Files that were already read (a caller that inspected them first). */
export function packageFilesSource(
  files: PackageFile[],
  label = 'package',
): SkillPackageSource {
  return {
    label,
    read: async () => files,
  };
}

/** A `.zip` blob, as produced by a file input or a drag from the OS. */
export function zipPackageSource(archive: Blob, label = 'archive.zip'): SkillPackageSource {
  return {
    label,
    read: async () => {
      const bytes = new Uint8Array(await archive.arrayBuffer());
      const unpacked = unpackZipArchive(bytes);
      if (!unpacked.ok) throw new Error(unpacked.error);
      return unpacked.files;
    },
  };
}

/** A file plus the path it should keep inside the package. */
export interface SourceEntry {
  path: string;
  file: Blob;
}

/** A directory that was dropped or picked, keeping its structure. */
export function directoryPackageSource(
  entries: SourceEntry[],
  label = 'directory',
): SkillPackageSource {
  return {
    label,
    read: async () =>
      Promise.all(
        entries.map(async (entry) => ({
          path: entry.path,
          data: new Uint8Array(await entry.file.arrayBuffer()),
        })),
      ),
  };
}

/**
 * A file chosen through a picker, as much of it as this module needs.
 *
 * `webkitRelativePath` is the only path information a `<input type="file"
 * webkitdirectory>` gives back, and it is non-standard, so it is optional here:
 * a browser without it still hands over the file itself.
 */
export interface PickedFile extends Blob {
  readonly name: string;
  readonly webkitRelativePath?: string;
}

/**
 * Entries for a folder the user picked, keeping the structure a skill needs.
 *
 * The picker prefixes every path with the chosen folder's name, which is exactly
 * the shape the rest of the pipeline expects: the folder becomes the package
 * root, `discoverSkills` finds the `SKILL.md` inside it, and the installed
 * directory still comes from the manifest's own `name` — so the outer folder's
 * name never leaks into the skill. Picking a folder of several skills therefore
 * installs all of them, the same way dropping one does.
 */
export function directoryEntriesFromFiles(files: Iterable<PickedFile>): SourceEntry[] {
  const entries: SourceEntry[] = [];
  for (const file of files) {
    // A browser without `webkitRelativePath` gives the bare file name; the file
    // is still worth installing, so the fallback is the name rather than a skip.
    const path = (file.webkitRelativePath || file.name || '').replace(/^\/+/, '');
    if (!path) continue;
    entries.push({ path, file });
  }
  return entries;
}

/**
 * A `fetch`-based source, for a future URL or GitHub import.
 *
 * Not exported through the UI yet, but it is the whole reason the source
 * boundary exists: adding "install from URL" becomes one `fetch` plus a call to
 * `importSkillPackages`, with no change to discovery, validation or install.
 */
export function urlPackageSource(url: string, label = url): SkillPackageSource {
  return {
    label,
    read: async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`could not download ${url} (HTTP ${response.status})`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      // A GitHub archive is a zip; a raw `SKILL.md` URL is not, and both are
      // legitimate things to install from a link.
      const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
      if (isZip) {
        const unpacked = unpackZipArchive(bytes);
        if (!unpacked.ok) throw new Error(unpacked.error);
        return unpacked.files;
      }
      return [{ path: SKILL_FILE_NAME, data: bytes }];
    },
  };
}
