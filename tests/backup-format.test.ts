/**
 * Backup archive format, export wiring and inspection.
 *
 * The disk-backed stores are mocked here on purpose: what these tests protect is
 * the archive contract — every data source appears in the right directory, the
 * manifest describes what was actually written, and reading validates the parts
 * that are dangerous (paths, versions, references). The storage-specific write
 * paths are covered by their own tests.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { strToU8, zipSync, unzipSync, strFromU8 } from 'fflate';

const RED_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

const mocks = vi.hoisted(() => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  return ({
  conversations: [
    {
      id: 'conv-1',
      title: 'First chat',
      messages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'text', text: 'hello', state: 'done' }],
          timestamp: 1,
        },
      ],
      modelId: 'gpt-4o',
      providerId: 'openai',
      createdAt: 1,
      updatedAt: 2,
    },
  ],
  blobs: [
    {
      id: 'conv-1:m1:tool-1:0',
      conversationId: 'conv-1',
      blob: new Blob([png], { type: 'image/png' }),
    },
  ],
  files: [
    {
      name: 'notes/report.md',
      mimeType: 'text/markdown',
      size: 5,
      createdAt: 10,
      updatedAt: 11,
    },
    {
      name: 'images/dot.png',
      mimeType: 'image/png',
      size: png.length,
      createdAt: 12,
      updatedAt: 13,
      conversationId: 'conv-1',
    },
  ],
  directories: [
    { path: 'empty/', kind: 'user', explicit: true, createdAt: 1, updatedAt: 1 },
  ],
  importConversations: vi.fn(
    async (
      _conversations: unknown[],
      _blobs: unknown[],
      _options?: { overwrite?: boolean },
    ) => ({ imported: 1, skipped: 0 }),
  ),
  restoreFiles: vi.fn(
    async (
      _files: unknown[],
      _directories: unknown[],
      _options?: { overwrite?: boolean },
    ) => ({ imported: ['notes/report.md'], skipped: [] }),
  ),
  importConfig: vi.fn(async () => undefined),
  });
});

vi.mock('@/lib/conversation-store', () => ({
  exportConversationData: async () => ({
    conversations: mocks.conversations,
    blobs: mocks.blobs,
  }),
  listConversationMeta: async () => [{ id: 'conv-1', title: 'Existing' }],
  importConversationData: mocks.importConversations,
}));

vi.mock('@/lib/mcp/file-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp/file-storage')>();
  return {
    ...actual,
    fileStorage: {
      listFiles: async () => mocks.files,
      listDirectories: async () => mocks.directories,
      readFileAsBlob: async (name: string) =>
        name.endsWith('.md')
          ? new Blob(['hello'], { type: 'text/markdown' })
          : new Blob([RED_PNG], { type: 'image/png' }),
      restoreFiles: mocks.restoreFiles,
    },
  };
});

vi.mock('@/store/storage', () => ({
  storage: {
    exportConfig: async () => ({ uiSettings: { language: 'en' } }),
    importConfig: mocks.importConfig,
  },
}));

vi.mock('@/lib/extension-info', () => ({
  getExtensionVersion: () => '1.0.22',
}));

const { buildBackupZip } = await import('@/lib/backup/export');
const { readBackupZip } = await import('@/lib/backup/import');
const { inspectBackup, applyBackup } = await import('@/lib/backup/import');
const { BackupError } = await import('@/lib/backup/archive');

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: 'lumo-backup',
    version: 1,
    createdAt: '2026-11-06T00:00:00.000Z',
    appVersion: '1.0.22',
    contents: ['config'],
    stats: { conversations: 0, conversationBlobs: 0, files: 0, fileBytes: 0 },
    ...overrides,
  });
}

beforeEach(() => {
  mocks.importConversations.mockClear();
  mocks.restoreFiles.mockClear();
  mocks.importConfig.mockClear();
});

describe('building a backup', () => {
  it('writes one directory per selected source and describes it in the manifest', async () => {
    const backup = await buildBackupZip({ conversations: true, files: true, config: true });
    const entries = unzipSync(new Uint8Array(await backup.blob.arrayBuffer()));
    const paths = Object.keys(entries).sort();

    expect(paths).toContain('manifest.json');
    expect(paths).toContain('config/config.json');
    expect(paths).toContain('conversations/index.json');
    expect(paths).toContain('files/manifest.json');
    expect(paths.some((path) => path.startsWith('conversations/records/'))).toBe(true);
    expect(paths.some((path) => path.startsWith('conversations/blobs/'))).toBe(true);
    expect(paths).toContain('files/data/notes/report.md');
    expect(paths).toContain('files/data/images/dot.png');

    expect(backup.manifest.contents).toEqual(['conversations', 'files', 'config']);
    expect(backup.stats).toEqual({
      conversations: 1,
      conversationBlobs: 1,
      files: 2,
      fileBytes: 16,
    });
    expect(backup.filename).toMatch(/^lumo-backup-.*\.zip$/);

    const parsed = readBackupZip(new Uint8Array(await backup.blob.arrayBuffer()));
    expect(parsed.config).toEqual({ uiSettings: { language: 'en' } });
    expect(parsed.conversations?.records[0]!.conversation.title).toBe('First chat');
    expect(parsed.conversations?.blobs[0]!.id).toBe('conv-1:m1:tool-1:0');
    expect(parsed.conversations?.blobs[0]!.blob.type).toBe('image/png');
    expect(parsed.files?.files.find((file) => file.name === 'notes/report.md')?.content.size).toBe(5);
    expect(parsed.files?.directories[0]!.path).toBe('empty/');
  });

  it('omits unselected sources entirely', async () => {
    const backup = await buildBackupZip({ conversations: false, files: false, config: true });
    const entries = unzipSync(new Uint8Array(await backup.blob.arrayBuffer()));
    const paths = Object.keys(entries);

    expect(paths).toContain('config/config.json');
    expect(paths.some((path) => path.startsWith('conversations/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('files/'))).toBe(false);
    expect(backup.manifest.contents).toEqual(['config']);
  });
});

describe('reading a backup', () => {
  it('pairs the archive with existing data for the import dialog', async () => {
    const backup = await buildBackupZip({ conversations: true, files: true, config: true });
    const parsed = readBackupZip(new Uint8Array(await backup.blob.arrayBuffer()));

    const inspection = await inspectBackup(parsed);

    expect(inspection.available).toEqual(['conversations', 'files', 'config']);
    // The mocked store already contains conv-1 and both archived files.
    expect(inspection.conflicts).toEqual({ conversations: 1, files: 2 });
    expect(inspection.stats.conversations).toBe(1);
  });

  it('rejects an archive written by a newer format version', () => {
    const bytes = zipSync({
      'manifest.json': strToU8(manifest({ version: 99 })),
    });

    expect(() => readBackupZip(bytes)).toThrowError(BackupError);
    try {
      readBackupZip(bytes);
    } catch (error) {
      expect((error as InstanceType<typeof BackupError>).code).toBe('unsupported-version');
    }
  });

  it('rejects a file whose manifest path escapes the file directory', () => {
    const bytes = zipSync({
      'manifest.json': strToU8(
        manifest({
          contents: ['files'],
          stats: { conversations: 0, conversationBlobs: 0, files: 1, fileBytes: 1 },
        }),
      ),
      'files/manifest.json': strToU8(
        JSON.stringify({
          files: [
            {
              name: 'a.md',
              file: 'files/data/../config/config.json',
              mimeType: 'text/markdown',
              size: 1,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          directories: [],
        }),
      ),
    });

    expect(() => readBackupZip(bytes)).toThrowError(/invalid archive path/);
  });

  it('rejects a missing manifest', () => {
    const bytes = zipSync({ 'config/config.json': strToU8('{}') });
    expect(() => readBackupZip(bytes)).toThrowError(/manifest/);
  });
});

describe('applying a backup', () => {
  it('routes each selected group to its storage layer and honours overwrite', async () => {
    const backup = await buildBackupZip({ conversations: true, files: true, config: true });
    const parsed = readBackupZip(new Uint8Array(await backup.blob.arrayBuffer()));

    const result = await applyBackup(
      parsed,
      { conversations: true, files: true, config: true },
      { overwrite: true },
    );

    expect(mocks.importConversations).toHaveBeenCalledOnce();
    expect(mocks.importConversations.mock.calls[0]![2]).toEqual({ overwrite: true });
    const blobs = mocks.importConversations.mock.calls[0]![1] as Array<{ id: string }>;
    expect(blobs[0]!.id).toBe('conv-1:m1:tool-1:0');

    expect(mocks.restoreFiles).toHaveBeenCalledOnce();
    expect(mocks.restoreFiles.mock.calls[0]![2]).toEqual({ overwrite: true });
    expect(mocks.importConfig).toHaveBeenCalledOnce();
    expect(result).toEqual({
      config: true,
      conversations: { imported: 1, skipped: 0 },
      files: { imported: 1, skipped: 0 },
    });
  });

  it('does not touch a source left unselected', async () => {
    const backup = await buildBackupZip({ conversations: true, files: true, config: true });
    const parsed = readBackupZip(new Uint8Array(await backup.blob.arrayBuffer()));

    await applyBackup(parsed, { conversations: false, files: false, config: true });

    expect(mocks.importConversations).not.toHaveBeenCalled();
    expect(mocks.restoreFiles).not.toHaveBeenCalled();
    expect(mocks.importConfig).toHaveBeenCalledOnce();
  });
});

describe('archive serialisation', () => {
  it('writes UTF-8 JSON that can be read back', async () => {
    const backup = await buildBackupZip({ conversations: true, files: false, config: false });
    const entries = unzipSync(new Uint8Array(await backup.blob.arrayBuffer()));
    const index = JSON.parse(strFromU8(entries['conversations/index.json']!));
    expect(index.conversations[0].id).toBe('conv-1');
    expect(index.blobs[0].conversationId).toBe('conv-1');
  });
});
