/**
 * What a skill package is, independent of where it came from.
 *
 * The importer is split into source → discovery → install because those are
 * genuinely different problems: a zip, a dropped folder, a GitHub archive and a
 * future registry all produce the same `PackageFile[]`, and everything after
 * that point is identical. Adding a source must not mean touching the installer.
 */
import type { Skill, SkillDiagnostic } from '../validate';

/** One file inside a package, with its path relative to the archive root. */
export interface PackageFile {
  path: string;
  data: Uint8Array;
}

/**
 * Anything that can produce the files of one or more skills.
 *
 * Implementations are expected to be lazy: `read()` is only called when the
 * user actually confirms an import, so a future network source never fetches a
 * package on page load.
 */
export interface SkillPackageSource {
  /** Short human-readable origin, used in diagnostics (e.g. a file name). */
  readonly label: string;
  read(): Promise<PackageFile[]>;
}

/** A validated, ready-to-install skill. */
export interface SkillPackage {
  /** Directory it will occupy under `skills/` — always a spec-valid name. */
  installName: string;
  /** The skill as the index will see it once installed. */
  skill: Skill;
  /** Files relative to the skill directory, including `SKILL.md`. */
  files: PackageFile[];
  /** Where the manifest came from inside the package, for diagnostics. */
  manifestPath: string;
}

export interface InstalledSkill {
  name: string;
  /** Storage directory of the installed skill, with a trailing slash. */
  path: string;
  files: number;
}

export type SkipReason = 'exists' | 'invalid' | 'unsupported';

export interface SkippedSkill {
  name: string;
  reason: SkipReason;
}

export interface SkillInstallOptions {
  /**
   * What to do when a skill of the same name is already installed.
   * `skip` (default) never destroys anything; `replace` swaps the directory.
   */
  onConflict?: 'skip' | 'replace';
}

export interface SkillImportResult {
  installed: InstalledSkill[];
  skipped: SkippedSkill[];
  diagnostics: SkillDiagnostic[];
  /** True when the package contained no manifest at all. */
  empty: boolean;
}
