/**
 * File storage change notifications.
 *
 * Every view of the stored files — the preview tab, the options file manager, the
 * side panel's conversation list — used to be either load-once or driven by a
 * 3-second poll, because IndexedDB emits no change event. The fix depends on one
 * invariant: a write or delete through `fileStorage` always announces itself.
 *
 * The announcement lives in the storage layer rather than in the MCP tools
 * precisely so this test can be about *all* writers. `file_write`, `file_edit`
 * and `file_patch` are three of them; the options page deletes files too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onEvent, resetEventBusForTests, type LumoEventMap } from '@/lib/event-bus';

/**
 * Minimal three-store IndexedDB stand-in: `files` (content), `meta` (metadata),
 * `dirs` (directories).
 *
 * The IndexedDB layer is stubbed at the `openDB` boundary rather than run through
 * `fake-indexeddb`, whose structured clone drops Blob identity — the caveat
 * `checkpoint-storage.test.ts` records. What matters here is that each write
 * reaches both stores and that the success path emits.
 */
type Row = Record<string, unknown>;

const stores: Record<string, Map<string, Row>> = {
  files: new Map(),
  meta: new Map(),
  dirs: new Map(),
};

function fakeRequest<T>(thunk: () => T) {
  const request: Record<string, unknown> = { result: undefined, onsuccess: null, onerror: null };
  // Fire on the next microtask, as IndexedDB does.
  void Promise.resolve().then(() => {
    try {
      request.result = thunk();
      (request.onsuccess as (() => void) | null)?.();
    } catch (error) {
      request.error = error;
      (request.onerror as (() => void) | null)?.();
    }
  });
  return request;
}

function fakeStore(name: string) {
  const rows = stores[name]!;
  const keyOf = (value: Row) => String(value.name ?? value.path);
  return {
    put: (value: Row) => fakeRequest(() => {
      rows.set(keyOf(value), value);
    }),
    delete: (key: string) => fakeRequest(() => {
      rows.delete(key);
    }),
    get: (key: string) => fakeRequest(() => rows.get(key)),
    count: (key: string) => fakeRequest(() => (rows.has(key) ? 1 : 0)),
    getAllKeys: () => fakeRequest(() => [...rows.keys()]),
    getAll: () => fakeRequest(() => [...rows.values()]),
    clear: () => fakeRequest(() => {
      rows.clear();
    }),
  };
}

vi.stubGlobal('indexedDB', {
  open: () => {
    const db = {
      objectStoreNames: { contains: () => true },
      transaction: (names: string | string[]) => {
        const requested = Array.isArray(names) ? names : [names];
        const tx: Record<string, unknown> = {
          objectStore: (name: string) => fakeStore(name),
          oncomplete: null,
          onerror: null,
          onabort: null,
        };
        // IndexedDB completes a transaction after the task that issued its
        // requests, never synchronously.
        setTimeout(() => (tx.oncomplete as (() => void) | null)?.(), 0);
        void requested;
        return tx;
      },
    };
    return fakeRequest(() => db);
  },
});

const { fileStorage } = await import('@/lib/mcp/file-storage');

let events: LumoEventMap['files:changed'][] = [];
let off: (() => void) | null = null;

beforeEach(() => {
  for (const rows of Object.values(stores)) rows.clear();
  events = [];
  off = onEvent('files:changed', (payload) => events.push(payload));
});

afterEach(() => {
  off?.();
  resetEventBusForTests();
});

