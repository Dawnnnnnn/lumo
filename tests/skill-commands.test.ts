/**
 * `/skill:<name>` — the explicit way to load a skill.
 *
 * Two behaviours are load-bearing and easy to break:
 *
 * - the trigger must survive `matchCommandInput`, which splits on the first
 *   whitespace and lowercases for matching (`skill:pdf-tools` contains a colon);
 * - the expansion must keep the user's request outside the instruction block,
 *   otherwise a question like "why is this failing" reads as part of the skill.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedCommand } from '@/lib/slash-commands';

const stored = new Map<string, string>();

vi.mock('@/lib/mcp/file-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp/file-storage')>();
  return {
    ...actual,
    fileStorage: {
      readFileAsText: async (name: string) => stored.get(name) ?? null,
    },
  };
});

const {
  expandSkillCommand,
  loadSkillCommandText,
  skillCommandName,
  withSkillCommands,
} = await import('@/lib/skills/commands');
const { filterCommands, matchCommandInput, matchCommandInput: match } = await import(
  '@/lib/slash-commands'
);
type Skill = import('@/lib/skills/validate').Skill;

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'pdf-tools',
    description: 'Extract text and tables from PDFs.',
    disableModelInvocation: false,
    path: 'skills/pdf-tools/SKILL.md',
    dir: 'skills/pdf-tools/',
    updatedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  stored.clear();
});

describe('withSkillCommands', () => {
  it('appends one command per installed skill, after the user commands', async () => {
    const base: ResolvedCommand[] = [
      { kind: 'user', id: 'u1', name: 'fy', phrase: 'translate this page' },
    ];
    const commands = withSkillCommands(base, [skill(), skill({ name: 'web', path: 'skills/web/SKILL.md', dir: 'skills/web/' })]);
    expect(commands.map((command) => command.name)).toEqual(['fy', 'skill:pdf-tools', 'skill:web']);
    expect(commands[1]).toMatchObject({ kind: 'skill', id: 'pdf-tools' });
  });

  it('offers skills that opted out of the prompt index, since the command is the only way in', () => {
    const commands = withSkillCommands([], [skill({ disableModelInvocation: true })]);
    expect(commands).toHaveLength(1);
  });

  it('never renames a user command to make room for a skill', () => {
    const base: ResolvedCommand[] = [
      { kind: 'user', id: 'u1', name: 'skill:pdf-tools', phrase: 'mine' },
    ];
    expect(withSkillCommands(base, [skill()])).toEqual(base);
  });
});

describe('the trigger survives command matching', () => {
  const commands = withSkillCommands([], [skill()]);

  it('is found at the start of a draft', () => {
    const invocation = match('/skill:pdf-tools extract a.pdf', commands);
    expect(invocation?.command.kind).toBe('skill');
    expect(invocation?.rest).toBe('extract a.pdf');
  });

  it('is matched case-insensitively, like every other command', () => {
    expect(match('/SKILL:PDF-TOOLS', commands)?.command.name).toBe('skill:pdf-tools');
  });

  it('is reachable by its name alone, without typing the prefix', () => {
    expect(filterCommands(commands, 'pdf').map((command) => command.name)).toEqual([
      'skill:pdf-tools',
    ]);
  });

  it('is not a command mid-sentence', () => {
    expect(matchCommandInput('please /skill:pdf-tools this', commands)).toBeNull();
  });
});

describe('expandSkillCommand', () => {
  it('wraps the instructions and keeps the request outside the block', () => {
    const text = expandSkillCommand({
      name: 'pdf-tools',
      path: 'skills/pdf-tools/SKILL.md',
      dir: 'skills/pdf-tools/',
      body: '\n# PDF tools\n\nRead references/formats.md first.\n',
      args: 'extract report.pdf',
    });

    expect(text.startsWith('<skill name="pdf-tools" location="skills/pdf-tools/SKILL.md">')).toBe(true);
    expect(text).toContain('References are relative to skills/pdf-tools/.');
    expect(text).toContain('Read a referenced file with file_read');
    expect(text.trimEnd().endsWith('extract report.pdf')).toBe(true);
    // The request must not be swallowed into the instruction block.
    expect(text.indexOf('</skill>')).toBeLessThan(text.indexOf('extract report.pdf'));
  });

  it('omits the trailing request when there is none', () => {
    const text = expandSkillCommand({
      name: 'x',
      path: 'skills/x/SKILL.md',
      dir: 'skills/x/',
      body: 'Body',
    });
    expect(text.trimEnd().endsWith('</skill>')).toBe(true);
  });
});

describe('loadSkillCommandText', () => {
  const command = skillToCommandForTest();

  function skillToCommandForTest() {
    const commands = withSkillCommands([], [skill()]);
    return commands[0] as Extract<ResolvedCommand, { kind: 'skill' }>;
  }

  it('sends the body without the frontmatter', async () => {
    stored.set(
      'skills/pdf-tools/SKILL.md',
      '---\nname: pdf-tools\ndescription: x\n---\n\nSteer by the anchors.\n',
    );
    const text = await loadSkillCommandText(command, 'extract a.pdf');
    expect(text).toContain('Steer by the anchors.');
    expect(text).not.toContain('description: x');
    expect(text).toContain('extract a.pdf');
  });

  it('degrades to the typed text when the skill was deleted under the draft', async () => {
    const text = await loadSkillCommandText(command, 'extract a.pdf');
    expect(text).toBe('/skill:pdf-tools extract a.pdf');
  });

  it('still sends the skill when its frontmatter is broken', async () => {
    stored.set('skills/pdf-tools/SKILL.md', '---\nname: [unclosed\n---\nbody');
    const text = await loadSkillCommandText(command, '');
    expect(text).toContain('body');
  });
});

describe('skillCommandName', () => {
  it('reserves the skill: namespace', () => {
    expect(skillCommandName('pdf-tools')).toBe('skill:pdf-tools');
  });
});
