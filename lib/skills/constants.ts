/**
 * Constants shared by the skill index, the importer and the command layer.
 *
 * They live in their own module because the importer must not import the index:
 * the index re-exports the importer's public API, and a cycle there would make
 * the constants undefined at module-evaluation time.
 */

/** Storage directory that holds installed skills. Owned by the extension. */
export const SKILLS_DIR = 'skills/';

/** The manifest file name. Case-sensitive: the specification is. */
export const SKILL_FILE_NAME = 'SKILL.md';

/** Directories the installer writes while it works; never part of a skill. */
export const STAGING_PREFIX = `${SKILLS_DIR}.staging-`;
export const TRASH_PREFIX = `${SKILLS_DIR}.trash-`;
