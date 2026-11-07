/**
 * Scratch-file lifecycle: what the user sees, what the shell sees, and what
 * startup pruning leaves behind.
 *
 * `tmp/` is shared with the shell and `file_read`, but it is not part of the
 * document library. The distinction is enforced at the storage layer, so these
 * tests pin the two views and the retention pass in one place.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { executeShell } from '@/lib/shell/runtime/execute';
import { fileStorage } from '@/lib/mcp/file-storage';

afterEach(async () => {
  await fileStorage.clearFiles();
  // `clearFiles` removes documents but not explicit directory records; the
  // scratch directories are what this file is about.
  await fileStorage.pruneTempFiles(-1);
});

async function shell(command: string) {
  return executeShell({}, { command });
}

describe('scratch files', () => {
  it('stay out of user-facing listings but remain readable from the shell', async () => {
    await shell("mkdir -p tmp && echo scratch > tmp/note.txt && echo doc > notes.md");

    expect((await fileStorage.listFiles()).map((file) => file.name).sort()).toEqual([
      'notes.md',
      'tmp/note.txt',
    ]);

    expect(
      (await fileStorage.listFiles({ includeTemp: false })).map((file) => file.name),
    ).toEqual(['notes.md']);
    expect(
      (await fileStorage.listDirectory('', { includeTemp: false })).files.map((file) => file.name),
    ).toEqual(['notes.md']);
    expect(await fileStorage.listDirectories({ includeTemp: false })).toEqual([]);

    // The shell's `/` is still the full store, scratch included.
    const read = await shell('cat tmp/note.txt');
    expect(read.stdout).toBe('scratch\n');
  });

  it('prunes stale files and the directory records they leave behind', async () => {
    await shell(
      'mkdir -p tmp/nested && echo old > tmp/old.txt && echo deep > tmp/nested/deep.txt && echo keep > keep.md',
    );
    expect((await fileStorage.listDirectories()).map((record) => record.path)).toEqual([
      'tmp/',
      'tmp/nested/',
    ]);

    const removed = await fileStorage.pruneTempFiles(-1);
    expect(removed.sort()).toEqual(['tmp/nested/deep.txt', 'tmp/old.txt']);
    expect((await fileStorage.listFiles()).map((file) => file.name)).toEqual(['keep.md']);
    // An empty `tmp/` record would otherwise keep appearing in `file_list` and
    // in backup directory indexes.
    expect((await fileStorage.listDirectories()).map((record) => record.path)).toEqual([]);
  });

  it('keeps a fresh scratch file and its directory', async () => {
    await shell('mkdir -p tmp && echo fresh > tmp/fresh.txt');

    expect(await fileStorage.pruneTempFiles()).toEqual([]);
    expect((await fileStorage.listDirectories()).map((record) => record.path)).toEqual(['tmp/']);
  });
});
