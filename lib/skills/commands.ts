/**
 * `/skill:<name>` — the explicit path to a skill.
 *
 * The prompt index is a routing hint, not a guarantee: a model can read a task
 * and simply not load the skill that describes it. Pi solves this with an
 * explicit command, and so does Lumo: `/skill:pdf-tools extract a.pdf` expands
 * to the skill's instructions followed by the user's request, exactly as if the
 * model had loaded it perfectly.
 *
 * The expansion happens in the composer, before the message is sent, so it is a
 * user-visible act rather than something the model has to be trusted with. It
 * also means a skill works in a conversation that already started, with no
 * system-prompt change of any kind.
 */
import { commandKey, COMMAND_PREFIX, type ResolvedCommand } from '@/lib/slash-commands';
import { fileStorage, parentDirPath } from '@/lib/mcp/file-storage';
import { parseFrontmatter } from './frontmatter';
import type { Skill } from './validate';

/** Reserved trigger prefix, so a skill never collides with a user phrase. */
export const SKILL_COMMAND_PREFIX = 'skill:';

/** The trigger a skill is invoked by, without the leading `/`. */
export function skillCommandName(name: string): string {
  return `${SKILL_COMMAND_PREFIX}${name}`;
}

/** Turn an indexed skill into a composer command. */
export function skillToCommand(skill: Skill): ResolvedCommand {
  return {
    kind: 'skill',
    id: skill.name,
    name: skillCommandName(skill.name),
    path: skill.path,
    description: skill.description,
  };
}

/**
 * Append skill commands after the user's own.
 *
 * `disable-model-invocation` skills are included: that flag hides a skill from
 * the prompt index, which is precisely the case where the command is the only
 * way to reach it. Skills lose a name collision against a real user command;
 * nothing is renamed behind the user's back.
 */
export function withSkillCommands(
  commands: ResolvedCommand[],
  skills: Skill[],
): ResolvedCommand[] {
  const seen = new Set(commands.map((command) => commandKey(command.name)));
  const resolved = [...commands];
  for (const skill of skills) {
    const command = skillToCommand(skill);
    const key = commandKey(command.name);
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push(command);
  }
  return resolved;
}

export interface SkillExpansion {
  name: string;
  /** Storage path of `SKILL.md`. */
  path: string;
  /** Storage directory of the skill, with a trailing slash. */
  dir: string;
  /** Skill instructions (frontmatter stripped). */
  body: string;
  /** Whatever the user typed after the trigger. */
  args?: string;
}

/**
 * Render the message a skill command sends.
 *
 * Same shape as Pi's expansion: the instructions wrapped in a `<skill>` block
 * that names the file and its directory (so relative paths resolve), then the
 * user's own request as ordinary text. The wrapper is what lets the model tell
 * instructions apart from the request when the user's text starts with a verb
 * the instructions also use.
 */
export function expandSkillCommand(expansion: SkillExpansion): string {
  const body = expansion.body.trim();
  const block = [
    `<skill name="${expansion.name}" location="${expansion.path}">`,
    `References are relative to ${expansion.dir}. Read a referenced file with file_read before using it.`,
    '',
    body,
    '</skill>',
  ].join('\n');

  const args = expansion.args?.trim();
  return args ? `${block}\n\n${args}` : block;
}

/**
 * Read a skill's instructions and build the message for its command.
 *
 * A missing file falls back to the text the user typed, so a deleted skill
 * degrades to a plain message instead of an error that eats their draft.
 */
export async function loadSkillCommandText(
  command: Extract<ResolvedCommand, { kind: 'skill' }>,
  args: string,
): Promise<string> {
  const fallback = [COMMAND_PREFIX + command.name, args].filter(Boolean).join(' ');
  const raw = await fileStorage.readFileAsText(command.path).catch(() => null);
  if (raw === null) return fallback;

  const parsed = parseFrontmatter(raw);
  return expandSkillCommand({
    name: command.id,
    path: command.path,
    dir: parentDirPath(command.path),
    body: parsed.ok ? parsed.document.body : raw,
    args,
  });
}

