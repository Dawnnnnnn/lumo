/**
 * The portable shape of a Lumo backup.
 *
 * A backup is a zip rather than a JSON file because two of the three things it
 * carries are binary: stored documents and the screenshots a tool call produced.
 * The archive is laid out as one directory per data source, plus a manifest that
 * says what the bundle contains and which format version wrote it.
 *
 * Everything that crosses the archive boundary is declared here. The exporter and
 * importer share these types so a field cannot be added to one side and silently
 * forgotten on the other.
 */
import type { AppConfig } from '@/store/storage';

/** The three independently selectable groups of data. */
export type BackupGroup = 'conversations' | 'files' | 'config';

/** A selection of groups to export or import. */
export type BackupSelection = Record<BackupGroup, boolean>;

/** What a backup contains, as reported in the manifest and the UI. */
export interface BackupStats {
  conversations: number;
  /** Screenshots kept outside the conversation JSON. */
  conversationBlobs: number;
  files: number;
  fileBytes: number;
}

/**
 * Top-level manifest, always at `manifest.json`.
 *
 * `version` names the archive layout, not the extension version. It exists so a
 * future build can refuse an archive it does not understand instead of importing
 * half of it.
 */
export interface BackupManifest {
  format: 'lumo-backup';
  version: 1;
  createdAt: string;
  appVersion: string;
  contents: BackupGroup[];
  stats: BackupStats;
}

/** A conversation record inside `conversations/records/`. */
export interface BackupConversationEntry {
  id: string;
  file: string;
}

/**
 * A screenshot inside `conversations/blobs/`.
 *
 * File names are content-addressed hashes rather than the blob id, because blob
 * ids contain `:` (`conversation:message:toolCall:index`) and would be invalid
 * paths on Windows. The id lives here and is what the record references.
 */
export interface BackupConversationBlobEntry {
  id: string;
  file: string;
  mimeType: string;
  conversationId: string;
}

/** Index at `conversations/index.json`. */
export interface BackupConversationIndex {
  conversations: BackupConversationEntry[];
  blobs: BackupConversationBlobEntry[];
}

/** A stored file inside `files/data/`. */
export interface BackupFileEntry {
  name: string;
  file: string;
  mimeType: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  conversationId?: string;
}

/** An explicitly created directory, so an empty one survives a round trip. */
export interface BackupDirectoryEntry {
  path: string;
  explicit: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Index at `files/manifest.json`. */
export interface BackupFileIndex {
  files: BackupFileEntry[];
  directories: BackupDirectoryEntry[];
}

/** One file restored from the archive, with its bytes attached. */
export interface LoadedBackupFile extends BackupFileEntry {
  content: Blob;
}

/** A conversation record restored from the archive. */
export interface LoadedBackupConversation {
  id: string;
  conversation: import('@/types').Conversation;
}

/** A screenshot restored from the archive. */
export interface LoadedBackupBlob {
  id: string;
  conversationId: string;
  mimeType: string;
  blob: Blob;
}

/** A fully parsed archive, ready to be inspected and applied. */
export interface LoadedBackup {
  manifest: BackupManifest;
  config: AppConfig | null;
  conversations: {
    records: LoadedBackupConversation[];
    blobs: LoadedBackupBlob[];
  } | null;
  files: {
    files: LoadedBackupFile[];
    directories: BackupDirectoryEntry[];
  } | null;
}

/** What the import dialog shows before anything is written. */
export interface BackupInspection {
  available: BackupGroup[];
  stats: BackupStats;
  conflicts: {
    conversations: number;
    files: number;
  };
}

/** Outcome of applying an archive. */
export interface BackupImportResult {
  config: boolean;
  conversations: {
    imported: number;
    skipped: number;
  };
  files: {
    imported: number;
    skipped: number;
  };
}
