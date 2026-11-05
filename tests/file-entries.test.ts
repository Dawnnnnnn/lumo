/**
 * Grouping and searching decide what the file list reads as, so they are tested
 * away from the component that renders them.
 *
 * The rules worth pinning: paths become a tree at any depth (a skill's
 * `references/` is nested under the skill, not a sibling row), a directory of
 * documents collapses into one row, a lone file in an ordinary directory stays a
 * file, a skill directory always groups (one skill shipping only a `SKILL.md` is
 * still a skill), and documents sort above capabilities because the Skills tab
 * is where capabilities are managed.
 */
import { describe, expect, it } from 'vitest';
import { buildFileTree, filterFiles, type FileTreeNode } from '@/lib/file-entries';
import type { FileMetadata } from '@/lib/mcp/file-storage';

function meta(name: string, overrides: Partial<FileMetadata> = {}): FileMetadata {
  return {
    name,
    mimeType: 'text/markdown',
    size: 100,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/** Compact view of the tree: folder segments with their children, files relative
 *  to the level they are drawn at — the same names the list renders. */
function shape(nodes: FileTreeNode[], parentPrefix = ''): unknown[] {
  return nodes.map((node) =>
    node.type === 'folder'
      ? [node.name, shape(node.children, node.prefix)]
      : node.file.name.slice(parentPrefix.length),
  );
}

describe('buildFileTree', () => {
  it('groups a directory and totals its size', () => {
    const nodes = buildFileTree([
      meta('chat/a.md', { size: 10 }),
      meta('chat/b.md', { size: 20 }),
    ]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      type: 'folder',
      prefix: 'chat/',
      name: 'chat',
      depth: 0,
      totalSize: 30,
      system: false,
    });
  });

  it('nests a subdirectory under its parent at any depth', () => {
    // The row this list used to draw: `skills/pdf-tools/` and
    // `skills/pdf-tools/references/` side by side at the root.
    const nodes = buildFileTree([
      meta('skills/pdf-tools/SKILL.md'),
      meta('skills/pdf-tools/references/a.md'),
      meta('skills/pdf-tools/references/nested/b.md'),
    ]);

    expect(shape(nodes)).toEqual([
      [
        'skills',
        [
          [
            'pdf-tools',
            [
              ['references', [['nested', ['b.md']], 'a.md']],
              'SKILL.md',
            ],
          ],
        ],
      ],
    ]);
  });

  it('counts every descendant of a folder, not just its own files', () => {
    const [skills] = buildFileTree([
      meta('skills/pdf-tools/SKILL.md', { size: 10 }),
      meta('skills/pdf-tools/references/a.md', { size: 20 }),
      meta('skills/pdf-tools/references/b.md', { size: 30 }),
    ]);

    expect(skills).toMatchObject({ type: 'folder', totalSize: 60 });
    // Delete and zip act on the whole subtree, so the node carries every file
    // below it — at any depth, not just its own.
    if (!skills || skills.type !== 'folder') throw new Error('expected the skills folder');
    expect(skills.files.map((file) => file.name).sort()).toEqual([
      'skills/pdf-tools/SKILL.md',
      'skills/pdf-tools/references/a.md',
      'skills/pdf-tools/references/b.md',
    ]);
  });

  it('keeps a lone file in an ordinary directory as a file row', () => {
    const nodes = buildFileTree([meta('notes/report.md')]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ type: 'file', depth: 0, file: { name: 'notes/report.md' } });
  });

  it('collapses a one-file subdirectory but keeps it as a branch of the tree', () => {
    // `notes/` has only `report.md`, so it reads as one document — under the
    // directory it actually lives in, not at the root. A collapsed directory
    // keeps the position of the folder it replaced (folders sort before files).
    const nodes = buildFileTree([
      meta('docs/a.md'),
      meta('docs/b.md'),
      meta('docs/archive/report.md'),
    ]);

    expect(shape(nodes)).toEqual([['docs', ['archive/report.md', 'a.md', 'b.md']]]);
  });

  it('always groups a system directory, even with one file', () => {
    // A skill that ships only its manifest must read as one skill, not as a
    // stray file called SKILL.md.
    const nodes = buildFileTree([meta('skills/pdf-tools/SKILL.md')]);
    expect(shape(nodes)).toEqual([['skills', [['pdf-tools', ['SKILL.md']]]]]);
    const [skills] = nodes;
    expect(skills?.type).toBe('folder');
    expect(skills?.type === 'folder' && skills.system).toBe(true);
  });

  it('orders documents first, capabilities second, loose files last', () => {
    const nodes = buildFileTree([
      meta('skills/pdf-tools/SKILL.md'),
      meta('skills/pdf-tools/references/a.md'),
      meta('chat/a.md'),
      meta('chat/b.md'),
      meta('loose.md', { createdAt: 50 }),
    ]);

    expect(shape(nodes)).toEqual([
      ['chat', ['a.md', 'b.md']],
      ['skills', [['pdf-tools', [['references', ['a.md']], 'SKILL.md']]]],
      'loose.md',
    ]);
  });

  it('sorts loose files newest first', () => {
    const nodes = buildFileTree([
      meta('old.md', { createdAt: 1 }),
      meta('new.md', { createdAt: 2 }),
    ]);

    expect(nodes.map((node) => (node.type === 'file' ? node.file.name : ''))).toEqual([
      'new.md',
      'old.md',
    ]);
  });
});

describe('filterFiles', () => {
  const files = [meta('notes/report.md'), meta('chat/screenshot.txt', { conversationId: 'c1' })];
  const title = (id?: string) => (id === 'c1' ? 'Quarterly planning' : null);

  it('returns everything for an empty query', () => {
    expect(filterFiles(files, '   ', title)).toBe(files);
  });

  it('matches the stored path, case-insensitively', () => {
    expect(filterFiles(files, 'REPORT', title).map((file) => file.name)).toEqual(['notes/report.md']);
  });

  it('matches the conversation title too', () => {
    // The user remembers who asked for it as often as what it was called.
    expect(filterFiles(files, 'quarterly', title).map((file) => file.name)).toEqual([
      'chat/screenshot.txt',
    ]);
  });

  it('returns nothing when neither matches', () => {
    expect(filterFiles(files, 'unrelated', title)).toEqual([]);
  });
});
