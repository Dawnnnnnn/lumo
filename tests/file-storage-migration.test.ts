/**
 * The v1 → v2 file storage upgrade.
 *
 * Version 2 added a `meta` store (so listing never deserialises blobs) and a
 * `dirs` store (so a directory can exist while empty). Existing installs have
 * nothing in either, and every read now goes to `meta` — a backfill that silently
 * skipped a file would make that file disappear from the file manager, the `@`
 * picker and the skills index at once.
 *
 * Unlike the other storage tests this one runs the real IndexedDB implementation
 * (`fake-indexeddb`): the thing under test is the upgrade transaction itself, so
 * a hand-written stub could not exercise it.
 */
import { describe, expect, it, vi } from 'vitest';

const { indexedDB: fakeIndexedDB, IDBKeyRange: FakeKeyRange } = await import('fake-indexeddb');
vi.stubGlobal('indexedDB', fakeIndexedDB);
vi.stubGlobal('IDBKeyRange', FakeKeyRange);

/** Seed a v1 database: one legacy file inside a nested directory. */
async function seedVersionOne(): Promise<void> {
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = fakeIndexedDB.open('lumo-files', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.createObjectStore('files', { keyPath: 'name' });
      store.createIndex('createdAt', 'metadata.createdAt');
      store.createIndex('conversationId', 'metadata.conversationId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  await new Promise<void>((resolve, reject) => {
    const tx = legacy.transaction('files', 'readwrite');
    tx.objectStore('files').put({
      name: 'skills/pdf-tools/SKILL.md',
      content: new Blob(['# legacy']),
      metadata: {
        name: 'skills/pdf-tools/SKILL.md',
        mimeType: 'text/markdown',
        size: 9,
        createdAt: 1000,
        updatedAt: 1000,
        conversationId: 'conversation-1',
      },
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  legacy.close();
}

describe('file storage upgrade from v1', () => {
  it('backfills metadata and directories for files written before the upgrade', async () => {
    await seedVersionOne();

    const { fileStorage } = await import('@/lib/mcp/file-storage');

    // Reading a file now goes through the metadata store, so this read is the
    // proof that the backfill ran.
    const metadata = await fileStorage.getMetadata('skills/pdf-tools/SKILL.md');
    expect(metadata).toMatchObject({
      name: 'skills/pdf-tools/SKILL.md',
      mimeType: 'text/markdown',
      createdAt: 1000,
    });

    const listed = await fileStorage.listFiles();
    expect(listed.map((file) => file.name)).toEqual(['skills/pdf-tools/SKILL.md']);

    // Directories are derived from paths rather than migrated: the `dirs` store
    // only holds directories created on purpose.
    expect(await fileStorage.listDirectories()).toEqual([]);
    expect((await fileStorage.listDirectory('skills/')).directories).toEqual([
      'skills/pdf-tools/',
    ]);

    // The content record itself is untouched by the upgrade.
    expect(await fileStorage.exists('skills/pdf-tools/SKILL.md')).toBe(true);
  });
});
