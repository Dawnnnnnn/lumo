import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  inspectGitHubImport,
  type GitHubFailureReason,
  type GitHubPhase,
  type SkillInspection,
} from '@/lib/skills/import';
import { formatBytes } from '@/lib/utils';

const FAILURE_KEYS: Record<GitHubFailureReason, string> = {
  'invalid-url': 'skills.github.invalidUrl',
  'not-found': 'skills.github.notFound',
  'rate-limited': 'skills.github.rateLimited',
  'too-large': 'skills.github.tooLarge',
  network: 'skills.github.network',
  aborted: 'skills.github.network',
};

const PHASE_KEYS: Record<GitHubPhase, string> = {
  scan: 'skills.github.scanning',
  manifests: 'skills.github.reading',
  archive: 'skills.github.downloading',
};

/**
 * Read a GitHub repository and hand the result to the same review every other
 * channel uses.
 *
 * The dialog decides nothing about *how* a repository is read: listing the tree
 * and downloading only the chosen skills is the default, and the archive is the
 * fallback when that path is blocked, rate limited or too large to list. Both
 * produce a `SkillInspection`, so the next screen (and the installer) cannot tell
 * which one ran — which is why this component stays a form plus a status line.
 *
 * Progress is measured in received bytes and only while the archive is being
 * downloaded: GitHub streams it chunked without a `Content-Length`, and the tree
 * path transfers megabytes of nothing in particular.
 */
export function GitHubImportDialog({
  open,
  onClose,
  onPrepared,
}: {
  open: boolean;
  onClose: () => void;
  /** Called with what the repository offers; the caller opens the review. */
  onPrepared: (inspection: SkillInspection) => void;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<GitHubPhase | 'idle'>('idle');
  const [received, setReceived] = useState(0);
  const [failure, setFailure] = useState<GitHubFailureReason | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const busy = phase !== 'idle';

  // A previous attempt's error or byte count must not leak into the next open.
  useEffect(() => {
    if (!open) return;
    setUrl('');
    setPhase('idle');
    setReceived(0);
    setFailure(null);
    abortRef.current?.abort();
    abortRef.current = null;
  }, [open]);

  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('scan');
    setReceived(0);
    setFailure(null);

    const result = await inspectGitHubImport(url, {
      signal: controller.signal,
      onPhase: (next) => {
        if (abortRef.current === controller) setPhase(next);
      },
      onProgress: (progress) => {
        if (abortRef.current === controller) setReceived(progress.receivedBytes);
      },
    });

    if (abortRef.current !== controller) return; // superseded by a close/reopen
    abortRef.current = null;
    setPhase('idle');

    if (result.ok) {
      onPrepared(result.inspection);
      onClose();
      return;
    }
    if (result.reason === 'aborted') return;
    setFailure(result.reason);
  };

  const cancel = () => {
    // Abort first so the in-flight request stops spending bandwidth, then close.
    abortRef.current?.abort();
    abortRef.current = null;
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && cancel()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t('skills.github.title')}</DialogTitle>
        </DialogHeader>

        <form onSubmit={start} className="flex flex-col gap-4">
          <Field
            label={t('skills.github.url')}
            hint={t('skills.github.hint')}
            error={failure ? t(FAILURE_KEYS[failure]) : undefined}
          >
            {(props) => (
              <Input
                {...props}
                type="text"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  if (failure) setFailure(null);
                }}
                placeholder="https://github.com/owner/repo"
                dir="ltr"
                spellCheck={false}
                autoComplete="off"
                // The repository address is the only thing to type, so typing
                // starts as soon as the dialog opens.
                autoFocus
                disabled={busy}
                className="font-mono text-xs"
              />
            )}
          </Field>

          {phase !== 'idle' && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className={phase === 'archive' ? 'tabular-nums' : undefined}>
                {t(PHASE_KEYS[phase])}
                {phase === 'archive' && ` · ${t('skills.github.received', { size: formatBytes(received) })}`}
              </span>
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={cancel}>
              {busy ? t('skills.github.stop') : t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || url.trim() === ''}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('skills.github.download')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
