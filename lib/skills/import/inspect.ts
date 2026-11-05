/**
 * Inspect-before-install.
 *
 * Importing is two phases, not one:
 *
 * ```
 * source.read() → discoverSkills() → planSkillPackage()   ← inspect (no writes)
 *              → user selects candidates                   ← review
 *              → installSkillPackage()                     ← staged move
 * ```
 *
 * The split exists because installing as we discover made the user the last to
 * know: a package could contain six skills, one of which was about to overwrite a
 * capability they had tuned, and the first they heard of it was a notice. Inspect
 * therefore returns everything the installer knows — including which candidates
 * are already installed and which cannot be installed at all — and nothing is
 * written until the caller confirms a selection.
 *
 * A candidate may carry its bytes already (a zip or a folder that was read to be
 * discovered) or promise them via `loadFiles` (a GitHub repository, where the
 * listing is one request and only the chosen skills are downloaded). The install
 * step does not care which, so adding a source never means touching it.
 */
import { discoverSkills, type DiscoveredSkill } from './discover';
import { installSkillPackage, isSkillDirectoryOccupied, planSkillPackage } from './install';
import type { SkillPlan } from './install';
import type { SkillDiagnostic } from '../validate';
import type {
  PackageFile,
  SkillImportResult,
  SkillInstallOptions,
  SkillPackageSource,
} from './types';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One skill a package offers, with everything a review screen needs.
 *
 * `files` is already in memory: reading a zip twice — once to inspect, once to
 * install — would decompress attacker-controlled bytes twice for no gain.
 */
export interface SkillCandidate {
  /** Stable selection key, unique across sources of one review. */
  id: string;
  /** Which package it came from, for the card's origin line. */
  sourceLabel: string;
  /** Discovery result: the skill root, its manifest path and its bytes. */
  discovered: DiscoveredSkill;
  /** Validation outcome. `plan.pkg === null` means it cannot be installed. */
  plan: SkillPlan;
  /** Bytes already in hand. Empty when the source only listed paths. */
  files: PackageFile[];
  /**
   * Fetch the bytes on demand, for sources that were inspected without
   * downloading (a repository tree). Root-relative paths, manifest included.
   */
  loadFiles?: () => Promise<PackageFile[]>;
  fileCount: number;
  size: number;
  /** True when `skills/<name>/` already holds something. */
  installed: boolean;
}

export interface SkillInspection {
  candidates: SkillCandidate[];
  /** Problems with the sources themselves (unreadable, no manifest). */
  diagnostics: SkillDiagnostic[];
  /** True when no source contained a manifest at all. */
  empty: boolean;
}

/** Name a candidate is reported under when it cannot be installed. */
function candidateLabel(candidate: DiscoveredSkill): string {
  return candidate.root === '' ? candidate.manifestPath : candidate.root.slice(0, -1);
}

/**
 * Read every source and describe what it offers, without writing anything.
 *
 * Sources are independent: a corrupt archive is reported and the next one is
 * still inspected. Within a source, skills are independent too — a manifest that
 * fails validation is offered as a disabled candidate rather than dropped, so the
 * user can see why it will not be installed.
 */
export async function inspectSkillPackages(
  sources: SkillPackageSource | SkillPackageSource[],
): Promise<SkillInspection> {
  const list = Array.isArray(sources) ? sources : [sources];
  const inspection: SkillInspection = { candidates: [], diagnostics: [], empty: true };

  for (const source of list) {
    let files: PackageFile[];
    try {
      files = await source.read();
    } catch (error) {
      inspection.diagnostics.push({
        level: 'error',
        code: 'source-unreadable',
        message: `${source.label}: ${describeError(error)}`,
        path: source.label,
      });
      continue;
    }

    const discovered = discoverSkills(files);
    if (discovered.length === 0) {
      inspection.diagnostics.push({
        level: 'warning',
        code: 'no-manifest',
        message: `"${source.label}" contains no SKILL.md`,
        path: source.label,
      });
      continue;
    }
    inspection.empty = false;

    for (const candidate of discovered) {
      const plan = planSkillPackage(candidate);
      const installed = plan.pkg ? await isSkillDirectoryOccupied(plan.pkg.skill.dir) : false;
      inspection.candidates.push({
        id: `${source.label}::${candidate.manifestPath}`,
        sourceLabel: source.label,
        discovered: candidate,
        plan,
        files: candidate.files,
        fileCount: candidate.files.length,
        size: candidate.files.reduce((sum, file) => sum + file.data.byteLength, 0),
        installed,
      });
    }
  }

  return inspection;
}

/**
 * Install the candidates the user chose.
 *
 * `onConflict: 'replace'` is the caller's decision, not a default: a review screen
 * only lets an already-installed skill be selected on purpose, so replacing is
 * what that click means. Callers with no review (see `importSkillPackages`) keep
 * the non-destructive `skip`.
 *
 * A candidate whose plan is null is reported as `invalid` rather than ignored: it
 * was discovered, it counts towards what the package contained, and a silent drop
 * would be indistinguishable from a bug.
 */
export async function installSkillCandidates(
  candidates: readonly SkillCandidate[],
  options: SkillInstallOptions = {},
): Promise<SkillImportResult> {
  const result: SkillImportResult = {
    installed: [],
    skipped: [],
    diagnostics: [],
    empty: false,
  };

  for (const candidate of candidates) {
    result.diagnostics.push(...candidate.plan.diagnostics);
    const pkg = candidate.plan.pkg;
    if (!pkg) {
      result.skipped.push({ name: candidateLabel(candidate.discovered), reason: 'invalid' });
      continue;
    }

    let files = candidate.files;
    if (files.length === 0 && candidate.loadFiles) {
      try {
        files = await candidate.loadFiles();
      } catch (error) {
        // A file that cannot be downloaded is reported against the skill it was
        // meant for, and the rest of the selection still installs.
        result.diagnostics.push({
          level: 'error',
          code: 'download-failed',
          message: `"${pkg.installName}": ${describeError(error)}`,
          path: pkg.manifestPath,
        });
        result.skipped.push({ name: pkg.installName, reason: 'unsupported' });
        continue;
      }
    }

    try {
      const outcome = await installSkillPackage({ ...pkg, files }, options);
      if (outcome.status === 'installed') {
        result.installed.push(outcome.installed);
      } else {
        result.skipped.push(outcome.skipped);
      }
    } catch (error) {
      // A storage failure on one skill must not abandon the rest of the
      // selection, and must be reported with the skill that failed.
      result.diagnostics.push({
        level: 'error',
        code: 'install-failed',
        message: `"${pkg.installName}": ${describeError(error)}`,
        path: pkg.manifestPath,
      });
      result.skipped.push({ name: pkg.installName, reason: 'unsupported' });
    }
  }

  return result;
}

/**
 * Import every skill found in `sources`, without asking.
 *
 * The one-shot form: inspect, then install all of it. Everything visible in a UI
 * should go through `inspectSkillPackages` + `installSkillCandidates` instead, so
 * the user decides before anything is written.
 */
export async function importSkillPackages(
  sources: SkillPackageSource | SkillPackageSource[],
  options: SkillInstallOptions = {},
): Promise<SkillImportResult> {
  const inspection = await inspectSkillPackages(sources);
  const result = await installSkillCandidates(inspection.candidates, options);
  return {
    ...result,
    diagnostics: [...inspection.diagnostics, ...result.diagnostics],
    empty: inspection.empty,
  };
}
