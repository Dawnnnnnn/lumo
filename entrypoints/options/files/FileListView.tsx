import { createContext, useContext, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import {
  BookOpen,
  ChevronRight,
  Download,
  Eye,
  File as FileBase,
  FileCode,
  FileText,
  Folder,
  Image,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  SearchX,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { setFileRefDragData } from '@/lib/file-drag';
import {
  buildFileTree,
  filterFiles,
  type FileNode,
  type FileTreeNode,
  type FolderNode,
} from '@/lib/file-entries';
import { getPreviewCategory, type FileMetadata } from '@/lib/mcp';
import { cn, formatBytes } from '@/lib/utils';
import { ConfirmDeleteBar } from '@/entrypoints/options/components/ConfirmDeleteBar';
import { EmptyLibrary } from './EmptyLibrary';

/**
 * Shared row grid.
 *
 * One template for the header and every row, so a column cannot be added to the
 * header and forgotten in a row. Below `sm` only name and actions remain — the
 * window a sidebar-and-panel layout leaves is often that narrow, and five columns
 * there would truncate every cell to its first character. Size, source and date
 * move under the name instead of disappearing.
 */
const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 sm:grid-cols-[minmax(0,1fr)_56px_112px_88px_auto]';

/** Action cluster: quiet until the row is hovered or focused, always visible when narrow. */
const ROW_ACTIONS =
  'flex items-center justify-end opacity-100 transition-opacity sm:opacity-0 sm:group-hover/row:opacity-100 sm:group-focus-within/row:opacity-100';

/**
 * Indentation per nesting level, applied to the name cell only.
 *
 * Padding the whole grid would shift size, source and date at every depth, so a
 * column would stop lining up with its own header. Only the name column carries
 * the depth; the numbers stay in place.
 */
const INDENT_PX = 16;

const nameIndent = (depth: number): CSSProperties => ({
  paddingInlineStart: depth * INDENT_PX,
});

const confirmIndent = (depth: number): CSSProperties => ({
  paddingInlineStart: depth * INDENT_PX,
});

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString();
}

function MimeIcon({ mimeType }: { mimeType: string }) {
  const category = getPreviewCategory(mimeType);
  switch (category) {
    case 'image':
      return <Image className="h-4 w-4 shrink-0 text-green-500" />;
    case 'text':
      if (
        mimeType.includes('javascript') ||
        mimeType.includes('typescript') ||
        mimeType.includes('json')
      ) {
        return <FileCode className="h-4 w-4 shrink-0 text-blue-500" />;
      }
      return <FileText className="h-4 w-4 shrink-0 text-orange-500" />;
    default:
      return <FileBase className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
}

export interface FileListViewProps {
  files: FileMetadata[];
  /** Current search text; owned by the page so the toolbar can host the input. */
  query: string;
  loading: boolean;
  canDragToSidePanel: boolean;
  /** Path (file name or directory prefix) whose delete is in flight. */
  deleting: string | null;
  /** Path whose zip download is in flight. */
  downloading: string | null;
  conversationTitle: (conversationId?: string) => string | null;
  onPreview: (name: string) => void;
  onDownload: (name: string) => void;
  onDownloadFolder: (prefix: string, members: FileMetadata[]) => void;
  onDelete: (path: string) => void;
}

/**
 * What every row needs, passed once.
 *
 * The tree is recursive, so drilling a dozen handlers through each level would
 * make every new row action a signature change in four places. A context keeps
 * the recursion reading as `node → row` and keeps the handlers defined in one
 * scope, next to the state they change.
 */
interface FileTreeHandlers {
  /** A search is active: matching folders stay open so hits are never hidden. */
  searching: boolean;
  /** Per-folder expansions overrides; absent means "use the default". */
  expansion: Record<string, boolean>;
  confirming: string | null;
  deleting: string | null;
  downloading: string | null;
  canDragToSidePanel: boolean;
  conversationTitle: (conversationId?: string) => string | null;
  onToggle: (prefix: string, open: boolean) => void;
  onRequestDelete: (path: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (path: string) => void;
  onPreview: (name: string) => void;
  onDownload: (name: string) => void;
  onDownloadFolder: (prefix: string, members: FileMetadata[]) => void;
}

const FileTreeContext = createContext<FileTreeHandlers | null>(null);

function useFileTree(): FileTreeHandlers {
  const handlers = useContext(FileTreeContext);
  if (!handlers) throw new Error('File rows must render inside FileListView');
  return handlers;
}

/** Top-level folders open by default; deeper ones stay folded until asked. */
function defaultOpen(node: FolderNode, searching: boolean): boolean {
  return searching || node.depth === 0;
}

/**
 * The files view: the documents Lumo produced, plus whatever the user uploaded.
 *
 * Rows carry one action cluster behind a menu rather than three always-visible
 * buttons each: a table whose right edge is a wall of icons stops reading as
 * data. Destructive confirmation collapses in place, so the row being deleted
 * stays visible while the user decides.
 */
export function FileListView({
  files,
  query,
  loading,
  canDragToSidePanel,
  deleting,
  downloading,
  conversationTitle,
  onPreview,
  onDownload,
  onDownloadFolder,
  onDelete,
}: FileListViewProps) {
  const { t } = useTranslation();
  // One path at a time: opening a second row's confirmation closes the first.
  const [confirming, setConfirming] = useState<string | null>(null);
  // Expansion is remembered per prefix, so a live refresh (`files:changed`)
  // redraws the tree without folding everything the user had opened. Search
  // ignores these defaults and opens matching folders; an explicit toggle still
  // wins while the query is on screen.
  const [expansion, setExpansion] = useState<Record<string, boolean>>({});

  const visible = useMemo(
    () => filterFiles(files, query, conversationTitle),
    [files, query, conversationTitle],
  );
  const tree = useMemo(() => buildFileTree(visible), [visible]);
  const searching = query.trim() !== '';
  const totalSize = visible.reduce((sum, file) => sum + file.size, 0);

  /**
   * Opening the confirmation is deferred by a tick: Radix restores focus to the
   * menu trigger when the menu closes, and the bar's confirm button takes focus
   * on mount. Mounting it inside that same tick would leave focus on the trigger
   * instead — the keyboard affordance the native `confirm()` used to provide.
   */
  const requestDelete = (path: string) => {
    window.setTimeout(() => setConfirming(path), 0);
  };
  const cancelDelete = () => setConfirming(null);
  const confirmDelete = (path: string) => {
    setConfirming(null);
    onDelete(path);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="me-2 h-5 w-5 animate-spin" />
        <span>{t('common.loading')}</span>
      </div>
    );
  }

  if (files.length === 0) {
    return <EmptyLibrary icon={<FileBase className="h-5 w-5" aria-hidden />} label={t('options.files.noFiles')} />;
  }

  const handlers: FileTreeHandlers = {
    searching,
    expansion,
    confirming,
    deleting,
    downloading,
    canDragToSidePanel,
    conversationTitle,
    onToggle: (prefix, open) => setExpansion((previous) => ({ ...previous, [prefix]: open })),
    onRequestDelete: requestDelete,
    onCancelDelete: cancelDelete,
    onConfirmDelete: confirmDelete,
    onPreview,
    onDownload,
    onDownloadFolder,
  };

  return (
    <div>
      <div className="mb-3 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {t('options.files.summary', { count: visible.length, size: formatBytes(totalSize) })}
        </span>
      </div>

      {tree.length === 0 ? (
        <EmptyLibrary
          icon={<SearchX className="h-5 w-5" aria-hidden />}
          label={t('options.files.noResults', { query })}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <div
            className={cn(
              ROW_GRID,
              'border-b border-border bg-muted/50 p-3 text-xs font-medium text-muted-foreground',
            )}
          >
            <span className="truncate">{t('options.files.name')}</span>
            <span className="hidden sm:block">{t('options.files.size')}</span>
            <span className="hidden sm:block">{t('options.files.source')}</span>
            <span className="hidden sm:block">{t('options.files.createdAt')}</span>
            <span className="text-end">{t('options.files.actions')}</span>
          </div>

          <FileTreeContext.Provider value={handlers}>
            <div className="divide-y divide-border">
              <FileTreeNodes nodes={tree} parentPrefix="" />
            </div>
          </FileTreeContext.Provider>
        </div>
      )}
    </div>
  );
}

/**
 * One level of the tree.
 *
 * `parentPrefix` is the directory this level is drawn under, not the directory a
 * file lives in. They differ for a collapsed folder (`notes/report.md` shown at
 * the root of `notes/`'s parent), and the difference is what keeps the displayed
 * name honest about where the file actually is.
 */
function FileTreeNodes({ nodes, parentPrefix }: { nodes: FileTreeNode[]; parentPrefix: string }) {
  return (
    <>
      {nodes.map((node) =>
        node.type === 'folder' ? (
          <FolderRow key={node.prefix} node={node} />
        ) : (
          <FileRow key={node.file.name} node={node} parentPrefix={parentPrefix} />
        ),
      )}
    </>
  );
}

function FolderRow({ node }: { node: FolderNode }) {
  const { t } = useTranslation();
  const tree = useFileTree();
  const open = tree.expansion[node.prefix] ?? defaultOpen(node, tree.searching);
  const confirming = tree.confirming === node.prefix;
  const deleting = tree.deleting === node.prefix;
  const downloading = tree.downloading === node.prefix;
  // `skills/` aggregates every installed skill: deleting it would erase all of
  // them at once. It keeps download (a backup of the whole set) and leaves
  // deletion to the individual skills, where the confirmation names one skill.
  const canDelete = !(node.system && node.depth === 0);

  return (
    <div>
      <div
        className={cn(
          ROW_GRID,
          'group/row p-3 transition-colors hover:bg-accent/50',
          confirming && 'bg-destructive/5',
        )}
      >
        <button
          type="button"
          // The name cell is the disclosure control. A click handler on the whole
          // row would wrap the menu button inside a button — invalid markup that
          // also swallows the menu's own keyboard handling.
          onClick={() => tree.onToggle(node.prefix, !open)}
          aria-expanded={open}
          style={nameIndent(node.depth)}
          className="flex min-w-0 items-center gap-2 rounded-sm text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <motion.span
            animate={{ rotate: open ? 90 : 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="shrink-0"
          >
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground rtl:-scale-x-100" />
          </motion.span>
          {node.system ? (
            <BookOpen className="h-4 w-4 shrink-0 text-primary" />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-amber-500" />
          )}
          <span className="truncate text-sm font-medium" title={node.prefix}>
            {node.name}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {t('options.files.fileCount', { count: node.files.length })}
          </span>
        </button>

        <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
          {formatBytes(node.totalSize)}
        </span>
        <span className="hidden sm:block" />
        <span className="hidden sm:block" />

        <div className={ROW_ACTIONS}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                aria-label={t('options.files.actions')}
              >
                {deleting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <MoreHorizontal className="h-3.5 w-3.5" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                disabled={downloading}
                onSelect={() => tree.onDownloadFolder(node.prefix, node.files)}
              >
                {downloading ? <Loader2 className="animate-spin" /> : <Download />}
                {t('options.files.downloadFolder')}
              </DropdownMenuItem>
              {canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    destructive
                    disabled={deleting}
                    onSelect={() => tree.onRequestDelete(node.prefix)}
                  >
                    <Trash2 />
                    {t('options.files.deleteFolder')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ConfirmDeleteBar
        open={confirming}
        message={t('options.files.deleteFolderConfirm', {
          folder: node.prefix,
          count: node.files.length,
        })}
        onConfirm={() => tree.onConfirmDelete(node.prefix)}
        onCancel={tree.onCancelDelete}
        style={confirmIndent(node.depth)}
      />

      <motion.div
        initial={false}
        animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="overflow-hidden"
      >
        <div className="border-t border-border/50">
          <FileTreeNodes nodes={node.children} parentPrefix={node.prefix} />
        </div>
      </motion.div>
    </div>
  );
}

function FileRow({ node, parentPrefix }: { node: FileNode; parentPrefix: string }) {
  const { t } = useTranslation();
  const tree = useFileTree();
  const file = node.file;
  const conversationTitle = tree.conversationTitle(file.conversationId);
  const confirming = tree.confirming === file.name;
  const deleting = tree.deleting === file.name;
  const previewable = getPreviewCategory(file.mimeType) !== 'unsupported';
  // Relative to the level this row is drawn at: a file inside a folder shows its
  // own name, a collapsed folder keeps the prefix that says where it lives.
  const displayName = file.name.slice(parentPrefix.length);

  /**
   * The row itself is the drag handle — dragging it into an open side panel adds
   * the file as a reference chip. A dedicated grip icon was deliberately not
   * added: the gesture is the one users already know from the side panel's own
   * file list.
   *
   * `draggable` stays spelled out even when it is false: the attribute is what
   * states the row's capability, and it keeps a non-draggable row identifiable
   * as a row rather than as an anonymous block.
   */
  return (
    <div>
      <div
        draggable={tree.canDragToSidePanel}
        onDragStart={(event) => setFileRefDragData(event.dataTransfer, file.name)}
        title={tree.canDragToSidePanel ? t('options.files.dragHint') : undefined}
        className={cn(
          ROW_GRID,
          'group/row p-3 transition-colors hover:bg-accent/50',
          tree.canDragToSidePanel && 'active:cursor-grabbing',
          confirming && 'bg-destructive/5',
        )}
      >
        <div className="flex min-w-0 flex-col gap-0.5" style={nameIndent(node.depth)}>
          <div className="flex min-w-0 items-center gap-2">
            {/* Empty disclosure gutter, so a file's icon lines up with the icon
                of the folder it sits in rather than with that folder's chevron. */}
            <span className="w-3.5 shrink-0" aria-hidden="true" />
            <MimeIcon mimeType={file.mimeType} />
            <span className="truncate text-sm font-medium" title={file.name}>
              {displayName}
            </span>
          </div>
          {/* Narrow layout: the columns below collapse into this second line. */}
          <div className="flex min-w-0 items-center gap-1.5 ps-[2.875rem] text-xs text-muted-foreground sm:hidden">
            <span className="shrink-0 tabular-nums">{formatBytes(file.size)}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{conversationTitle ?? t('options.files.noConversation')}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0 tabular-nums">{formatDate(file.createdAt)}</span>
          </div>
        </div>

        <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
          {formatBytes(file.size)}
        </span>

        <div className="hidden min-w-0 items-center gap-1 sm:flex">
          {conversationTitle ? (
            <span
              className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground"
              title={conversationTitle}
            >
              <MessageSquare className="h-3 w-3 shrink-0" />
              <span className="truncate">{conversationTitle}</span>
            </span>
          ) : (
            <span className="truncate text-xs text-muted-foreground">
              {t('options.files.noConversation')}
            </span>
          )}
        </div>

        <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
          {formatDate(file.createdAt)}
        </span>

        <div className={ROW_ACTIONS}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                aria-label={t('options.files.actions')}
              >
                {deleting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <MoreHorizontal className="h-3.5 w-3.5" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {previewable && (
                <DropdownMenuItem onSelect={() => tree.onPreview(file.name)}>
                  <Eye />
                  {t('options.files.preview')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => tree.onDownload(file.name)}>
                <Download />
                {t('options.files.download')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                destructive
                disabled={deleting}
                onSelect={() => tree.onRequestDelete(file.name)}
              >
                <Trash2 />
                {t('options.files.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ConfirmDeleteBar
        open={confirming}
        message={t('options.files.deleteConfirm')}
        onConfirm={() => tree.onConfirmDelete(file.name)}
        onCancel={tree.onCancelDelete}
        style={confirmIndent(node.depth)}
      />
    </div>
  );
}
