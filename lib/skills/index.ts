/**
 * The skills index — `skills/<name>/SKILL.md` → the section of the system
 * prompt that tells the model which skills exist.
 *
 * ## Why the prompt carries an index and not the skills
 *
 * A skill's body is instructions, sometimes with scripts and references beside
 * it. Sending every body on every turn would spend the context window on
 * capabilities the task does not need. The index therefore carries only what
 * routing needs — name, description, and where the file is — and the model reads
 * the body with `file_read` when a task matches. This is the mechanism Pi uses,
 * and the Agent Skills specification's own integration model.
 *
 * ## Why it is rebuilt every turn
 *
 * `store/turn/runner.ts` snapshots the user's system prompt into the
 * conversation so a resumed run replays exactly what was sent. The skills index
 * is *not* part of that snapshot: creating or deleting a skill in another tab
 * must take effect on the next message, not on the next conversation. The index
 * is derived from storage each turn, cached in memory, and invalidated by the
 * `files:changed` event.
 */
import { onEvent } from '@/lib/event-bus';
import {
  baseName,
  fileStorage,
  parentDirPath,
  type FileMetadata,
} from '@/lib/mcp/file-storage';
import { SKILL_FILE_NAME, SKILLS_DIR } from './constants';
import { parseFrontmatter } from './frontmatter';
import { validateSkill, type Skill, type SkillDiagnostic } from './validate';

export { parseFrontmatter } from './frontmatter';
export {
  MAX_COMPATIBILITY_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  nameProblems,
  validateSkill,
} from './validate';
export type { Skill, SkillDiagnostic } from './validate';

export { SKILLS_DIR, SKILL_FILE_NAME } from './constants';

export interface SkillIndex {
  /** Routable skills, ordered by name for a stable prompt prefix. */
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}

let cache: Promise<SkillIndex> | null = null;
let subscribed = false;

/**
 * Whether a file change can change the index.
 *
 * Only paths under `skills/` matter: a note written from the chat invalidates
 * nothing, and a bulk clear that skipped `skills/` (see `fileStorage.clearFiles`)
 * leaves the index intact. Directory-only changes arrive with no names, which is
 * exactly the case where an emptied `skills/` directory could matter.
 */
export function affectsSkillIndex(names: readonly string[]): boolean {
  return names.length === 0 || names.some((name) => name.startsWith(SKILLS_DIR));
}

function ensureInvalidation(): void {
  if (subscribed) return;
  subscribed = true;
  onEvent('files:changed', (payload) => {
    if (affectsSkillIndex(payload.names)) cache = null;
  });
}

export function invalidateSkillIndex(): void {
  cache = null;
}

/** Rebuild the index now, ignoring whatever is cached. */
export function refreshSkillIndex(): Promise<SkillIndex> {
  cache = null;
  return getSkillIndex();
}

/** Read the index, building it once per change. */
export function getSkillIndex(): Promise<SkillIndex> {
  ensureInvalidation();
  if (!cache) {
    cache = loadSkillIndex().catch((error: unknown) => {
      // Never cache a failure: a transient storage error must not hide every
      // skill until the next file change.
      cache = null;
      throw error;
    });
  }
  return cache;
}

/** Code-unit order, so the prompt section is identical across browsers. */
function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build the index from storage.
 *
 * Only `SKILL.md` files are manifests; other files under a skill directory are
 * resources the body refers to. A directory with no manifest simply contributes
 * nothing, which is what lets a user draft a skill by writing its references
 * first.
 */
export async function loadSkillIndex(): Promise<SkillIndex> {
  const files = (await fileStorage.listByPrefix(SKILLS_DIR)).filter(
    // The installer stages a package under `skills/.staging-…/` before moving it
    // into place; nothing behind a dot segment is a skill.
    (file) => !file.name.slice(SKILLS_DIR.length).split('/').some((segment) => segment.startsWith('.')),
  );
  const manifests = files
    .filter((file) => baseName(file.name) === SKILL_FILE_NAME)
    .sort((a, b) => comparePaths(a.name, b.name));

  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const byName = new Map<string, Skill>();

  for (const manifest of manifests) {
    const raw = await fileStorage.readFileAsText(manifest.name);
    if (raw === null) continue;

    const parsed = parseFrontmatter(raw);
    if (!parsed.ok) {
      diagnostics.push({
        level: 'error',
        code: 'frontmatter-invalid',
        message: parsed.error,
        path: manifest.name,
      });
      continue;
    }

    const dir = parentDirPath(manifest.name);
    const result = validateSkill({
      path: manifest.name,
      dir,
      dirName: baseName(dir),
      data: parsed.document.data,
      updatedAt: manifest.updatedAt,
    });
    diagnostics.push(...result.diagnostics);
    if (!result.skill) continue;

    const existing = byName.get(result.skill.name);
    if (existing) {
      diagnostics.push({
        level: 'warning',
        code: 'name-collision',
        message: `skill name "${result.skill.name}" is already used by ${existing.path}; keeping the first`,
        path: manifest.name,
      });
      continue;
    }
    byName.set(result.skill.name, result.skill);
    skills.push(result.skill);
  }

  skills.sort((a, b) => comparePaths(a.name, b.name));
  return { skills, diagnostics };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Render the index for the system prompt, or `''` when nothing is routable.
 *
 * The shape is the Agent Skills / Pi `<available_skills>` block, because a model
 * that has been trained or prompted on it already knows how to use it. Paths are
 * storage paths — the same strings `file_read`, `file_list` and `file_edit` take —
 * so no translation layer sits between the prompt and the tools.
 */
export function formatSkillsIndex(index: SkillIndex): string {
  const visible = index.skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return '';

  const lines = [
    'The following skills provide specialized instructions for specific tasks.',
    'Read a skill\'s file with file_read when the task matches its description, then follow it.',
    'Relative paths in a skill resolve against its directory (the parent of SKILL.md); use file_list on that directory to see what it bundles.',
    '',
    '<available_skills>',
  ];
  for (const skill of visible) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.path)}</location>`);
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

/**
 * Append the skills index to the turn's system prompt.
 *
 * Failures are swallowed on purpose: storage being unavailable must not fail the
 * turn, and the user's own prompt is still valid without a capability index.
 */
export async function appendSkillsIndex(
  systemPrompt: string | undefined,
): Promise<string | undefined> {
  try {
    const section = formatSkillsIndex(await getSkillIndex());
    if (!section) return systemPrompt;
    return systemPrompt ? `${systemPrompt}\n\n${section}` : section;
  } catch (error) {
    console.error('[lumo] Failed to build the skills index:', error);
    return systemPrompt;
  }
}
