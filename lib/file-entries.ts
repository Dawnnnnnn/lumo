/**
 * Turning a flat list of stored paths into the rows the file list shows.
 *
 * `fileStorage.listFiles()` answers with one entry per path, newest first. That
 * is the right answer to "what do I have", but the wrong shape to read: a skill
 * is ten files under `skills/pdf-tools/`, and a skill with references is three
 * levels deep. The list therefore builds a tree from the path prefixes, so a
 * nested directory reads as a nested row instead of as a sibling that happens to
 * share the same prefix.
 *
 * Split from the component because it is the part worth testing: the ordering
 * rules (documents first, capabilities after, loose files last) and the search
 * semantics are decisions, not markup.
 */
import { baseName, isSystemPath, type FileMetadata } from '@/lib/mcp/file-storage';

export interface FolderNode {
  type: 'folder';
  /** Directory path, with a trailing slash. */
  prefix: string;
  /** This directory's own segment, e.g. `references` — not the whole path. */
  name: string;
  /** Nesting level; root entries are `0`. */
  depth: number;
  /** Immediate subdirectories and files, folders first, then files by name. */
  children: FileTreeNode[];
  /** Every file below this directory, at any depth. Deleting or zipping the
   *  folder acts on exactly this set, so it is stored rather than re-collected. */
  files: FileMetadata[];
  totalSize: number;
  /** True for extension-owned areas such as `skills/`. */
  system: boolean;
}

export interface FileNode {
  type: 'file';
  file: FileMetadata;
  /** Nesting level of the directory that holds it; root files are `0`. */
  depth: number;
}

export type FileTreeNode = FolderNode | FileNode;

/** Accumulator used while walking paths; only directories exist as nodes. */
interface DirNode {
  prefix: string;
  dirs: Map<string, DirNode>;
  files: FileMetadata[];
}

function emptyDir(prefix: string): DirNode {
  return { prefix, dirs: new Map(), files: [] };
}

/**
 * Walk a stored path into the accumulator, creating every ancestor directory on
 * the way down. Names are already normalised (`normalizeFilePath`), so a segment
 * is never empty and never `..`.
 */
function insertPath(root: DirNode, file: FileMetadata): void {
  const segments = file.name.split('/');
  let current = root;
  // The last segment is the file itself; the ones before it are directories.
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    let next = current.dirs.get(segment);
    if (!next) {
      next = emptyDir(`${current.prefix}${segment}/`);
      current.dirs.set(segment, next);
    }
    current = next;
  }
  current.files.push(file);
}

/** Every file below a set of already-built nodes. */
function collectFiles(nodes: FileTreeNode[]): FileMetadata[] {
  return nodes.flatMap((node) => (node.type === 'file' ? [node.file] : node.files));
}

/**
 * Nodes for one directory: folders first, then its own files, both by name.
 *
 * An ordinary directory holding exactly one file collapses into that file at the
 * directory's own level — `notes/report.md` is one document, not a folder the
 * user has to open. A system directory never collapses (a skill shipping only
 * its `SKILL.md` must read as one skill), and a directory that branches, however
 * little, keeps its structure.
 *
 * A collapsed file's displayed name is resolved by the renderer against the
 * *parent* prefix, so it keeps the relative path (`notes/report.md`) that says
 * where it actually lives.
 */
function buildNodes(dir: DirNode, depth: number): FileTreeNode[] {
  const folders: FolderNode[] = [...dir.dirs.values()]
    .map((child) => {
      const children = buildNodes(child, depth + 1);
      const files = collectFiles(children);
      return {
        type: 'folder' as const,
        prefix: child.prefix,
        name: baseName(child.prefix),
        depth,
        children,
        files,
        totalSize: files.reduce((sum, file) => sum + file.size, 0),
        system: isSystemPath(child.prefix),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const nodes: FileTreeNode[] = [];
  for (const folder of folders) {
    const onlyChild = folder.children[0];
    if (!folder.system && folder.children.length === 1 && onlyChild?.type === 'file') {
      nodes.push({ type: 'file', file: onlyChild.file, depth });
      continue;
    }
    nodes.push(folder);
  }

  for (const file of [...dir.files].sort((a, b) => a.name.localeCompare(b.name))) {
    nodes.push({ type: 'file', file, depth });
  }

  return nodes;
}

/**
 * The file list as a tree of path prefixes.
 *
 * Root ordering is deliberate. A system directory (`skills/`) is a capability
 * the user manages on the Skills tab, so it sorts *after* the documents that
 * share the root; loose files are the leftovers and go last, newest first.
 */
export function buildFileTree(files: FileMetadata[]): FileTreeNode[] {
  const root = emptyDir('');
  for (const file of files) insertPath(root, file);

  const nodes = buildNodes(root, 0);
  return [
    ...nodes
      .filter((node): node is FolderNode => node.type === 'folder')
      .sort((a, b) => {
        if (a.system !== b.system) return a.system ? 1 : -1;
        return a.prefix.localeCompare(b.prefix);
      }),
    ...nodes
      .filter((node): node is FileNode => node.type === 'file')
      .sort((a, b) => b.file.createdAt - a.file.createdAt),
  ];
}

/**
 * Filter by a search query, before building the tree.
 *
 * The query is matched against the path and against the conversation title, so
 * "quarterly report" finds the document and its filename at once. Filtering the
 * flat list keeps folder totals honest: a group shows the size of what survived
 * the search rather than the size of the whole directory.
 */
export function filterFiles(
  files: FileMetadata[],
  query: string,
  conversationTitle: (conversationId?: string) => string | null,
): FileMetadata[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return files;

  return files.filter((file) => {
    if (file.name.toLowerCase().includes(needle)) return true;
    const title = conversationTitle(file.conversationId);
    return title !== null && title.toLowerCase().includes(needle);
  });
}
