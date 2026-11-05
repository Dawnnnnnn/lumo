import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  BookOpen,
  Check,
  FileQuestion,
  Loader2,
  Replace,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { skillCommandName } from '@/lib/skills/commands';
import type { SkillCandidate, SkillInspection } from '@/lib/skills/import';
import { cn, formatBytes } from '@/lib/utils';

/**
 * Review step for every skill import.
 *
 * A package is a claim about what the user is installing, and it is usually a
 * claim they have not checked: a repository ships twelve skills, a folder they
 * were handed holds three, a zip contains one plus a variant they did not want.
 * This dialog is where that claim becomes a decision — nothing is written until
 * it is confirmed, even when the package holds a single skill (then the dialog is
 * a one-line confirmation, which is exactly the point: importing is a write).
 *
 * The card is the same shape as the Skills tab, because these are the same
 * objects: name, `/skill:<name>`, description, size, license, validation. A
 * candidate that cannot be installed is listed greyed with its reason rather than
 * hidden — "the package had something I could not use" is information.
 */
export function SkillImportDialog({
  inspection,
  importing,
  onCancel,
  onConfirm,
}: {
  /** What was found; `null` closes the dialog. */
  inspection: SkillInspection | null;
  importing: boolean;
  onCancel: () => void;
  onConfirm: (selected: SkillCandidate[]) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const candidates = useMemo(() => inspection?.candidates ?? [], [inspection]);

  /**
   * Seed the selection: everything installable that is not already installed.
   *
   * A skill that is already there starts unchecked on purpose. It can still be
   * chosen — that is how an update works — but replacing a tuned capability has
   * to be an act, not a default.
   */
  useEffect(() => {
    setSelected(
      new Set(candidates.filter((candidate) => candidate.plan.pkg && !candidate.installed).map((c) => c.id)),
    );
  }, [candidates]);

  const installable = candidates.filter((candidate) => candidate.plan.pkg !== null);
  const selectedCandidates = candidates.filter((candidate) => selected.has(candidate.id));
  const allInstallableSelected =
    installable.length > 0 && installable.every((candidate) => selected.has(candidate.id));

  const toggle = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog open={inspection !== null} onOpenChange={(open) => !open && onCancel()}>
      {/* Wider than the default form dialog (max-w-md): these are cards, not
          fields, and each one carries a name, a trigger, a description and a
          metadata line. `max-w-2xl` matches the width of the page behind it, so
          the list reads at the same measure as the Skills view. */}
      <DialogContent className="max-w-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t('skills.review.title')}</DialogTitle>
          <DialogDescription>
            {t('skills.review.found', { count: candidates.length })}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-1 max-h-[min(56vh,480px)] overflow-y-auto px-1 scrollbar-lumo">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground tabular-nums">
              {t('skills.review.selected', { count: selectedCandidates.length })}
            </span>
            {installable.length > 1 && (
              <button
                type="button"
                onClick={() =>
                  setSelected(
                    allInstallableSelected
                      ? new Set()
                      : new Set(installable.map((candidate) => candidate.id)),
                  )
                }
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {allInstallableSelected ? t('skills.review.selectNone') : t('skills.review.selectAll')}
              </button>
            )}
          </div>

          <div className="space-y-2">
            {candidates.map((candidate) => (
              <CandidateCard
                key={candidate.id}
                candidate={candidate}
                checked={selected.has(candidate.id)}
                onToggle={() => toggle(candidate.id)}
              />
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={importing}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => onConfirm(selectedCandidates)}
            disabled={importing || selectedCandidates.length === 0}
          >
            {importing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('skills.review.confirm', { count: selectedCandidates.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CandidateCard({
  candidate,
  checked,
  onToggle,
}: {
  candidate: SkillCandidate;
  checked: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const pkg = candidate.plan.pkg;
  const skill = pkg?.skill ?? null;
  const errors = candidate.plan.diagnostics.filter((diagnostic) => diagnostic.level === 'error');
  const warnings = candidate.plan.diagnostics.filter((diagnostic) => diagnostic.level === 'warning');

  return (
    /**
     * The whole card is the control.
     *
     * A `<label>` wrapping its own checkbox rather than a click handler on a div:
     * the browser then owns the semantics — clicking anywhere toggles, Space
     * toggles when the checkbox is focused, and a disabled candidate stays
     * untoggleable without any bespoke key handling.
     */
    <label
      className={cn(
        'flex items-start gap-2.5 rounded-lg border p-3 transition-colors',
        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
        pkg
          ? 'cursor-pointer border-border bg-card hover:bg-accent/40'
          : 'cursor-not-allowed border-dashed border-border bg-muted/30',
        checked && 'border-primary/60 bg-primary/5',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={!pkg}
        aria-label={skill?.name ?? candidate.discovered.manifestPath}
        className="mt-0.5 h-4 w-4 shrink-0 accent-primary disabled:opacity-40"
      />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <BookOpen
            className={cn('h-4 w-4 shrink-0', pkg ? 'text-primary' : 'text-muted-foreground')}
          />
          <span className={cn('truncate text-sm font-medium', !pkg && 'text-muted-foreground')}>
            {pkg?.installName ??
              (candidate.discovered.root.replace(/\/$/, '') || candidate.sourceLabel)}
          </span>
          {skill && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
              /{skillCommandName(skill.name)}
            </span>
          )}
          {candidate.installed && (
            <span
              className="flex shrink-0 items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-400"
              title={t('skills.review.replaceHint')}
            >
              <Replace className="h-3.5 w-3.5" />
              {t('skills.review.installed')}
            </span>
          )}
        </div>

        {skill?.description && (
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {skill.description}
          </p>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {t('options.files.totalFiles', { count: candidate.fileCount })}
          </span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{formatBytes(candidate.size)}</span>
          {skill?.license && (
            <>
              <span aria-hidden="true">·</span>
              <span>{skill.license}</span>
            </>
          )}
          {!pkg && (
            <>
              <span aria-hidden="true">·</span>
              <span className="flex items-center gap-1 text-muted-foreground">
                <FileQuestion className="h-3.5 w-3.5" />
                {t('skills.review.skip')}
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
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
            <span className="min-w-0 break-words">{diagnostic.message}</span>
          </p>
        ))}
      </div>
    </label>
  );
}