describe('fileStorage change notifications', () => {
  it('announces a newly written file', async () => {
    await fileStorage.writeFile('notes.md', '# hello');
    expect(events).toEqual([{ names: ['notes.md'], reason: 'write' }]);
  });

  it('announces an overwrite, since a preview of that file is now stale', async () => {
    await fileStorage.writeFile('notes.md', 'v1');
    await fileStorage.writeFile('notes.md', 'v2');
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ names: ['notes.md'], reason: 'write' });
  });

  it('announces a delete', async () => {
    await fileStorage.writeFile('notes.md', 'x');
    events = [];
    await fileStorage.deleteFile('notes.md');
    expect(events).toEqual([{ names: ['notes.md'], reason: 'delete' }]);
  });

  it('names the file so a single-file view can ignore unrelated writes', async () => {
    await fileStorage.writeFile('other.md', 'x');
    // This is what lets the preview tab for notes.md skip the reload entirely.
    expect(events[0]!.names).toEqual(['other.md']);
  });

  it('announces every file in a batch of writes', async () => {
    await fileStorage.writeFile('a.md', 'x');
    await fileStorage.writeFile('b.md', 'y');
    expect(events.flatMap((e) => e.names)).toEqual(['a.md', 'b.md']);
  });

  it('does not announce a read', async () => {
    await fileStorage.writeFile('notes.md', 'x');
    events = [];
    await fileStorage.readFileAsText('notes.md');
    await fileStorage.exists('notes.md');
    expect(events).toEqual([]);
  });

  it('names every file a bulk clear removed', async () => {
    await fileStorage.writeFile('a.md', 'x');
    await fileStorage.writeFile('b.md', 'y');
    events = [];

    const removed = await fileStorage.clearFiles();

    expect(removed).toBe(2);
    // One event listing everything, not one per file: a single-file view still
    // has to find its own name in the list to know it is now stale. The order
    // within the list is not part of that contract.
    expect(events).toHaveLength(1);
    expect([...events[0]!.names].sort()).toEqual(['a.md', 'b.md']);
    expect(events[0]!.reason).toBe('delete');
  });

  it('says nothing when a clear removed nothing', async () => {
    expect(await fileStorage.clearFiles()).toBe(0);
    expect(events).toEqual([]);
  });
});

describe('fileStorage.restoreFiles', () => {
  const blob = (text: string) => new Blob([text], { type: 'text/plain' });
  const entry = (name: string, text: string) => ({
    name,
    content: blob(text),
    mimeType: 'text/plain',
    createdAt: 100,
    updatedAt: 200,
  });

  it('writes a whole batch in one transaction and announces it once', async () => {
    await fileStorage.restoreFiles([entry('a.md', 'a'), entry('b.md', 'b')]);

    expect(events).toEqual([{ names: ['a.md', 'b.md'], reason: 'write' }]);
    expect((await fileStorage.listFiles()).map((file) => file.name).sort()).toEqual([
      'a.md',
      'b.md',
    ]);
  });

  it('renames a colliding user file instead of overwriting it', async () => {
    await fileStorage.writeFile('notes.md', 'original');
    events = [];

    const result = await fileStorage.restoreFiles([entry('notes.md', 'restored')]);

    expect(result.imported).toEqual(['notes (1).md']);
    expect(result.skipped).toEqual([]);
    expect(await fileStorage.readFileAsText('notes.md')).toBe('original');
    expect(await fileStorage.readFileAsText('notes (1).md')).toBe('restored');
  });

  it('skips a colliding system file rather than corrupting a skill directory', async () => {
    await fileStorage.writeFile('skills/foo/SKILL.md', 'installed');
    events = [];

    const result = await fileStorage.restoreFiles([
      entry('skills/foo/SKILL.md', 'restored'),
    ]);

    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual(['skills/foo/SKILL.md']);
    expect(await fileStorage.readFileAsText('skills/foo/SKILL.md')).toBe('installed');
    // Nothing was written, so nothing should claim to have changed.
    expect(events).toEqual([]);
  });

  it('restores the exact path when overwrite is requested', async () => {
    await fileStorage.writeFile('notes.md', 'original');
    events = [];

    const result = await fileStorage.restoreFiles([entry('notes.md', 'restored')], [], {
      overwrite: true,
    });

    expect(result.imported).toEqual(['notes.md']);
    expect(await fileStorage.readFileAsText('notes.md')).toBe('restored');
  });
});
