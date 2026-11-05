/**
 * Directory semantics over the path-keyed file store.
 *
 * A stored path *is* the key, and directories are a view over those keys plus an
 * explicit `dirs` store. What matters, and what these tests pin down:
 *
 * - `..` is rejected rather than resolved, so a malformed tool argument cannot
 *   address a file outside the directory it named;
 * - a directory exists while it is empty only if it was created on purpose;
 * - a move fails instead of merging when the target is taken;
 * - "clear all files" leaves `skills/` alone, because a skill is an installed
 *   capability, not a document.
 *
 * IndexedDB is stubbed at `openDB` for the same reason as
 * `file-storage-events.test.ts`: `fake-indexeddb` drops Blob identity, and the
 * content round-trip is one of the behaviours under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onEvent, resetEventBusForTests } from '@/lib/event-bus';

type Row = Record<string, unknown>;

const stores: Record<string, Map<string, Row>> = {
  files: new Map(),
  meta: new Map(),
  dirs: new Map(),
};

function fakeRequest<T>(thunk: () => T) {
  const request: Record<string, unknown> = { result: undefined, onsuccess: null, onerror: null };
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
        void (Array.isArray(names) ? names : [names]);
        const tx: Record<string, unknown> = {
          objectStore: (name: string) => fakeStore(name),
          oncomplete: null,
          onerror: null,
          onabort: null,
        };
        setTimeout(() => (tx.oncomplete as (() => void) | null)?.(), 0);
        return tx;
      },
    };
    return fakeRequest(() => db);
  },
});

const {
  baseName,
  directoryKind,
  fileStorage,
  isSystemPath,
  normalizeDirPath,
  normalizeFilePath,
  parentDirPath,
} = await import('@/lib/mcp/file-storage');

beforeEach(() => {
  for (const rows of Object.values(stores)) rows.clear();
});

afterEach(() => {
  resetEventBusForTests();
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe('path normalisation', () => {
  it('collapses redundant separators so one file has one key', () => {
    expect(normalizeFilePath('//notes/./a.md')).toBe('notes/a.md');
    expect(normalizeFilePath('notes\\a.md')).toBe('notes/a.md');
    expect(normalizeFilePath('  notes/a.md  ')).toBe('notes/a.md');
  });

  it('rejects `..` instead of resolving it', () => {
    expect(normalizeFilePath('../secrets.md')).toBeNull();
    expect(normalizeFilePath('notes/../../secrets.md')).toBeNull();
  });

  it('rejects an empty path', () => {
    expect(normalizeFilePath('/')).toBeNull();
    expect(normalizeFilePath('   ')).toBeNull();
  });

  it('keeps a trailing slash on directories and represents the root as empty', () => {
    expect(normalizeDirPath('skills/demo')).toBe('skills/demo/');
    expect(normalizeDirPath('/skills/demo/')).toBe('skills/demo/');
    expect(normalizeDirPath('')).toBe('');
    expect(normalizeDirPath('/')).toBe('');
  });

  it('splits parent and base names', () => {
    expect(parentDirPath('skills/demo/SKILL.md')).toBe('skills/demo/');
    expect(parentDirPath('a.md')).toBe('');
    expect(baseName('skills/demo/SKILL.md')).toBe('SKILL.md');
    expect(baseName('skills/demo/')).toBe('demo');
  });

  it('marks the extension-owned namespace as system', () => {
    expect(isSystemPath('skills/demo/SKILL.md')).toBe(true);
    expect(isSystemPath('skills/')).toBe(true);
    expect(isSystemPath('skillsnotes.md')).toBe(false);
    expect(directoryKind('skills/demo/')).toBe('system');
    expect(directoryKind('notes/')).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// Directory view
// ---------------------------------------------------------------------------

describe('directories', () => {
  it('derives parent directories from written paths instead of recording them', async () => {
    await fileStorage.writeFile('skills/demo/references/a.md', 'x');

    // Nothing was created on purpose, so nothing is recorded: a directory made
    // only of files must disappear with its last file.
    expect(await fileStorage.listDirectories()).toEqual([]);

    const skills = await fileStorage.listDirectory('skills/');
    expect(skills.directories).toEqual(['skills/demo/']);
    expect(skills.files).toEqual([]);

    const references = await fileStorage.listDirectory('skills/demo/');
    expect(references.directories).toEqual(['skills/demo/references/']);
  });

  it('lists only the immediate children of a directory', async () => {
    await fileStorage.writeFile('skills/demo/SKILL.md', 'x');
    await fileStorage.writeFile('skills/demo/references/a.md', 'y');
    await fileStorage.writeFile('skills/other/SKILL.md', 'z');
    await fileStorage.writeFile('notes.md', 'n');

    const root = await fileStorage.listDirectory('');
    expect(root.files.map((f) => f.name)).toEqual(['notes.md']);
    expect(root.directories).toEqual(['skills/']);

    const skills = await fileStorage.listDirectory('skills/');
    expect(skills.files).toEqual([]);
    expect(skills.directories).toEqual(['skills/demo/', 'skills/other/']);

    const demo = await fileStorage.listDirectory('skills/demo/');
    expect(demo.files.map((f) => f.name)).toEqual(['skills/demo/SKILL.md']);
    expect(demo.directories).toEqual(['skills/demo/references/']);
  });

  it('keeps a directory that was created while still empty', async () => {
    await fileStorage.createDirectory('skills/draft');
    const skills = await fileStorage.listDirectory('skills/');
    expect(skills.directories).toEqual(['skills/draft/']);
  });

  it('refuses to delete a directory that still holds files', async () => {
    await fileStorage.writeFile('skills/demo/SKILL.md', 'x');
    await expect(fileStorage.deleteDirectory('skills/demo/')).rejects.toThrow(/not empty/);
  });

  it('lists a directory prefix without its sibling', async () => {
    await fileStorage.writeFile('skills/demo/SKILL.md', 'x');
    await fileStorage.writeFile('skills/demo-two/SKILL.md', 'y');
    const rows = await fileStorage.listByPrefix('skills/demo/');
    expect(rows.map((row) => row.name)).toEqual(['skills/demo/SKILL.md']);
  });

  it('round-trips content through the path', async () => {
    await fileStorage.writeFile('skills/demo/SKILL.md', 'hello skill');
    expect(await fileStorage.readFileAsText('skills/demo/SKILL.md')).toBe('hello skill');
    expect(await fileStorage.readFileAsText('skills/demo/skill.md')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Moving
// ---------------------------------------------------------------------------

describe('movePath', () => {
  it('renames a single file', async () => {
    await fileStorage.writeFile('notes.md', 'v1');
    const result = await fileStorage.movePath('notes.md', 'archive/notes.md');
    expect(result.moved).toEqual(['archive/notes.md']);
    expect(await fileStorage.exists('notes.md')).toBe(false);
    expect(await fileStorage.readFileAsText('archive/notes.md')).toBe('v1');
  });

  it('moves a whole directory with its contents', async () => {
    await fileStorage.writeFile('skills/demo/SKILL.md', 'manifest');
    await fileStorage.writeFile('skills/demo/references/a.md', 'a');

    const result = await fileStorage.movePath('skills/demo/', 'skills/renamed/');
    expect(result.moved).toEqual([
      'skills/renamed/SKILL.md',
      'skills/renamed/references/a.md',
    ]);
    expect(await fileStorage.exists('skills/demo/SKILL.md')).toBe(false);
    expect((await fileStorage.listDirectory('skills/')).directories).toEqual([
      'skills/renamed/',
    ]);
    expect((await fileStorage.listDirectory('skills/renamed/')).directories).toEqual([
      'skills/renamed/references/',
    ]);
  });

  it('fails instead of merging into an occupied target', async () => {
    await fileStorage.writeFile('a.md', 'a');
    await fileStorage.writeFile('b.md', 'b');
    await expect(fileStorage.movePath('a.md', 'b.md')).rejects.toThrow(/already exists/);
    expect(await fileStorage.readFileAsText('b.md')).toBe('b');
  });

  it('refuses to move a directory inside itself', async () => {
    await fileStorage.writeFile('skills/demo/SKILL.md', 'x');
    await expect(fileStorage.movePath('skills/demo/', 'skills/demo/inner/')).rejects.toThrow(
      /inside itself/,
    );
  });
});

// ---------------------------------------------------------------------------
// Clearing
// ---------------------------------------------------------------------------

describe('clearFiles', () => {
  it('removes user files but keeps installed skills', async () => {
    await fileStorage.writeFile('notes.md', 'n');
    await fileStorage.writeFile('skills/demo/SKILL.md', 's');

    const removed = await fileStorage.clearFiles();

    expect(removed).toBe(1);
    expect(await fileStorage.listFiles().then((files) => files.map((f) => f.name))).toEqual([
      'skills/demo/SKILL.md',
    ]);
  });

  it('reports nothing removed when only system files exist', async () => {
    await fileStorage.writeFile('skills/demo/SKILL.md', 's');
    expect(await fileStorage.clearFiles()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bulk deletion
// ---------------------------------------------------------------------------

describe('deletePath', () => {
  it('deletes a directory in one pass and announces the names once', async () => {
    await fileStorage.writeFile('skills/demo/SKILL.md', 'a');
    await fileStorage.writeFile('skills/demo/references/b.md', 'b');
    await fileStorage.writeFile('skills/other/SKILL.md', 'c');
    await fileStorage.createDirectory('skills/demo/references');

    // Subscribed after setup: creating directories announces itself too.
    const announcements: string[][] = [];
    const unsubscribe = onEvent('files:changed', (payload) => {
      announcements.push([...payload.names]);
    });

    const deleted = await fileStorage.deletePath('skills/demo/');
    unsubscribe();

    expect(deleted.sort()).toEqual(['skills/demo/SKILL.md', 'skills/demo/references/b.md']);
    expect(await fileStorage.listByPrefix('skills/demo/')).toEqual([]);
    // A neighbour with the same parent is untouched.
    expect((await fileStorage.listByPrefix('skills/other/')).map((file) => file.name)).toEqual([
      'skills/other/SKILL.md',
    ]);
    // One transaction means one event, not one per file: every open view
    // rebuilds on it, and the index uses it to invalidate.
    expect(announcements).toEqual([deleted]);
    // The directory records under the prefix go with the files.
    expect(
      (await fileStorage.listDirectories()).filter((record) => record.path.startsWith('skills/demo/')),
    ).toEqual([]);
  });

  it('deletes a single file when the path names one', async () => {
    await fileStorage.writeFile('notes.md', 'x');
    await fileStorage.writeFile('other.md', 'y');

    expect(await fileStorage.deletePath('notes.md')).toEqual(['notes.md']);
    expect((await fileStorage.listFiles()).map((file) => file.name)).toEqual(['other.md']);
  });

  it('reports nothing when the path is already gone', async () => {
    expect(await fileStorage.deletePath('missing/')).toEqual([]);
  });

  it('refuses to delete the storage root', async () => {
    await expect(fileStorage.deletePath('/')).rejects.toThrow();
  });
});
