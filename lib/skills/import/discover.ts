/**
 * Finding skills inside a package.
 *
 * A package is just files. What makes it a skill package is the presence of one
 * or more `SKILL.md` manifests, and the directory each manifest sits in becomes
 * that skill's root — this is what makes every one of these work without a
 * special case:
 *
 * ```
 * SKILL.md                        → one skill at the archive root
 * pdf-tools/SKILL.md              → one skill in a directory
 * repo-main/skills/a/SKILL.md     → a GitHub zip, one skill
 * repo-main/skills/a/SKILL.md
 * repo-main/skills/b/SKILL.md     → a GitHub zip, two skills
 * ```
 *
 * Files are returned relative to the root, so the installer never has to know
 * how deeply the manifest was nested.
 */
import { strFromU8 } from 'fflate';
import { baseName, parentDirPath } from '@/lib/mcp/file-storage';
import { SKILL_FILE_NAME } from '../constants';
import { isIgnoredPackagePath } from './archive';
import type { PackageFile } from './types';

export interface DiscoveredSkill {
  /** Directory of the manifest inside the package (`''` at the package root). */
  root: string;
  /** Path of `SKILL.md` inside the package, for diagnostics. */
  manifestPath: string;
  /** The manifest's text, frontmatter included. */
  manifestText: string;
  /** Files relative to `root`, including the manifest itself. */
  files: PackageFile[];
}

/** Code-unit order, so a package always installs in the same sequence. */
function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every skill root in the package.
 *
 * A manifest nested inside another manifest's directory is carved out of the
 * outer skill: bundling one skill inside another is legal on disk, but copying
 * the inner one into both would install it twice.
 */
export function discoverSkills(files: PackageFile[]): DiscoveredSkill[] {
  const manifests = files
    .filter((file) => baseName(file.path) === SKILL_FILE_NAME)
    .sort((a, b) => comparePaths(a.path, b.path));
  if (manifests.length === 0) return [];

  const roots = manifests.map((manifest) => parentDirPath(manifest.path));

  return manifests.map((manifest, index) => {
    const root = roots[index]!;
    const nestedRoots = roots.filter((other) => {
      if (other === root) return false;
      if (root === '') return other !== '';
      return other.startsWith(root);
    });

    const scoped = files
      .filter((file) => file.path.startsWith(root))
      .filter((file) => !nestedRoots.some((nested) => file.path.startsWith(nested)))
      .map((file) => ({ path: file.path.slice(root.length), data: file.data }))
      .filter((file) => file.path !== '' && !isIgnoredPackagePath(file.path));

    return {
      root,
      manifestPath: manifest.path,
      manifestText: strFromU8(manifest.data),
      files: scoped,
    };
  });
}
