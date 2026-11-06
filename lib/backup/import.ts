/**
 * Parse, inspect and apply a Lumo backup archive.
 *
 * Parsing is separated from applying on purpose: the import dialog must be able
 * to say what the archive contains and how it collides with existing data before
 * the user commits to writing anything. `readBackupZip` never touches storage;
 * `inspectBackup` only reads; `applyBackup` is the single write entry point.
 */
import { listConversationMeta, importConversationData } from '@/lib/conversation-store';
import {
  fileStorage,
  normalizeDirPath,
  normalizeFilePath,
  type RestoreDirectoryEntry,
  type RestoreFileEntry,
} from '@/lib/mcp/file-storage';
import { storage } from '@/store/storage';
import {
  BackupError,
  CONFIG_PATH,
  CONVERSATION_BLOB_DIR,
  CONVERSATION_INDEX_PATH,
  CONVERSATION_RECORD_DIR,
  FILE_DATA_PREFIX,
  FILE_INDEX_PATH,
  parseManifest,
  normalizeArchivePath,
  readJsonEntry,
  readZipEntries,
  requireJsonEntry,
} from './archive';
import type {
  BackupConversationIndex,
  BackupDirectoryEntry,
  BackupFileIndex,
  BackupGroup,
  BackupImportResult,
  BackupInspection,
  BackupSelection,
  BackupStats,
  LoadedBackup,
  LoadedBackupBlob,
  LoadedBackupConversation,
  LoadedBackupFile,
} from './types';
import type { Conversation } from '@/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Copy zip bytes into a Blob without relying on the source buffer's type. */
function blobFromBytes(data: Uint8Array, type: string): Blob {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return new Blob([copy.buffer], { type });
}

/**
 * Minimal structural check for an imported conversation.
 *
 * This is not a full message validator — the render path already tolerates
 * unknown parts, and duplicating that schema here would make every future part
 * type a second-place edit. What it does enforce is everything the history list
 * and persistence layer dereference immediately: identity, timestamps, model
 * attribution and a message array.
 */
function isConversation(value: unknown): value is Conversation {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.title === 'string' &&
    Array.isArray(value.messages) &&
    value.messages.every(
      (message) =>
        isRecord(message) &&
        typeof message.role === 'string' &&
        (message.parts === undefined || Array.isArray(message.parts)),
    ) &&
    typeof value.modelId === 'string' &&
    typeof value.providerId === 'string' &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt)
  );
}

function requireArchivePath(path: string, prefix: string): string {
  const normalized = normalizeArchivePath(path);
  if (normalized === null || !normalized.startsWith(prefix)) {
    throw new BackupError('corrupt', `invalid archive path: ${path}`);
  }
  return normalized;
}

