/**
 * Validation of a `SKILL.md` manifest against the Agent Skills specification.
 *
 * The rules are the specification's, and the failure policy is Pi's: a skill
 * with a missing `description` is not a skill (nothing can route to it), while
 * every other defect is a warning that still loads. A user editing their own
 * skill in the file manager should see why it is not being advertised, not lose
 * the file to a validation error.
 *
 * References: https://agentskills.io/specification
 */

export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_COMPATIBILITY_LENGTH = 500;

export interface SkillDiagnostic {
  level: 'warning' | 'error';
  /** Stable code for tests and (future) UI grouping; the message is for humans. */
  code: string;
  message: string;
  /** Storage path of the file the diagnostic is about. */
  path: string;
}

export interface Skill {
  /** Routing name from frontmatter (falls back to the directory name). */
  name: string;
  /** Routing description — what the model matches a task against. */
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  /** Experimental pre-approved tool list; parsed but not enforced. */
  allowedTools?: string[];
  /** When true the skill is hidden from the prompt index. */
  disableModelInvocation: boolean;
  /** Storage path of the skill's `SKILL.md`. */
  path: string;
  /** Storage directory of the skill, with a trailing slash. */
  dir: string;
  updatedAt: number;
}

export interface SkillValidationInput {
  /** Storage path of `SKILL.md`. */
  path: string;
  /** Parent directory of `SKILL.md`, with a trailing slash. */
  dir: string;
  /** Directory name, used for the spec's name/directory convention. */
  dirName: string;
  /** Parsed frontmatter. */
  data: Record<string, unknown>;
  updatedAt: number;
}

export interface SkillValidationResult {
  skill: Skill | null;
  diagnostics: SkillDiagnostic[];
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * `allowed-tools` is experimental and written either as one whitespace/comma
 * separated string (`Bash(git:*) Edit`) or as a YAML list; both forms are real
 * files, so both are accepted and normalised to a list.
 */
function asToolList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const tools = value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
    return tools.length > 0 ? tools : undefined;
  }
  const raw = asString(value);
  if (!raw) return undefined;
  const tools = raw.split(/[\s,]+/).filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined && item !== null)
    .map(([key, item]) => [key, typeof item === 'string' ? item : String(item)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return false;
}

/** Name rules from the specification. Returns human-readable problems. */
export function nameProblems(name: string): string[] {
  const problems: string[] = [];
  if (name.length > MAX_NAME_LENGTH) {
    problems.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    problems.push('name may only contain lowercase letters, numbers and hyphens');
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    problems.push('name must not start or end with a hyphen');
  }
  if (name.includes('--')) {
    problems.push('name must not contain consecutive hyphens');
  }
  return problems;
}

export function validateSkill(input: SkillValidationInput): SkillValidationResult {
  const diagnostics: SkillDiagnostic[] = [];
  const warn = (code: string, message: string) =>
    diagnostics.push({ level: 'warning', code, message, path: input.path });
  const fail = (code: string, message: string) =>
    diagnostics.push({ level: 'error', code, message, path: input.path });

  const declaredName = asString(input.data.name);
  const name = declaredName ?? input.dirName;
  if (!declaredName) {
    warn(
      'name-missing',
      `no "name" in frontmatter; using the directory name "${input.dirName}"`,
    );
  }
  for (const problem of nameProblems(name)) warn('name-invalid', problem);
  if (declaredName && declaredName !== input.dirName) {
    warn(
      'name-directory-mismatch',
      `name "${declaredName}" does not match the directory "${input.dirName}"; ` +
        'other Agent Skills implementations require them to match',
    );
  }

  const description = asString(input.data.description);
  if (!description) {
    fail('description-missing', 'a skill requires a non-empty "description" to be routable');
    return { skill: null, diagnostics };
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    warn(
      'description-too-long',
      `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`,
    );
  }

  const compatibility = asString(input.data.compatibility);
  if (compatibility && compatibility.length > MAX_COMPATIBILITY_LENGTH) {
    warn(
      'compatibility-too-long',
      `compatibility exceeds ${MAX_COMPATIBILITY_LENGTH} characters (${compatibility.length})`,
    );
  }

  if (input.data.metadata !== undefined && !asStringMap(input.data.metadata)) {
    warn('metadata-invalid', '"metadata" must be a mapping of string values');
  }

  if (input.data['allowed-tools'] !== undefined && !asToolList(input.data['allowed-tools'])) {
    warn('allowed-tools-invalid', '"allowed-tools" must be a list or a space-separated string');
  }

  return {
    skill: {
      name,
      description,
      ...(asString(input.data.license) ? { license: asString(input.data.license)! } : {}),
      ...(compatibility ? { compatibility } : {}),
      ...(asStringMap(input.data.metadata) ? { metadata: asStringMap(input.data.metadata)! } : {}),
      ...(asToolList(input.data['allowed-tools'])
        ? { allowedTools: asToolList(input.data['allowed-tools'])! }
        : {}),
      disableModelInvocation: asBoolean(input.data['disable-model-invocation']),
      path: input.path,
      dir: input.dir,
      updatedAt: input.updatedAt,
    },
    diagnostics,
  };
}
