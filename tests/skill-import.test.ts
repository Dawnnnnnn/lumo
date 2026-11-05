/**
 * Skill package import: unpack → discover → validate → install.
 *
 * The cases that matter are the ones a naive importer gets wrong:
 *
 * - a GitHub zip nests the skill three directories deep (`repo-main/skills/x/`);
 *   the manifest's own directory is the skill root, not the archive root;
 * - one archive can hold several skills, and a manifest nested in another
 *   skill's directory must not be installed twice;
 * - a package is attacker-controlled, so `..` paths and editor debris are
 *   dropped rather than trusted;
 * - installing is staged and moved into place, so a rejected manifest never
 *   leaves a half-written skill behind.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';

const fs = new Map<string, string>();

vi.mock('@/lib/mcp/file-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp/file-storage')>();
  const metadata = (name: string) => ({
    name,
    mimeType: actual.inferMimeType(name),
    size: fs.get(name)?.length ?? 0,
    createdAt: 1,
    updatedAt: 1,
  });

  return {
    ...actual,
    fileStorage: {
      writeFile: async (name: string, content: Blob | string) => {
        fs.set(name, typeof content === 'string' ? content : await content.text());
        return metadata(name);
      },
      readFileAsText: async (name: string) => fs.get(name) ?? null,
      exists: async (name: string) => fs.has(name),
      listByPrefix: async (dir: string) =>
        [...fs.keys()].filter((name) => name.startsWith(dir)).sort().map(metadata),
      deleteFile: async (name: string) => {
        fs.delete(name);
        return true;
      },
      deleteDirectory: async () => true,
      movePath: async (from: string, to: string) => {
        const isDirectory = from.endsWith('/') || !fs.has(from);
        if (!isDirectory) {
          fs.set(to, fs.get(from)!);
          fs.delete(from);
          return { moved: [to], to };
        }
        const fromDir = from.endsWith('/') ? from : `${from}/`;
        const entries = [...fs.keys()].filter((name) => name.startsWith(fromDir));
        const moved = entries.map((name) => `${to}${name.slice(fromDir.length)}`);
        entries.forEach((name, index) => {
          fs.set(moved[index]!, fs.get(name)!);
          fs.delete(name);
        });
        return { moved, to };
      },
    },
  };
});

const { discoverSkills } = await import('@/lib/skills/import/discover');
const { planSkillPackage } = await import('@/lib/skills/import/install');
const { importSkillPackages, inspectSkillPackages, installSkillCandidates } =
  await import('@/lib/skills/import');
const { packageFilesSource } = await import('@/lib/skills/import/sources');
const { unpackZipArchive } = await import('@/lib/skills/import/archive');

function zip(entries: Record<string, string>): Uint8Array {
  const data: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(entries)) data[path] = strToU8(text);
  return zipSync(data);
}

function packageOf(entries: Record<string, string>) {
  const unpacked = unpackZipArchive(zip(entries));
  if (!unpacked.ok) throw new Error(unpacked.error);
  return unpacked.files;
}

const MANIFEST = (name: string, extra = '') =>
  `---\nname: ${name}\ndescription: ${name} does things.\n${extra}---\n\n# ${name}\n`;

beforeEach(() => {
  fs.clear();
});

// ---------------------------------------------------------------------------
// Unpacking
// ---------------------------------------------------------------------------

describe('unpackZipArchive', () => {
  it('keeps the directory structure of the archive', () => {
    const unpacked = unpackZipArchive(
      zip({ 'repo-main/skills/a/SKILL.md': MANIFEST('a'), 'repo-main/skills/a/refs/x.md': 'x' }),
    );
    expect(unpacked.ok).toBe(true);
    if (!unpacked.ok) return;
    expect(unpacked.files.map((file) => file.path)).toEqual([
      'repo-main/skills/a/SKILL.md',
      'repo-main/skills/a/refs/x.md',
    ]);
  });

  it('drops editor and VCS debris instead of installing it', () => {
    const unpacked = unpackZipArchive(
      zip({
        'SKILL.md': MANIFEST('a'),
        '.DS_Store': 'x',
        '__MACOSX/._SKILL.md': 'x',
        '.git/config': 'x',
        'node_modules/dep/index.js': 'x',
        'Thumbs.db': 'x',
      }),
    );
    expect(unpacked.ok).toBe(true);
    if (!unpacked.ok) return;
    expect(unpacked.files.map((file) => file.path)).toEqual(['SKILL.md']);
  });

  it('refuses paths that would escape the package', () => {
    const unpacked = unpackZipArchive(zip({ '../evil.md': 'x', 'SKILL.md': MANIFEST('a') }));
    expect(unpacked.ok).toBe(true);
    if (!unpacked.ok) return;
    expect(unpacked.files.map((file) => file.path)).toEqual(['SKILL.md']);
  });

  it('rejects an archive that is not a zip', () => {
    expect(unpackZipArchive(strToU8('not a zip'))).toEqual({
      ok: false,
      error: expect.stringContaining('not a readable zip archive'),
    });
  });

  it('bounds the expansion so a bomb fails instead of freezing the tab', () => {
    const entries: Record<string, string> = {};
    for (let index = 0; index < 510; index += 1) entries[`f${index}.md`] = 'x';
    expect(unpackZipArchive(zip(entries))).toEqual({
      ok: false,
      error: expect.stringContaining('more than'),
    });
  });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('discoverSkills', () => {
  it('installs a skill at the archive root', () => {
    const [found] = discoverSkills(packageOf({ 'SKILL.md': MANIFEST('a'), 'refs/x.md': 'x' }));
    expect(found).toMatchObject({ root: '', manifestPath: 'SKILL.md' });
    expect(found!.files.map((file) => file.path)).toEqual(['SKILL.md', 'refs/x.md']);
  });

  it('treats the manifest directory as the root, however deeply it is nested', () => {
    const files = packageOf({
      'repo-main/skills/pdf-tools/SKILL.md': MANIFEST('pdf-tools'),
      'repo-main/skills/pdf-tools/references/a.md': 'a',
    });
    const [found] = discoverSkills(files);
    expect(found!.root).toBe('repo-main/skills/pdf-tools/');
    expect(found!.files.map((file) => file.path)).toEqual(['SKILL.md', 'references/a.md']);
  });

  it('installs every skill an archive contains', () => {
    const found = discoverSkills(
      packageOf({
        'repo-main/skills/a/SKILL.md': MANIFEST('a'),
        'repo-main/skills/b/SKILL.md': MANIFEST('b'),
        'repo-main/skills/b/x.md': 'x',
      }),
    );
    expect(found.map((skill) => skill.root)).toEqual([
      'repo-main/skills/a/',
      'repo-main/skills/b/',
    ]);
  });

  it('does not copy a nested skill into its parent', () => {
    const [outer, inner] = discoverSkills(
      packageOf({ 'outer/SKILL.md': MANIFEST('outer'), 'outer/inner/SKILL.md': MANIFEST('inner') }),
    );
    expect(outer!.files.map((file) => file.path)).toEqual(['SKILL.md']);
    // The inner skill is its own root, so its files are relative to it.
    expect(inner!.root).toBe('outer/inner/');
    expect(inner!.files.map((file) => file.path)).toEqual(['SKILL.md']);
  });

  it('finds nothing in a package of ordinary documents', () => {
    expect(discoverSkills(packageOf({ 'notes/a.md': 'x' }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

describe('planSkillPackage', () => {
  const plan = (entries: Record<string, string>) => {
    const [found] = discoverSkills(packageOf(entries));
    return planSkillPackage(found!);
  };

  it('resolves the target directory from the manifest name', () => {
    const { pkg } = plan({ 'whatever/SKILL.md': MANIFEST('pdf-tools') });
    expect(pkg).toMatchObject({ installName: 'pdf-tools' });
    expect(pkg!.skill.path).toBe('skills/pdf-tools/SKILL.md');
    expect(pkg!.skill.dir).toBe('skills/pdf-tools/');
  });

  it('refuses a manifest with no description', () => {
    const { pkg, diagnostics } = plan({ 'x/SKILL.md': '---\nname: x\n---\n' });
    expect(pkg).toBeNull();
    expect(diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'description-missing' })]),
    );
  });

  it('refuses a name that cannot be a directory or a command trigger', () => {
    const { pkg, diagnostics } = plan({
      'x/SKILL.md': '---\nname: "My Skill"\ndescription: x\n---\n',
    });
    expect(pkg).toBeNull();
    expect(diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'name-unusable', level: 'error' })]),
    );
  });

  it('falls back to the directory name when the manifest omits one', () => {
    const { pkg } = plan({ 'pdf-tools/SKILL.md': '---\ndescription: x\n---\n' });
    expect(pkg).toMatchObject({ installName: 'pdf-tools' });
  });
});

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Inspecting before installing
// ---------------------------------------------------------------------------

describe('inspectSkillPackages', () => {
  const source = (entries: Record<string, string>) =>
    packageFilesSource(packageOf(entries), 'test.zip');

  it('describes each skill without writing anything', async () => {
    const inspection = await inspectSkillPackages(
      source({
        'repo-main/skills/pdf-tools/SKILL.md': MANIFEST('pdf-tools'),
        'repo-main/skills/pdf-tools/references/a.md': 'a',
      }),
    );

    expect(fs.size).toBe(0);
    expect(inspection.empty).toBe(false);
    expect(inspection.candidates).toHaveLength(1);
    expect(inspection.candidates[0]).toMatchObject({
      sourceLabel: 'test.zip',
      fileCount: 2,
      installed: false,
    });
    expect(inspection.candidates[0]!.plan.pkg).toMatchObject({ installName: 'pdf-tools' });
    expect(inspection.candidates[0]!.plan.pkg!.skill.description).toBe('pdf-tools does things.');
  });

  it('offers a skill it cannot install, with the reason attached', async () => {
    const inspection = await inspectSkillPackages(
      source({ 'skills/broken/SKILL.md': '---\nname: broken\n---\n' }),
    );

    // Listed rather than dropped: the review screen has to be able to say why.
    expect(inspection.candidates).toHaveLength(1);
    expect(inspection.candidates[0]!.plan.pkg).toBeNull();
    expect(inspection.candidates[0]!.plan.diagnostics).toEqual([
      expect.objectContaining({ level: 'error', code: 'description-missing' }),
    ]);
  });

  it('flags a skill whose directory is already taken', async () => {
    fs.set('skills/pdf-tools/SKILL.md', 'old');

    const inspection = await inspectSkillPackages(source({ 'SKILL.md': MANIFEST('pdf-tools') }));
    expect(inspection.candidates[0]!.installed).toBe(true);
  });

  it('counts a directory with files but no manifest as taken too', async () => {
    // The installer refuses to merge into it, so the review must not call it new.
    fs.set('skills/pdf-tools/references/stale.md', 'old');

    const inspection = await inspectSkillPackages(source({ 'SKILL.md': MANIFEST('pdf-tools') }));
    expect(inspection.candidates[0]!.installed).toBe(true);
  });

  it('reports an empty package once per source', async () => {
    const inspection = await inspectSkillPackages(source({ 'notes/a.md': 'x' }));
    expect(inspection.candidates).toEqual([]);
    expect(inspection.empty).toBe(true);
    expect(inspection.diagnostics).toEqual([
      expect.objectContaining({ code: 'no-manifest', level: 'warning' }),
    ]);
  });
});

describe('installSkillCandidates', () => {
  const source = (entries: Record<string, string>) =>
    packageFilesSource(packageOf(entries), 'test.zip');

  it('installs only what was selected', async () => {
    const inspection = await inspectSkillPackages(
      source({ 'skills/a/SKILL.md': MANIFEST('a'), 'skills/b/SKILL.md': MANIFEST('b') }),
    );
    const kept = inspection.candidates.filter((candidate) =>
      candidate.discovered.manifestPath.includes('/b/'),
    );

    const result = await installSkillCandidates(kept);

    expect(result.installed.map((skill) => skill.name)).toEqual(['b']);
    expect([...fs.keys()]).toEqual(['skills/b/SKILL.md']);
  });

  it('reports a candidate it cannot install instead of dropping it', async () => {
    const inspection = await inspectSkillPackages(
      source({ 'skills/broken/SKILL.md': '---\nname: broken\n---\n' }),
    );

    const result = await installSkillCandidates(inspection.candidates);

    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual([{ name: 'skills/broken', reason: 'invalid' }]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'description-missing' }),
    ]);
  });

  it('installs a candidate whose bytes arrive on demand', async () => {
    // GitHub inspects a repository from its tree, so the bytes for a skill are
    // fetched only once the user has chosen it.
    const inspection = await inspectSkillPackages(source({ 'SKILL.md': MANIFEST('pdf-tools') }));
    const candidate = {
      ...inspection.candidates[0]!,
      files: [],
      loadFiles: async () => packageOf({ 'SKILL.md': MANIFEST('pdf-tools'), 'references/a.md': 'a' }),
    };

    const result = await installSkillCandidates([candidate]);

    expect(result.installed).toEqual([
      { name: 'pdf-tools', path: 'skills/pdf-tools/', files: 2 },
    ]);
    expect([...fs.keys()].sort()).toEqual([
      'skills/pdf-tools/SKILL.md',
      'skills/pdf-tools/references/a.md',
    ]);
  });

  it('reports a skill whose bytes could not be fetched, and installs the rest', async () => {
    const inspection = await inspectSkillPackages(
      source({ 'skills/a/SKILL.md': MANIFEST('a'), 'skills/b/SKILL.md': MANIFEST('b') }),
    );
    const [a, b] = inspection.candidates;

    const result = await installSkillCandidates([
      { ...a!, files: [], loadFiles: async () => { throw new Error('404'); } },
      { ...b!, files: [], loadFiles: async () => packageOf({ 'SKILL.md': MANIFEST('b') }) },
    ]);

    expect(result.installed.map((skill) => skill.name)).toEqual(['b']);
    expect(result.skipped).toEqual([{ name: 'a', reason: 'unsupported' }]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'download-failed', level: 'error' }),
    ]);
  });

  it('replaces an existing skill when the selection says so', async () => {
    fs.set('skills/pdf-tools/SKILL.md', 'old');
    fs.set('skills/pdf-tools/old.md', 'old');

    const inspection = await inspectSkillPackages(source({ 'SKILL.md': MANIFEST('pdf-tools') }));
    const result = await installSkillCandidates(inspection.candidates, { onConflict: 'replace' });

    expect(result.installed).toHaveLength(1);
    expect(fs.get('skills/pdf-tools/SKILL.md')).toContain('name: pdf-tools');
    expect(fs.has('skills/pdf-tools/old.md')).toBe(false);
  });
});

describe('importSkillPackages', () => {
  const source = (entries: Record<string, string>) =>
    packageFilesSource(packageOf(entries), 'test.zip');

  it('installs a skill with its resources and leaves no staging behind', async () => {
    const result = await importSkillPackages(
      source({
        'repo-main/skills/pdf-tools/SKILL.md': MANIFEST('pdf-tools'),
        'repo-main/skills/pdf-tools/references/a.md': 'a',
      }),
    );

    expect(result.installed).toEqual([
      { name: 'pdf-tools', path: 'skills/pdf-tools/', files: 2 },
    ]);
    expect([...fs.keys()].sort()).toEqual([
      'skills/pdf-tools/SKILL.md',
      'skills/pdf-tools/references/a.md',
    ]);
    expect([...fs.keys()].some((name) => name.includes('.staging-'))).toBe(false);
  });

  it('installs every skill in one archive', async () => {
    const result = await importSkillPackages(
      source({ 'skills/a/SKILL.md': MANIFEST('a'), 'skills/b/SKILL.md': MANIFEST('b') }),
    );
    expect(result.installed.map((skill) => skill.name)).toEqual(['a', 'b']);
  });

  it('keeps the installed copy when a skill of the same name exists', async () => {
    fs.set('skills/pdf-tools/SKILL.md', 'old');
    fs.set('skills/pdf-tools/old.md', 'old');

    const result = await importSkillPackages(source({ 'SKILL.md': MANIFEST('pdf-tools') }));

    expect(result.skipped).toEqual([{ name: 'pdf-tools', reason: 'exists' }]);
    expect(fs.get('skills/pdf-tools/SKILL.md')).toBe('old');
    expect(fs.has('skills/pdf-tools/old.md')).toBe(true);
  });

  it('replaces the whole directory when asked to', async () => {
    fs.set('skills/pdf-tools/SKILL.md', 'old');
    fs.set('skills/pdf-tools/old.md', 'old');

    const result = await importSkillPackages(source({ 'SKILL.md': MANIFEST('pdf-tools') }), {
      onConflict: 'replace',
    });

    expect(result.installed).toHaveLength(1);
    expect(fs.get('skills/pdf-tools/SKILL.md')).toContain('name: pdf-tools');
    // The replaced skill's directory is swapped, not merged.
    expect(fs.has('skills/pdf-tools/old.md')).toBe(false);
    expect([...fs.keys()].some((name) => name.includes('.trash-'))).toBe(false);
  });

  it('skips when the target holds files but no manifest, instead of merging into it', async () => {
    fs.set('skills/pdf-tools/references/stale.md', 'old');

    const result = await importSkillPackages(source({ 'SKILL.md': MANIFEST('pdf-tools') }));

    expect(result.skipped).toEqual([{ name: 'pdf-tools', reason: 'exists' }]);
    expect(fs.get('skills/pdf-tools/references/stale.md')).toBe('old');
    expect(fs.has('skills/pdf-tools/SKILL.md')).toBe(false);
  });

  it('reports an invalid manifest without installing anything', async () => {
    const result = await importSkillPackages(
      source({ 'skills/broken/SKILL.md': '---\nname: broken\n---\n' }),
    );
    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual([{ name: 'skills/broken', reason: 'invalid' }]);
    expect(fs.size).toBe(0);
  });

  it('installs the valid skills of a mixed package', async () => {
    const result = await importSkillPackages(
      source({
        'skills/good/SKILL.md': MANIFEST('good'),
        'skills/bad/SKILL.md': '---\nname: bad\n---\n',
      }),
    );
    expect(result.installed.map((skill) => skill.name)).toEqual(['good']);
    expect(result.skipped).toEqual([{ name: 'skills/bad', reason: 'invalid' }]);
  });

  it('reports a package with no manifest instead of failing silently', async () => {
    const result = await importSkillPackages(source({ 'notes/a.md': 'x' }));
    expect(result.empty).toBe(true);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'no-manifest', level: 'warning' }),
    ]);
  });

  it('reports an unreadable source and keeps going', async () => {
    const result = await importSkillPackages([
      { label: 'broken.zip', read: async () => { throw new Error('not a zip'); } },
      source({ 'SKILL.md': MANIFEST('fine') }),
    ]);
    expect(result.installed.map((skill) => skill.name)).toEqual(['fine']);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'source-unreadable', level: 'error' }),
      ]),
    );
  });
});
