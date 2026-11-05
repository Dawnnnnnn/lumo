import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  BookOpen,
  Check,
  Copy,
  Download,
  EyeOff,
  FileQuestion,
  Loader2,
  MoreHorizontal,
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
import { skillCommandName } from '@/lib/skills/commands';
import { skillManifestPath, type SkillRow } from '@/lib/skills/rows';
import { cn, formatBytes } from '@/lib/utils';
import { ConfirmDeleteBar } from '@/entrypoints/options/components/ConfirmDeleteBar';
import { EmptyLibrary } from './EmptyLibrary';

export interface SkillListViewProps {
  rows: SkillRow[];
  loading: boolean;
  brokenCount: number;
  /** Directory whose delete is in flight. */
  deleting: string | null;
  /** Directory whose zip download is in flight. */
  downloading: string | null;
  onOpen: (row: SkillRow) => void;
  onDownload: (row: SkillRow) => void;
  onDelete: (row: SkillRow) => void;
}

function formatDate(timestamp: number): string {
  return timestamp === 0 ? '—' : new Date(timestamp).toLocaleDateString();
}

/**
 * The skills view: what Lumo can do, and why a skill might not be doing it.
 *
 * A skill is not a row of files with a different icon. It has a name, a routing
 * description (the part that actually decides whether the model ever loads it), a
 * validation state, and a `/skill:<name>` trigger. Those are the columns here.
 *
 * Diagnostics are rendered inline and unprompted: they are the reason this view
 * exists, and a badge the user has to click to understand would hide the one
 * thing that is broken.
 */
export function SkillListView({
  rows,
  loading,
  brokenCount,
  deleting,
  downloading,
  onOpen,
  onDownload,
  onDelete,
}: SkillListViewProps) {
  const { t } = useTranslation();
  // One path at a time: opening a second row's confirmation closes the first.
  const [confirming, setConfirming] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="me-2 h-5 w-5 animate-spin" />
        <span>{t('common.loading')}</span>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyLibrary icon={<BookOpen className="h-5 w-5" aria-hidden />} label={t('skills.list.empty')} />
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span className="tabular-nums">{t('skills.list.installed', { count: rows.length })}</span>
        {brokenCount > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-destructive">
            <AlertTriangle className="h-3 w-3" />
            {t('skills.list.needsAttention', { count: brokenCount })}
          </span>
        )}
      </div>

      {/* One card per skill, spaced like the command and MCP lists: a skill is
          not a row in a ledger, it is a thing with its own actions. */}
      <div className="space-y-2">
        {rows.map((row) => (
          <SkillRowView
            key={row.dir}
            row={row}
            fileCount={row.fileCount}
            confirming={confirming === row.dir}
            deleting={deleting === row.dir}
            downloading={downloading === row.dir}
            // Deferred so the bar's confirm button wins focus over the menu
            // trigger Radix restores focus to on close.
            onRequestDelete={() => setTimeout(() => setConfirming(row.dir), 0)}
            onCancelDelete={() => setConfirming(null)}
            onConfirmDelete={() => {
              setConfirming(null);
              onDelete(row);
            }}
            onOpen={onOpen}
            onDownload={onDownload}
          />
        ))}
      </div>
    </div>
  );
}

function SkillRowView({
  row,
  fileCount,
  confirming,
  deleting,
  downloading,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  onOpen,
  onDownload,
}: {
  row: SkillRow;
  fileCount: number;
  confirming: boolean;
  deleting: boolean;
  downloading: boolean;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onOpen: (row: SkillRow) => void;
  onDownload: (row: SkillRow) => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const manifestPath = skillManifestPath(row);
  const command = row.skill ? skillCommandName(row.skill.name) : null;
  const errors = row.diagnostics.filter((diagnostic) => diagnostic.level === 'error');
  const warnings = row.diagnostics.filter((diagnostic) => diagnostic.level === 'warning');

  const copyCommand = async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(`/${command}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the trigger stays selectable text.
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div
        className={cn(
          'group/row p-3 transition-colors hover:bg-accent/50',
          confirming && 'bg-destructive/5',
        )}
      >
        <div className="flex items-start gap-2">
          <BookOpen
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0',
              errors.length > 0 ? 'text-destructive' : 'text-primary',
            )}
          />

          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate text-sm font-medium">{row.name}</span>
              {command ? (
                <button
                  type="button"
                  onClick={() => void copyCommand()}
                  title={command ? t('skills.list.copyCommand') : undefined}
                  className="flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  /{command}
                </button>
              ) : (
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{row.dir}</span>
              )}
              {row.hiddenFromModel && (
                // Icon only: the state is unambiguous next to the trigger, and the
                // tooltip carries the sentence for anyone who wants it.
                <span
                  className="flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
                  title={t('skills.list.hiddenFromModel')}
                >
                  <EyeOff className="h-3.5 w-3.5" />
                </span>
              )}
            </div>

            {row.description && (
              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {row.description}
              </p>
            )}

            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="tabular-nums">{t('options.files.totalFiles', { count: fileCount })}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{formatBytes(row.size)}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{t('skills.list.updated', { date: formatDate(row.updatedAt) })}</span>
              {row.license && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{row.license}</span>
                </>
              )}
              {row.allowedTools && row.allowedTools.length > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="truncate font-mono">
                    {row.allowedTools.slice(0, 3).join(' ')}
                    {row.allowedTools.length > 3 ? ' …' : ''}
                  </span>
                </>
              )}
            </div>

            {errors.map((diagnostic) => (
              <p
                key={`${diagnostic.code}-${diagnostic.path}`}
                className="mt-1 flex items-start gap-1.5 text-xs text-destructive"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 break-words">{diagnostic.message}</span>
              </p>
            ))}
            {warnings.map((diagnostic) => (
              <p
                key={`${diagnostic.code}-${diagnostic.path}`}
                className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 break-words">{diagnostic.message}</span>
              </p>
            ))}
            {!row.skill && errors.length === 0 && (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <FileQuestion className="h-3.5 w-3.5 shrink-0" />
                {t('skills.list.noManifest')}
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center opacity-100 transition-opacity sm:opacity-0 sm:group-hover/row:opacity-100 sm:group-focus-within/row:opacity-100">
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
                <DropdownMenuItem disabled={!manifestPath} onSelect={() => onOpen(row)}>
                  <BookOpen />
                  {t('skills.list.open')}
                </DropdownMenuItem>
                {command && (
                  <DropdownMenuItem onSelect={() => void copyCommand()}>
                    <Copy />
                    {t('skills.list.copyCommand')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem disabled={downloading} onSelect={() => onDownload(row)}>
                  {downloading ? <Loader2 className="animate-spin" /> : <Download />}
                  {t('skills.list.download')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive disabled={deleting} onSelect={onRequestDelete}>
                  <Trash2 />
                  {t('skills.list.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

      <ConfirmDeleteBar
        open={confirming}
        message={t('skills.list.deleteConfirm', { name: row.name, count: fileCount })}
        onConfirm={onConfirmDelete}
        onCancel={onCancelDelete}
      />
      </div>
    </div>
  );
}
