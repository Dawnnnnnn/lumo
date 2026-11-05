/**
 * Turning a discovered package into an installed skill.
 *
 * The install is staged: the files are written under
 * `skills/.staging-<id>/` and the whole directory is then moved into place in a
 * single IndexedDB transaction. A crash, a quota error or a rejected manifest
 * therefore never leaves a half-written skill that the index would advertise —
 * either `skills/<name>/SKILL.md` exists with all its files, or nothing does.
 *
 * Replacing an existing skill moves the old directory to `skills/.trash-<id>/`
 * first and deletes it only after the new one is in place, so the operation
 * fails towards the old copy rather than towards nothing.
 */
import { baseName, fileStorage, inferMimeType } from '@/lib/mcp/file-storage';
import { SKILL_FILE_NAME, SKILLS_DIR, STAGING_PREFIX, TRASH_PREFIX } from '../constants';
import { parseFrontmatter } from '../frontmatter';
import { validateSkill, type Skill, type SkillDiagnostic } from '../validate';
import type { DiscoveredSkill } from './discover';
import type {
  InstalledSkill,
  SkippedSkill,
  SkillInstallOptions,
  SkillPackage,
} from './types';

/**
 * A name usable as a directory *and* as a `/skill:<name>` trigger.
 *
 * The Agent Skills specification already requires lowercase letters, digits and
 * hyphens, so this is a stricter read of the same rule: a name containing a
 * space could not be typed after `/`, and one containing a slash would escape
 * its own directory.
 */
const INSTALLABLE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export interface SkillPlan {
  pkg: SkillPackage | null;
  diagnostics: SkillDiagnostic[];
}

/**
 * Validate a discovered package and resolve where it will live.
 *
 * A manifest without a `description` is not installable (nothing can route to
 * it), and neither is one whose name cannot be a directory — both are reported
 * with the reason rather than quietly renamed.
 */
export function planSkillPackage(discovered: DiscoveredSkill): SkillPlan {
  const parsed = parseFrontmatter(discovered.manifestText);
  if (!parsed.ok) {
    return {
      pkg: null,
      diagnostics: [
        {
          level: 'error',
          code: 'frontmatter-invalid',
          message: parsed.error,
          path: discovered.manifestPath,
        },
      ],
    };
  }

  const archiveDirName = discovered.root === '' ? '' : baseName(discovered.root);
  const validated = validateSkill({
    path: discovered.manifestPath,
    dir: discovered.root,
    dirName: archiveDirName || 'skill',
    data: parsed.document.data,
    updatedAt: Date.now(),
  });
  const diagnostics = validated.diagnostics;
  if (!validated.skill) return { pkg: null, diagnostics };

  const declared = validated.skill.name;
  if (!INSTALLABLE_NAME.test(declared)) {
    diagnostics.push({
      level: 'error',
      code: 'name-unusable',
      message:
        `"${declared}" cannot be installed: a skill name must use lowercase letters, ` +
        'digits and single hyphens (it is also the `/skill:<name>` trigger)',
      path: discovered.manifestPath,
    });
    return { pkg: null, diagnostics };
  }

  const dir = `${SKILLS_DIR}${declared}/`;
  const skill: Skill = {
    ...validated.skill,
    name: declared,
    path: `${dir}${SKILL_FILE_NAME}`,
    dir,
  };

  return {
    pkg: {
      installName: declared,
      skill,
      files: discovered.files,
      manifestPath: discovered.manifestPath,
    },
    diagnostics,
  };
}

export type InstallOutcome =
  | { status: 'installed'; installed: InstalledSkill }
  | { status: 'skipped'; skipped: SkippedSkill };

/**
 * Whether installing this package would collide with what is already stored.
 *
 * The same test the install itself makes — any file at the target directory is a
 * conflict, not just a manifest — so a review screen cannot promise "new" for a
 * skill the installer would then refuse to touch.
 */
export async function isSkillDirectoryOccupied(dir: string): Promise<boolean> {
  return (await fileStorage.listByPrefix(dir)).length > 0;
}

/** Write a package's files under `stagingDir`. */
async function writePackage(pkg: SkillPackage, stagingDir: string): Promise<void> {
  for (const file of pkg.files) {
    const target = `${stagingDir}${file.path}`;
    // Copied into a plain `ArrayBuffer`-backed view so the Blob constructor
    // accepts it under every TS lib configuration.
    const bytes = new Uint8Array(file.data.byteLength);
    bytes.set(file.data);
    await fileStorage.writeFile(target, new Blob([bytes]), {
      mimeType: inferMimeType(file.path),
    });
  }
}

/**
 * Remove a directory and everything under it.
 *
 * Used for staging and trash only. Failures are swallowed: a leftover dot
 * directory is invisible to the index and to the file manager, and reporting it
 * would turn a successful install into an error.
 */
export async function discardDirectory(dir: string): Promise<void> {
  try {
    const files = await fileStorage.listByPrefix(dir);
    for (const file of files) {
      await fileStorage.deleteFile(file.name);
    }
    await fileStorage.deleteDirectory(dir).catch(() => undefined);
  } catch {
    // Leftovers are harmless; see above.
  }
}

export async function installSkillPackage(
  pkg: SkillPackage,
  options: SkillInstallOptions = {},
): Promise<InstallOutcome> {
  const stagingDir = `${STAGING_PREFIX}${crypto.randomUUID()}/`;
  const trashDir = `${TRASH_PREFIX}${crypto.randomUUID()}/`;
  const targetDir = pkg.skill.dir;

  try {
    if (pkg.files.length === 0) {
      return { status: 'skipped', skipped: { name: pkg.installName, reason: 'unsupported' } };
    }
    await writePackage(pkg, stagingDir);

    // Any file at the target is a conflict, not just a manifest: a directory
    // left half-written by an earlier failure must not be merged into.
    const existing = await fileStorage.listByPrefix(targetDir);
    if (existing.length > 0) {
      if (options.onConflict !== 'replace') {
        return { status: 'skipped', skipped: { name: pkg.installName, reason: 'exists' } };
      }
      await fileStorage.movePath(targetDir, trashDir);
    }

    await fileStorage.movePath(stagingDir, targetDir);

    return {
      status: 'installed',
      installed: { name: pkg.installName, path: targetDir, files: pkg.files.length },
    };
  } finally {
    await discardDirectory(stagingDir);
    await discardDirectory(trashDir);
  }
}
