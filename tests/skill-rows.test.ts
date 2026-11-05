/**
 * The Skills tab is built from the skills index *and* the file list, and these
 * cases pin down why both are needed:
 *
 * - the index supplies capability and validation, including the skills that
 *   failed validation and therefore produce no `Skill` at all;
 * - the file list supplies counts, sizes and the directories that have no
 *   manifest — a folder of files the Skills tab did not mention would be a
 *   folder the user cannot reach from the place that manages skills.
 */
import { describe, expect, it } from 'vitest';
import { buildSkillRows, skillManifestPath, type SkillIndexLike } from '@/lib/skills/rows';
import type { FileMetadata } from '@/lib/mcp/file-storage';
import type { Skill } from '@/lib/skills/validate';

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'pdf-tools',
    description: 'Extract and fill PDF forms',
    disableModelInvocation: false,
    path: 'skills/pdf-tools/SKILL.md',
    dir: 'skills/pdf-tools/',
    updatedAt: 2000,
    ...overrides,
  };
}

/** A skill with its own directory, which is what distinguishes two skills. */
function named(name: string, overrides: Partial<Skill> = {}): Skill {
  return skill({ name, dir: `skills/${name}/`, path: `skills/${name}/SKILL.md`, ...overrides });
}

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

const index = (overrides: Partial<SkillIndexLike> = {}): SkillIndexLike => ({
  skills: [],
  diagnostics: [],
  ...overrides,
});

describe('buildSkillRows', () => {
  it('carries the metadata the list shows', () => {
    const rows = buildSkillRows(
      index({ skills: [skill({ license: 'MIT', allowedTools: ['Read', 'Write'] })] }),
      [meta('skills/pdf-tools/SKILL.md', { size: 10 }), meta('skills/pdf-tools/ref.md', { size: 5 })],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'pdf-tools',
      dir: 'skills/pdf-tools/',
      description: 'Extract and fill PDF forms',
      license: 'MIT',
      allowedTools: ['Read', 'Write'],
      fileCount: 2,
      size: 15,
    });
  });

  it('keeps a skill that does not load, with the reason attached', () => {
    // The whole point of the view: a manifest without a description produces no
    // `Skill`, and the user needs to see it to fix it.
    const rows = buildSkillRows(
      index({
        diagnostics: [
          {
            level: 'error',
            code: 'description-missing',
            message: 'a skill requires a non-empty "description" to be routable',
            path: 'skills/draft/SKILL.md',
          },
        ],
      }),
      [meta('skills/draft/SKILL.md')],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'draft', dir: 'skills/draft/', skill: null });
    expect(rows[0]!.diagnostics).toHaveLength(1);
  });

  it('sorts skills that need attention to the top', () => {
    const rows = buildSkillRows(
      index({
        skills: [named('aaa'), named('bbb')],
        diagnostics: [
          { level: 'error', code: 'name-unusable', message: 'bad', path: 'skills/bbb/SKILL.md' },
        ],
      }),
      [meta('skills/aaa/SKILL.md'), meta('skills/bbb/SKILL.md')],
    );

    expect(rows.map((row) => row.name)).toEqual(['bbb', 'aaa']);
  });

  it('ignores warnings when deciding what needs attention', () => {
    const rows = buildSkillRows(
      index({
        skills: [named('aaa'), named('bbb')],
        diagnostics: [{ level: 'warning', code: 'name-missing', message: 'meh', path: 'skills/bbb/SKILL.md' }],
      }),
      [meta('skills/aaa/SKILL.md'), meta('skills/bbb/SKILL.md')],
    );

    // A warning is not a failure: the row stays where its name puts it.
    expect(rows.map((row) => row.name)).toEqual(['aaa', 'bbb']);
  });

  it('lists a directory that has files but no manifest', () => {
    const rows = buildSkillRows(index(), [
      meta('skills/references-only/notes.md'),
      meta('skills/references-only/more.md'),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dir: 'skills/references-only/', skill: null, fileCount: 2 });
    expect(skillManifestPath(rows[0]!)).toBeNull();
  });

  it('ignores installer scratch directories', () => {
    const rows = buildSkillRows(index(), [meta('skills/.staging-123/SKILL.md')]);
    expect(rows).toEqual([]);
  });

  it('ignores files that live directly under skills/ and everything outside it', () => {
    const rows = buildSkillRows(index(), [meta('skills/notes.md'), meta('chat/a.md')]);
    expect(rows).toEqual([]);
  });

  it('reports the newest file as the update time', () => {
    const rows = buildSkillRows(index({ skills: [skill({ updatedAt: 1500 })] }), [
      meta('skills/pdf-tools/SKILL.md', { updatedAt: 1500 }),
      meta('skills/pdf-tools/ref.md', { updatedAt: 9000 }),
    ]);

    expect(rows[0]!.updatedAt).toBe(9000);
  });
});

describe('skillManifestPath', () => {
  it('opens the manifest of a routable skill', () => {
    const rows = buildSkillRows(index({ skills: [skill()] }), []);
    expect(skillManifestPath(rows[0]!)).toBe('skills/pdf-tools/SKILL.md');
  });

  it('opens the rejected manifest, which is what needs editing', () => {
    const rows = buildSkillRows(
      index({
        diagnostics: [
          { level: 'error', code: 'frontmatter-invalid', message: 'bad', path: 'skills/x/SKILL.md' },
        ],
      }),
      [],
    );
    expect(skillManifestPath(rows[0]!)).toBe('skills/x/SKILL.md');
  });
});