function parseConversations(
  entries: Record<string, Uint8Array>,
): { records: LoadedBackupConversation[]; blobs: LoadedBackupBlob[] } {
  const index = requireJsonEntry<unknown>(entries, CONVERSATION_INDEX_PATH);
  if (!isRecord(index)) throw new BackupError('corrupt', 'conversation index is not an object');

  const rawConversations = Array.isArray(index.conversations) ? index.conversations : null;
  const rawBlobs = Array.isArray(index.blobs) ? index.blobs : null;
  if (!rawConversations || !rawBlobs) {
    throw new BackupError('corrupt', 'conversation index is incomplete');
  }

  const records: LoadedBackupConversation[] = [];
  const seen = new Set<string>();
  for (const raw of rawConversations) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.file !== 'string') {
      throw new BackupError('corrupt', 'invalid conversation entry');
    }
    if (seen.has(raw.id)) throw new BackupError('corrupt', `duplicate conversation id: ${raw.id}`);
    seen.add(raw.id);

    const file = requireArchivePath(raw.file, CONVERSATION_RECORD_DIR);
    const data = entries[file];
    if (data === undefined) throw new BackupError('corrupt', `missing conversation record: ${file}`);

    let conversation: unknown;
    try {
      conversation = JSON.parse(new TextDecoder().decode(data));
    } catch {
      throw new BackupError('corrupt', `invalid conversation JSON: ${file}`);
    }
    if (!isConversation(conversation) || conversation.id !== raw.id) {
      throw new BackupError('corrupt', `invalid conversation record: ${file}`);
    }
    records.push({ id: raw.id, conversation });
  }

  const blobs: LoadedBackupBlob[] = [];
  for (const raw of rawBlobs) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== 'string' ||
      typeof raw.file !== 'string' ||
      typeof raw.mimeType !== 'string' ||
      typeof raw.conversationId !== 'string'
    ) {
      throw new BackupError('corrupt', 'invalid conversation screenshot entry');
    }

    const file = requireArchivePath(raw.file, CONVERSATION_BLOB_DIR);
    const data = entries[file];
    if (data === undefined) throw new BackupError('corrupt', `missing conversation screenshot: ${file}`);
    blobs.push({
      id: raw.id,
      conversationId: raw.conversationId,
      mimeType: raw.mimeType,
      blob: blobFromBytes(data, raw.mimeType),
    });
  }

  return { records, blobs };
}

