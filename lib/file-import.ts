/**
 * What a file dragged in from the operating system is allowed to become.
 *
 * Two surfaces accept such a drop — the side panel (`ChatPanel`) and the options
 * page file manager — and they must agree on the answer, so the decision lives
 * here rather than in either of them.
 *
 * ## Only text and images
 *
 * A stored file exists to be read: by the model through `file_read`, and by the
 * user through the preview tab. Neither can do anything with a `.zip` or an
 * `.exe`, so those are refused rather than parked in IndexedDB forever. Images
 * are usable, but only inline in a conversation where a vision model can see
 * them — they are never written to storage, which keeps the file manager free of
 * binary blobs.
 *
 * The three-way split is `getPreviewCategory`'s, not a second whitelist: that
 * function already decides what the preview tab can render, and "renderable as
 * text" is exactly "worth storing". Adding a parallel list here would let the two
 * drift, and a file that stored fine but could not be previewed is precisely the
 * confusing case.
 *
 * ## Failures are silent
 *
 * A refused file simply does not appear. There is no message, because the only
 * honest one would restate what the user can already see, and a drop that lands
 * outside the accepted set is a mis-drag, not an error worth interrupting for.
 */
import { fileStorage, getPreviewCategory, inferMimeType } from '@/lib/mcp';

/** What a dropped file may become. `'unsupported'` is dropped on the floor. */
export type DroppedFileKind = 'text' | 'image' | 'unsupported';

/**
 * The MIME type to treat a dropped file as.
 *
 * The extension map wins over the browser's own `File.type`, which sounds
 * backwards until you drop a `.ts` file: Chrome reports `video/mp2t` for it, and
 * `.vue`/`.svelte` come through as an empty string. Trusting `File.type` would
 * therefore refuse ordinary source files as binary. `File.type` is still the
 * better answer for extensions the map has never heard of (`.log` arrives as
 * `text/plain`), so it is the fallback rather than the primary.
 */
/** The only two properties classification needs; a `Blob` plus a path satisfies it. */
export interface DroppedFileLike {
  name: string;
  type: string;
}

export function resolveDroppedMimeType(file: DroppedFileLike): string {
  const fromName = inferMimeType(file.name);
  if (fromName !== 'application/octet-stream') return fromName;
  return file.type || 'application/octet-stream';
}

/** Classifies a dropped file into the three cases described at the top. */
export function classifyDroppedFile(file: DroppedFileLike): DroppedFileKind {
  const category = getPreviewCategory(resolveDroppedMimeType(file));
  return category === 'unsupported' ? 'unsupported' : category;
}

/** Whether a drag carries files from outside the browser. */
export function hasOsFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files');
}

/**
 * Splits a stored-file name into the parts a rename has to keep.
 *
 * The directory prefix matters because names like `notes/report.md` are how this
 * app models folders (see `buildFileTree`), and the extension matters
 * because it is what `inferMimeType` reads back on the next load.
 */
function splitFileName(name: string): { dir: string; stem: string; ext: string } {
  const lastSlash = name.lastIndexOf('/');
  const dir = lastSlash >= 0 ? name.slice(0, lastSlash + 1) : '';
  const base = name.slice(dir.length);
  const lastDot = base.lastIndexOf('.');
  // A leading dot is part of the name (`.gitignore`), not an extension.
  if (lastDot <= 0) return { dir, stem: base, ext: '' };
  return { dir, stem: base.slice(0, lastDot), ext: base.slice(lastDot) };
}

/**
 * A name that is free to write, derived from `name`.
 *
 * `fileStorage.writeFile` is a keyed `put`, so importing a file the agent had
 * already produced would silently replace its contents — the user drags in their
 * own `report.md` and the generated one is gone, with the row in the table
 * looking untouched. An import is always a new file, so it takes a new name
 * instead: `report.md` → `report (1).md`.
 */
export async function uniqueFileName(name: string): Promise<string> {
  if (!(await fileStorage.exists(name))) return name;

  const { dir, stem, ext } = splitFileName(name);
  for (let n = 1; ; n += 1) {
    const candidate = `${dir}${stem} (${n})${ext}`;
    if (!(await fileStorage.exists(candidate))) return candidate;
  }
}

/**
 * Stores every text file in `files`, skipping the rest.
 *
 * Returns the names actually written, in drop order, so the caller can reference
 * them — these are the deduplicated names, not the names on disk.
 *
 * `conversationId` is what associates a file with the chat it was dropped into.
 * Omitting it is meaningful rather than a gap: the options page has no
 * conversation, and neither does a side panel with no chat open, and both should
 * read as "Manual / Unknown" in the source column.
 */
export async function importTextFiles(
  files: FileList | File[],
  options?: { conversationId?: string },
): Promise<string[]> {
  return importFileEntries(
    Array.from(files).map((file) => ({ name: file.name, file })),
    options,
  );
}

/**
 * Import blobs under explicit names.
 *
 * Separate from `importTextFiles` because a dropped *directory* has paths but no
 * `File` objects with those names (see `lib/skills/import/browser.ts`), and a
 * skill package has bytes whose origin path is the only name worth keeping.
 * Creating a `File` just to satisfy the type would copy nothing but would hide
 * that fact; naming the real input is honest.
 */
export async function importFileEntries(
  entries: ReadonlyArray<{ name: string; file: Blob }>,
  options?: { conversationId?: string },
): Promise<string[]> {
  const written: string[] = [];

  // Sequential on purpose: `uniqueFileName` probes storage, so two files with
  // the same name in one drop would otherwise both be handed the same free name
  // and the second would overwrite the first.
  for (const entry of entries) {
    const file = entry.file;
    const like: DroppedFileLike = { name: entry.name, type: file.type };
    if (classifyDroppedFile(like) !== 'text') continue;
    const mimeType = resolveDroppedMimeType(like);
    // An entry that already carries a path keeps it (a dropped directory), a
    // bare file name gets one only if the caller supplied one.
    const name = await uniqueFileName(entry.name);
    // Re-typed rather than stored as-is, so the blob the preview tab reads back
    // carries the same MIME type as the metadata — a `.ts` file must not be a
    // `video/mp2t` blob described as `text/typescript`.
    const blob = file.type === mimeType ? file : file.slice(0, file.size, mimeType);
    try {
      await fileStorage.writeFile(name, blob, {
        mimeType,
        conversationId: options?.conversationId,
      });
      written.push(name);
    } catch (err) {
      // One unwritable file must not abandon the rest of the drop.
      console.error('Failed to import dropped file:', entry.name, err);
    }
  }

  return written;
}
