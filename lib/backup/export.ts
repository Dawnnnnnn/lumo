/**
 * Build a Lumo backup archive.
 *
 * The archive is assembled in memory and downloaded as one Blob. That is a
 * deliberate simplicity trade: a backup is a bounded user action rather than a
 * hot path, and an in-memory zip keeps the write atomic — a half-written archive
 * is never offered for download.
 */
import { zipSync } from 'fflate';
import { exportConversationData } from '@/lib/conversation-store';
import { getExtensionVersion } from '@/lib/extension-info';
import { fileStorage } from '@/lib/mcp/file-storage';
import { sha256Hex } from '@/lib/hash';
import { storage } from '@/store/storage';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  CONFIG_PATH,
  CONVERSATION_BLOB_DIR,
  CONVERSATION_INDEX_PATH,
  CONVERSATION_RECORD_DIR,
  FILE_DATA_PREFIX,
  FILE_INDEX_PATH,
  MANIFEST_PATH,
  emptyStats,
  encodeJson,
} from './archive';
import type {
  BackupConversationIndex,
  BackupFileIndex,
  BackupGroup,
  BackupManifest,
  BackupSelection,
  BackupStats,
  BackupDirectoryEntry,
} from './types';

export interface BackupBuildResult {
  blob: Blob;
  filename: string;
  manifest: BackupManifest;
  stats: BackupStats;
}

/** `lumo-backup-2026-11-06T15-30-00.zip`, safe on every desktop filesystem. */
export function backupFilename(at = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `lumo-backup-${stamp}.zip`;
}

function selectedGroups(selection: BackupSelection): BackupGroup[] {
  return (['conversations', 'files', 'config'] as BackupGroup[]).filter(
    (group) => selection[group],
  );
}

/**
 * Bundle the selected data sources into a zip.
 *
 * A file that cannot be read is logged and omitted rather than failing the whole
 * export: one stale metadata row must not cost the user their conversations. The
 * manifest's stats are computed from what actually made it into the archive, so
 * a partial export still describes itself honestly.
 */
export async function buildBackupZip(selection: BackupSelection): Promise<BackupBuildResult> {
  const entries: Record<string, Uint8Array> = {};
  const stats = emptyStats();
  const contents = selectedGroups(selection);

  if (selection.conversations) {
    const bundle = await exportConversationData();
    const index: BackupConversationIndex = { conversations: [], blobs: [] };

    for (const conversation of bundle.conversations) {
      // Hashed file name: conversation ids are UUIDs in practice, but the archive
      // must not depend on that. The index carries the real id.
      const file = `${CONVERSATION_RECORD_DIR}${await sha256Hex(conversation.id)}.json`;
      entries[file] = encodeJson(conversation);
      index.conversations.push({ id: conversation.id, file });
    }

    for (const blob of bundle.blobs) {
      const file = `${CONVERSATION_BLOB_DIR}${await sha256Hex(blob.id)}.bin`;
      entries[file] = new Uint8Array(await blob.blob.arrayBuffer());
      index.blobs.push({
        id: blob.id,
        file,
        mimeType: blob.blob.type || 'application/octet-stream',
        conversationId: blob.conversationId,
      });
    }

    entries[CONVERSATION_INDEX_PATH] = encodeJson(index);
    stats.conversations = index.conversations.length;
    stats.conversationBlobs = index.blobs.length;
  }

  if (selection.files) {
    // Scratch files are regenerable shell artefacts, not user documents. The
    // directory records follow the same rule, or a bare `tmp/` would still be
    // written into the archive after its files were excluded.
    const metadata = await fileStorage.listFiles({ includeTemp: false });
    const directories = await fileStorage.listDirectories({ includeTemp: false });
    const index: BackupFileIndex = { files: [], directories: [] };

    for (const file of metadata) {
      const blob = await fileStorage.readFileAsBlob(file.name);
      if (!blob) {
        console.warn(`[backup] skipping unreadable file: ${file.name}`);
        continue;
      }

      const archivePath = `${FILE_DATA_PREFIX}${file.name}`;
      entries[archivePath] = new Uint8Array(await blob.arrayBuffer());
      index.files.push({
        name: file.name,
        file: archivePath,
        mimeType: file.mimeType,
        size: blob.size,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        ...(file.conversationId ? { conversationId: file.conversationId } : {}),
      });
      stats.fileBytes += blob.size;
    }

    for (const directory of directories) {
      index.directories.push({
        path: directory.path,
        explicit: directory.explicit,
        createdAt: directory.createdAt,
        updatedAt: directory.updatedAt,
      } satisfies BackupDirectoryEntry);
    }

    entries[FILE_INDEX_PATH] = encodeJson(index);
    stats.files = index.files.length;
  }

  if (selection.config) {
    entries[CONFIG_PATH] = encodeJson(await storage.exportConfig());
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: getExtensionVersion(),
    contents,
    stats,
  };
  entries[MANIFEST_PATH] = encodeJson(manifest);

  const zipped = zipSync(entries, { level: 6 });
  return {
    blob: new Blob([zipped], { type: 'application/zip' }),
    filename: backupFilename(),
    manifest,
    stats,
  };
}
