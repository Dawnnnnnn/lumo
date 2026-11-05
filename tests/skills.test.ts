/**
 * The skills index: `skills/<name>/SKILL.md` → prompt section.
 *
 * Three things can fail silently here and are what these tests hold down:
 *
 * - the manifest is parsed as YAML, so a multi-line description with a colon
 *   must survive (a `key: value` scanner would corrupt it);
 * - only files literally named `SKILL.md` are manifests, and a skill without a
 *   description is not routable at all;
 * - the index is rebuilt when skill files change, because the runner snapshots
 *   the *user's* prompt but not this section.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface StoredSkillFile {
  text: string;
  updatedAt: number;
}

const files = new Map<string, StoredSkillFile>();
let failListing = false;

vi.mock('@/lib/mcp/file-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp/file-storage')>();
  return {
    ...actual,
    fileStorage: {
      listByPrefix: async (dir: string) => {
        if (failListing) throw new Error('storage unavailable');
        return [...files.entries()]
          .filter(([name]) => name.startsWith(dir))
          .map(([name, value]) => ({
            name,
            mimeType: 'text/markdown',
            size: value.text.length,
            createdAt: 1,
            updatedAt: value.updatedAt,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
      },
      readFileAsText: async (name: string) => files.get(name)?.text ?? null,
    },
  };
});

const {
  appendSkillsIndex,
  formatSkillsIndex,
  getSkillIndex,
  invalidateSkillIndex,
  loadSkillIndex,
  parseFrontmatter,
  validateSkill,
} = await import('@/lib/skills');

function putSkill(dir: string, manifest: string, extra: Record<string, string> = {}) {
  files.set(`skills/${dir}/SKILL.md`, { text: manifest, updatedAt: 1 });
  for (const [name, text] of Object.entries(extra)) {
    files.set(`skills/${dir}/${name}`, { text, updatedAt: 1 });
  }
}

beforeEach(() => {
  files.clear();
  failListing = false;
  invalidateSkillIndex();
});

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  it('reads a YAML mapping and leaves the body untouched', () => {
    const parsed = parseFrontmatter(
      '---\nname: pdf-tools\ndescription: >\n  Extract text and tables.\n  Use when: reading PDFs.\n---\n\n# PDF tools\n',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.data.name).toBe('pdf-tools');
    // Folded scalars keep a colon without being read as another key.
    expect(String(parsed.document.data.description).trim()).toBe(
      'Extract text and tables. Use when: reading PDFs.',
    );
    expect(parsed.document.body).toBe('\n# PDF tools\n');
  });

  it('treats a file without frontmatter as an empty manifest, not an error', () => {
    const parsed = parseFrontmatter('# Just a note\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.data).toEqual({});
  });

  it('rejects an unclosed block', () => {
    const parsed = parseFrontmatter('---\nname: x\n');
    expect(parsed).toEqual({ ok: false, error: expect.stringContaining('never closes') });
  });

  it('rejects invalid YAML instead of guessing', () => {
    const parsed = parseFrontmatter('---\nname: [unclosed\n---\n');
    expect(parsed.ok).toBe(false);
  });

  it('rejects a frontmatter that is not a mapping', () => {
    const parsed = parseFrontmatter('---\n- a\n- b\n---\n');
    expect(parsed).toEqual({ ok: false, error: expect.stringContaining('mapping') });
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validateSkill', () => {
  const base = { path: 'skills/demo/SKILL.md', dir: 'skills/demo/', dirName: 'demo', updatedAt: 7 };

  it('accepts every field the specification defines', () => {
    const { skill, diagnostics } = validateSkill({
      ...base,
      data: {
        name: 'demo',
        description: 'Does demo things.',
        license: 'MIT',
        compatibility: 'Chrome 120+',
        metadata: { author: 'lumo', version: '1' },
        'allowed-tools': 'file_read file_write',
        'disable-model-invocation': true,
      },
    });
    expect(diagnostics).toEqual([]);
    expect(skill).toMatchObject({
      name: 'demo',
      license: 'MIT',
      compatibility: 'Chrome 120+',
      metadata: { author: 'lumo', version: '1' },
      allowedTools: ['file_read', 'file_write'],
      disableModelInvocation: true,
      path: 'skills/demo/SKILL.md',
      dir: 'skills/demo/',
    });
  });

  it('refuses a skill without a description, since nothing can route to it', () => {
    const { skill, diagnostics } = validateSkill({ ...base, data: { name: 'demo' } });
    expect(skill).toBeNull();
    expect(diagnostics).toEqual([
      expect.objectContaining({ level: 'error', code: 'description-missing' }),
    ]);
  });

  it('falls back to the directory name and warns, rather than dropping the skill', () => {
    const { skill, diagnostics } = validateSkill({ ...base, data: { description: 'x' } });
    expect(skill?.name).toBe('demo');
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'name-missing' })]);
  });

  it('warns about names the specification rejects but still loads the skill', () => {
    const { skill, diagnostics } = validateSkill({
      ...base,
      data: { name: 'Demo Skill', description: 'x' },
    });
    expect(skill?.name).toBe('Demo Skill');
    expect(diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(['name-invalid', 'name-directory-mismatch']),
    );
  });

  it('keeps a skill whose name differs from its directory, with a portability warning', () => {
    const { skill, diagnostics } = validateSkill({
      ...base,
      data: { name: 'other-name', description: 'x' },
    });
    expect(skill?.name).toBe('other-name');
    expect(diagnostics.map((d) => d.code)).toEqual(['name-directory-mismatch']);
  });
});

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

describe('loadSkillIndex', () => {
  it('indexes only SKILL.md manifests and ignores bundled resources', async () => {
    putSkill('pdf-tools', '---\nname: pdf-tools\ndescription: Work with PDFs.\n---\nBody', {
      'references/formats.md': '# formats',
      'scripts/extract.sh': 'echo',
    });
    const index = await loadSkillIndex();
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0]).toMatchObject({
      name: 'pdf-tools',
      description: 'Work with PDFs.',
      path: 'skills/pdf-tools/SKILL.md',
      dir: 'skills/pdf-tools/',
    });
  });

  it('is case-sensitive about the manifest name, as the specification is', async () => {
    files.set('skills/lower/Skill.md', { text: '---\ndescription: x\n---\n', updatedAt: 1 });
    expect((await loadSkillIndex()).skills).toEqual([]);
  });

  it('keeps the first skill on a name collision and reports it', async () => {
    putSkill('a', '---\nname: shared\ndescription: first\n---\n');
    putSkill('b', '---\nname: shared\ndescription: second\n---\n');
    const index = await loadSkillIndex();
    expect(index.skills.map((s) => s.description)).toEqual(['first']);
    // Each skill's own portability warning rides along; the collision is the
    // one that explains the dropped skill.
    expect(index.diagnostics.filter((d) => d.code === 'name-collision')).toEqual([
      expect.objectContaining({ level: 'warning', path: 'skills/b/SKILL.md' }),
    ]);
  });

  it('reports a malformed manifest instead of publishing a half-read skill', async () => {
    putSkill('broken', '---\nname: broken\n');
    const index = await loadSkillIndex();
    expect(index.skills).toEqual([]);
    expect(index.diagnostics).toEqual([
      expect.objectContaining({ code: 'frontmatter-invalid', level: 'error' }),
    ]);
  });

  it('caches until a skill file changes', async () => {
    putSkill('one', '---\nname: one\ndescription: first\n---\n');
    const first = await getSkillIndex();
    expect(first.skills.map((s) => s.name)).toEqual(['one']);

    // Writing a file in another context arrives as an event; the index must not
    // keep advertising a skill that is gone.
    files.delete('skills/one/SKILL.md');
    putSkill('two', '---\nname: two\ndescription: second\n---\n');
    const { emitEvent } = await import('@/lib/event-bus');
    emitEvent('files:changed', { names: ['skills/two/SKILL.md'], reason: 'write' });

    const second = await getSkillIndex();
    expect(second.skills.map((s) => s.name)).toEqual(['two']);
  });
});

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

describe('formatSkillsIndex', () => {
  it('renders the Agent Skills block with storage paths', async () => {
    putSkill('pdf-tools', '---\nname: pdf-tools\ndescription: Work with <PDFs> & tables.\n---\n');
    const section = formatSkillsIndex(await loadSkillIndex());
    expect(section).toContain('<available_skills>');
    expect(section).toContain('<name>pdf-tools</name>');
    // Descriptions are model-facing text inside XML, so they must be escaped.
    expect(section).toContain('<description>Work with &lt;PDFs&gt; &amp; tables.</description>');
    expect(section).toContain('<location>skills/pdf-tools/SKILL.md</location>');
    expect(section).toContain('file_read');
    expect(section).toContain('file_list');
  });

  it('omits skills that opted out of model invocation', async () => {
    putSkill('hidden', '---\nname: hidden\ndescription: x\ndisable-model-invocation: true\n---\n');
    expect(formatSkillsIndex(await loadSkillIndex())).toBe('');
  });

  it('returns an empty string when nothing is installed', async () => {
    expect(formatSkillsIndex(await loadSkillIndex())).toBe('');
  });
});

describe('appendSkillsIndex', () => {
  it('appends the index after the user prompt, keeping the prompt first', async () => {
    putSkill('demo', '---\nname: demo\ndescription: Demo.\n---\n');
    const prompt = await appendSkillsIndex('You are Lumo.');
    expect(prompt?.startsWith('You are Lumo.')).toBe(true);
    expect(prompt).toContain('<name>demo</name>');
  });

  it('returns the prompt unchanged when no skills are installed', async () => {
    expect(await appendSkillsIndex('You are Lumo.')).toBe('You are Lumo.');
    expect(await appendSkillsIndex(undefined)).toBeUndefined();
  });

  it('never fails a turn because storage failed', async () => {
    failListing = true;
    expect(await appendSkillsIndex('You are Lumo.')).toBe('You are Lumo.');
  });
});