function parseFiles(
  entries: Record<string, Uint8Array>,
): { files: LoadedBackupFile[]; directories: BackupDirectoryEntry[] } {
  const index = requireJsonEntry<unknown>(entries, FILE_INDEX_PATH);
  if (!isRecord(index)) throw new BackupError('corrupt', 'file index is not an object');

  const rawFiles = Array.isArray(index.files) ? index.files : null;
  if (!rawFiles) throw new BackupError('corrupt', 'file index is incomplete');

  const files: LoadedBackupFile[] = [];
  const names = new Set<string>();
  for (const raw of rawFiles) {
    if (
      !isRecord(raw) ||
      typeof raw.name !== 'string' ||
      typeof raw.file !== 'string' ||
      typeof raw.mimeType !== 'string' ||
      !isFiniteNumber(raw.size) ||
      !isFiniteNumber(raw.createdAt) ||
      !isFiniteNumber(raw.updatedAt)
    ) {
      throw new BackupError('corrupt', 'invalid file entry');
    }

    const name = normalizeFilePath(raw.name);
    if (name === null) throw new BackupError('corrupt', `invalid file name: ${raw.name}`);
    if (names.has(name)) throw new BackupError('corrupt', `duplicate file: ${name}`);
    names.add(name);

    const file = requireArchivePath(raw.file, FILE_DATA_PREFIX);
    const data = entries[file];
    if (data === undefined) throw new BackupError('corrupt', `missing file data: ${file}`);

    files.push({
      name,
      file,
      mimeType: raw.mimeType,
      size: raw.size,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      ...(typeof raw.conversationId === 'string' ? { conversationId: raw.conversationId } : {}),
      content: blobFromBytes(data, raw.mimeType),
    });
  }

  const directories: BackupDirectoryEntry[] = [];
  const rawDirectories = Array.isArray(index.directories) ? index.directories : [];
  for (const raw of rawDirectories) {
    if (
      !isRecord(raw) ||
      typeof raw.path !== 'string' ||
      typeof raw.explicit !== 'boolean' ||
      !isFiniteNumber(raw.createdAt) ||
      !isFiniteNumber(raw.updatedAt)
    ) {
      throw new BackupError('corrupt', 'invalid directory entry');
    }
    const path = normalizeDirPath(raw.path);
    if (path === null || path === '') {
      throw new BackupError('corrupt', `invalid directory path: ${raw.path}`);
    }
    directories.push({
      path,
      explicit: raw.explicit,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  }

  return { files, directories };
}

/** Parse a zip's bytes into the data sources it actually contains. */
export function readBackupZip(bytes: Uint8Array): LoadedBackup {
  const entries = readZipEntries(bytes);
  const manifest = parseManifest(entries);
  const contents = new Set<BackupGroup>(manifest.contents);

  let config: LoadedBackup['config'] = null;
  if (contents.has('config')) {
    const raw = readJsonEntry<unknown>(entries, CONFIG_PATH);
    if (!isRecord(raw)) throw new BackupError('corrupt', 'missing or invalid configuration');
    config = raw;
  }

  const conversations = contents.has('conversations') ? parseConversations(entries) : null;
  const files = contents.has('files') ? parseFiles(entries) : null;

  return { manifest, config, conversations, files };
}

/** Read an uploaded file into an archive. */
export async function readBackupFile(file: Blob): Promise<LoadedBackup> {
  return readBackupZip(new Uint8Array(await file.arrayBuffer()));
}

function actualStats(archive: LoadedBackup): BackupStats {
  return {
    conversations: archive.conversations?.records.length ?? 0,
    conversationBlobs: archive.conversations?.blobs.length ?? 0,
    files: archive.files?.files.length ?? 0,
    fileBytes: archive.files?.files.reduce((sum, file) => sum + file.size, 0) ?? 0,
  };
}

/**
 * Compare the archive against what is already stored.
 *
 * Only reads: the result drives the dialog's conflict switch and its counts, so
 * the user sees the cost of an import before it happens.
 */
export async function inspectBackup(archive: LoadedBackup): Promise<BackupInspection> {
  const available = archive.manifest.contents.filter((group) => {
    if (group === 'config') return archive.config !== null;
    if (group === 'conversations') return archive.conversations !== null;
    return archive.files !== null;
  });

  const [existingConversations, existingFiles] = await Promise.all([
    available.includes('conversations') ? listConversationMeta() : Promise.resolve([]),
    available.includes('files') ? fileStorage.listFiles() : Promise.resolve([]),
  ]);

  const conversationIds = new Set(existingConversations.map((meta) => meta.id));
  const fileNames = new Set(existingFiles.map((file) => file.name));

  return {
    available,
    stats: actualStats(archive),
    conflicts: {
      conversations:
        archive.conversations?.records.filter((record) => conversationIds.has(record.id))
          .length ?? 0,
      files: archive.files?.files.filter((file) => fileNames.has(file.name)).length ?? 0,
    },
  };
}

/** Write the selected groups from an archive into storage. */
export async function applyBackup(
  archive: LoadedBackup,
  selection: BackupSelection,
  { overwrite = false }: { overwrite?: boolean } = {},
): Promise<BackupImportResult> {
  const result: BackupImportResult = {
    config: false,
    conversations: { imported: 0, skipped: 0 },
    files: { imported: 0, skipped: 0 },
  };

  if (selection.conversations && archive.conversations) {
    const written = await importConversationData(
      archive.conversations.records.map((record) => record.conversation),
      archive.conversations.blobs.map((blob) => ({
        id: blob.id,
        conversationId: blob.conversationId,
        blob: blob.blob,
      })),
      { overwrite },
    );
    result.conversations = written;
  }

  if (selection.files && archive.files) {
    const fileEntries: RestoreFileEntry[] = archive.files.files.map((file) => ({
      name: file.name,
      content: file.content,
      mimeType: file.mimeType,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      ...(file.conversationId ? { conversationId: file.conversationId } : {}),
    }));
    const directoryEntries: RestoreDirectoryEntry[] = archive.files.directories.map((directory) => ({
      path: directory.path,
      explicit: directory.explicit,
      createdAt: directory.createdAt,
      updatedAt: directory.updatedAt,
    }));
    const written = await fileStorage.restoreFiles(fileEntries, directoryEntries, { overwrite });
    result.files = { imported: written.imported.length, skipped: written.skipped.length };
  }

  if (selection.config && archive.config) {
    await storage.importConfig(archive.config);
    result.config = true;
  }

  return result;
}
