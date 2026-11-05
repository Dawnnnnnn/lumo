/**
 * Reading a drag-and-drop payload that may contain directories.
 *
 * `DataTransfer.files` flattens a dropped folder into loose files with no paths,
 * which would destroy the structure a skill is made of (`references/`,
 * `scripts/`). The non-standard `webkitGetAsEntry()` API is the only way to see
 * that structure, so it is used when present and the flat file list is the
 * fallback.
 *
 * Reading is split from importing on purpose: entries carry `File` handles and
 * are only read once the caller knows it is actually installing a skill. A
 * folder of ordinary documents therefore never gets buffered as a package.
 */
import { SKILL_FILE_NAME } from '../constants';
import type { SourceEntry } from './sources';

export interface DroppedPayload {
  /** Files that arrived inside a directory, with their relative path. */
  entries: SourceEntry[];
  /** Zip archives, wherever they were dropped. */
  archives: File[];
  /** Loose files dropped at the top level (the existing file-import path). */
  flatFiles: File[];
}

export function isEmptyDrop(payload: DroppedPayload): boolean {
  return payload.entries.length === 0 && payload.archives.length === 0 && payload.flatFiles.length === 0;
}

function isArchive(file: Blob, name: string): boolean {
  return name.toLowerCase().endsWith('.zip') || file.type === 'application/zip';
}

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

interface FileSystemFileEntryLike extends FileSystemEntryLike {
  file(success: (file: File) => void, error?: (error: unknown) => void): void;
}

interface FileSystemDirectoryEntryLike extends FileSystemEntryLike {
  createReader(): {
    readEntries(success: (entries: FileSystemEntryLike[]) => void, error?: (error: unknown) => void): void;
  };
}

function readEntryFile(entry: FileSystemFileEntryLike): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readAllEntries(entry: FileSystemDirectoryEntryLike): Promise<FileSystemEntryLike[]> {
  const reader = entry.createReader();
  const collected: FileSystemEntryLike[] = [];

  // `readEntries` returns at most 100 entries per call; stopping at the first
  // empty batch is how the API signals the end.
  return new Promise((resolve, reject) => {
    const next = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(collected);
          return;
        }
        collected.push(...batch);
        next();
      }, reject);
    };
    next();
  });
}

async function walk(
  entry: FileSystemEntryLike,
  prefix: string,
  payload: DroppedPayload,
): Promise<void> {
  const path = `${prefix}${entry.name}`;

  if (entry.isFile) {
    const file = await readEntryFile(entry as FileSystemFileEntryLike);
    if (isArchive(file, entry.name)) {
      payload.archives.push(file);
      return;
    }
    if (prefix === '') {
      payload.flatFiles.push(file);
      return;
    }
    payload.entries.push({ path, file });
    return;
  }

  if (!entry.isDirectory) return;
  const children = await readAllEntries(entry as FileSystemDirectoryEntryLike);
  for (const child of children) {
    await walk(child, `${path}/`, payload);
  }
}

/**
 * Classify everything in a drop.
 *
 * Directories are walked recursively; a top-level loose file keeps its place on
 * the existing text-import path so dropping `report.md` still behaves exactly as
 * it always did.
 */
export async function readDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedPayload> {
  const payload: DroppedPayload = { entries: [], archives: [], flatFiles: [] };

  const entries: FileSystemEntryLike[] = [];
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.() as FileSystemEntryLike | null | undefined;
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) {
    for (const file of Array.from(dataTransfer.files ?? [])) {
      if (isArchive(file, file.name)) payload.archives.push(file);
      else if (file.name === SKILL_FILE_NAME) payload.entries.push({ path: file.name, file });
      else payload.flatFiles.push(file);
    }
    return payload;
  }

  for (const entry of entries) {
    await walk(entry, '', payload);
  }
  return payload;
}
