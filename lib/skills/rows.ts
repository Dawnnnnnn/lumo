/**
 * What the Skills tab lists, derived from the skills index and the file list.
 *
 * The index is the authority on what is *routable*: a manifest without a
 * `description` produces no `Skill`, only a diagnostic. A management view that
 * read the file list instead would therefore never show the very skill the user
 * needs to fix — which is the case they opened this page for. So rows are built
 * from both: the index supplies capability and validation, the file list
 * supplies counts and sizes.
 *
 * A directory under `skills/` with no manifest at all still gets a row. It is
 * invisible to the index by design (a skill may be drafted references-first), but
 * a folder of files that the Skills tab does not mention is a folder the user
 * cannot reach from the place that claims to manage skills.
 */
import { isSystemPath, parentDirPath, type FileMetadata } from '@/lib/mcp/file-storage';
import { SKILLS_DIR, SKILL_FILE_NAME } from './constants';
import type { Skill, SkillDiagnostic } from './validate';

export interface SkillRow {
  /** Skill directory, with a trailing slash. */
  dir: string;
  /** Display name: the manifest's `name`, or the directory's. */
  name: string;
  /** The routable skill, or `null` when the manifest is missing or rejected. */
  skill: Skill | null;
  description?: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  hiddenFromModel: boolean;
  /** Errors and warnings about this skill's manifest, verbatim. */
  diagnostics: SkillDiagnostic[];
  /** Files under the directory, at any depth. */
  fileCount: number;
  size: number;
  updatedAt: number;
}

export interface SkillIndexLike {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}

/** Top-level directory a path belongs to inside `skills/`. */
function skillDirOf(path: string): string | null {
  if (!path.startsWith(SKILLS_DIR)) return null;
  const rest = path.slice(SKILLS_DIR.length);
  const slash = rest.indexOf('/');
  // A file directly inside `skills/` is not part of any skill.
  if (slash <= 0) return null;
  const segment = rest.slice(0, slash);
  if (segment.startsWith('.')) return null; // `.staging-…`, `.trash-…`
  return `${SKILLS_DIR}${segment}/`;
}

function blankRow(dir: string): SkillRow {
  return {
    dir,
    name: dir.slice(SKILLS_DIR.length, -1),
    skill: null,
    hiddenFromModel: false,
    diagnostics: [],
    fileCount: 0,
    size: 0,
    updatedAt: 0,
  };
}

/**
 * The manifest a row can open, when there is one.
 *
 * A skill without a routable manifest still has a `SKILL.md` — that is how it
 * produced a diagnostic — and that file is exactly what the user needs to edit.
 * A directory with no manifest at all has nothing to open.
 */
export function skillManifestPath(row: SkillRow): string | null {
  if (row.skill) return row.skill.path;
  const manifest = row.diagnostics.find((diagnostic) => diagnostic.path.endsWith(SKILL_FILE_NAME));
  return manifest?.path ?? null;
}

function hasErrors(row: SkillRow): boolean {
  return row.diagnostics.some((diagnostic) => diagnostic.level === 'error');
}

/**
 * Rows for the Skills tab.
 *
 * Errors sort to the top: a skill that does not load is the reason someone opens
 * a management screen, and burying it alphabetically would make the one row that
 * needs attention the hardest to find.
 */
export function buildSkillRows(index: SkillIndexLike, files: FileMetadata[]): SkillRow[] {
  const rows = new Map<string, SkillRow>();

  const ensure = (dir: string): SkillRow => {
    const existing = rows.get(dir);
    if (existing) return existing;
    const row = blankRow(dir);
    rows.set(dir, row);
    return row;
  };

  for (const skill of index.skills) {
    const row = ensure(skill.dir);
    row.name = skill.name;
    row.skill = skill;
    row.description = skill.description;
    row.license = skill.license;
    row.compatibility = skill.compatibility;
    row.allowedTools = skill.allowedTools;
    row.hiddenFromModel = skill.disableModelInvocation;
    row.updatedAt = Math.max(row.updatedAt, skill.updatedAt);
  }

  for (const diagnostic of index.diagnostics) {
    // A diagnostic names the manifest it is about, so its directory identifies
    // the skill — including the ones that never became a `Skill`.
    const dir = diagnostic.path.endsWith(SKILL_FILE_NAME)
      ? parentDirPath(diagnostic.path)
      : (skillDirOf(diagnostic.path) ?? '');
    if (dir === '') continue;
    ensure(dir).diagnostics.push(diagnostic);
  }

  for (const file of files) {
    // Skill directories are the only place counts are worth showing; `chat/`
    // totals live in the conversation list, not here.
    if (!isSystemPath(file.name)) continue;
    const dir = skillDirOf(file.name);
    if (dir === null) continue;
    const row = ensure(dir);
    row.fileCount += 1;
    row.size += file.size;
    row.updatedAt = Math.max(row.updatedAt, file.updatedAt);
  }

  return [...rows.values()].sort((a, b) => {
    const errors = Number(hasErrors(b)) - Number(hasErrors(a));
    if (errors !== 0) return errors;
    return a.name.localeCompare(b.name);
  });
}
