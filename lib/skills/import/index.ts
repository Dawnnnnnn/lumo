/**
 * Skill package import.
 *
 * ```
 * source.read() → discoverSkills() → planSkillPackage()   ← inspect (no writes)
 *              → user selects candidates                   ← review
 *              → installSkillPackage()                     ← staged move
 *   zip/folder/GitHub      manifests       validate + where
 * ```
 *
 * The phases live in `./inspect`; this module is the door: sources, inspection,
 * installation, and the GitHub entry point that decides how to obtain a
 * repository (tree + raw by default, archive when that path is unavailable).
 *
 * Each stage is a separate module because each answers a different question, and
 * because a partial failure must be reportable rather than fatal: one broken
 * manifest in a package of five must not block the other four.
 */
export * from './types';
export { MAX_ARCHIVE_BYTES, MAX_FILE_BYTES, MAX_PACKAGE_FILES, isIgnoredPackagePath, unpackZipArchive } from './archive';
export { discoverSkills } from './discover';
export type { DiscoveredSkill } from './discover';
export { installSkillPackage, isSkillDirectoryOccupied, planSkillPackage } from './install';
export type { SkillPlan } from './install';
export {
  inspectSkillPackages,
  installSkillCandidates,
  importSkillPackages,
} from './inspect';
export type { SkillCandidate, SkillInspection } from './inspect';
export {
  directoryEntriesFromFiles,
  directoryPackageSource,
  packageFilesSource,
  urlPackageSource,
  zipPackageSource,
} from './sources';
export type { PickedFile, SourceEntry } from './sources';
export {
  downloadGitHubZip,
  inspectGitHubImport,
  parseGitHubUrl,
  scanGitHubSkills,
} from './github';
export type {
  GitHubDownloadProgress,
  GitHubDownloadResult,
  GitHubFailureReason,
  GitHubInspectionResult,
  GitHubPhase,
  GitHubRepoRef,
  GitHubSkillEntry,
} from './github';
export { isEmptyDrop, readDroppedFiles } from './browser';
export type { DroppedPayload } from './browser';
