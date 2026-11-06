import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, FileText, Loader2, MessageSquare, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { formatBytes } from '@/lib/utils';
import type {
  BackupGroup,
  BackupImportResult,
  BackupInspection,
  BackupSelection,
  LoadedBackup,
} from '@/lib/backup';
import { BackupGroupRow } from './BackupGroupRow';

const NO_SELECTION: BackupSelection = { conversations: false, files: false, config: false };

/**
 * Confirm, then apply, an imported archive.
 *
 * Nothing is written until this dialog is confirmed. The archive's own manifest
 * decides which rows exist, so a backup exported without files cannot offer to
 * import files it never contained. The conflict switch only appears when there
 * is a conflict to resolve — an import into an empty install is a two-click
 * action with no destructive choice to make.
 */
export function ImportBackupDialog({
  archive,
  inspection,
  onClose,
  onImport,
}: {
  archive: LoadedBackup | null;
  inspection: BackupInspection | null;
  onClose: () => void;
  onImport: (
    selection: BackupSelection,
    options: { overwrite: boolean },
  ) => Promise<BackupImportResult>;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<BackupGroup>>(new Set());
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [result, setResult] = useState<BackupImportResult | null>(null);

  useEffect(() => {
    if (!archive || !inspection) return;
    setSelected(new Set(inspection.available));
    setOverwrite(false);
    setBusy(false);
    setFailed(false);
    setResult(null);
  }, [archive, inspection]);

  const available = inspection?.available ?? [];
  const conflicts =
    (inspection?.conflicts.conversations ?? 0) + (inspection?.conflicts.files ?? 0);
  const selectedGroups = available.filter((group) => selected.has(group));

  const toggle = (group: BackupGroup) => {
    setFailed(false);
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const handleImport = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const selection = { ...NO_SELECTION };
      for (const group of selectedGroups) selection[group] = true;
      setResult(await onImport(selection, { overwrite }));
    } catch (error) {
      console.error('[backup] import failed:', error);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={archive !== null && inspection !== null}
      onOpenChange={(next) => !busy && !next && onClose()}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {result ? t('options.about.backup.importComplete') : t('options.about.backup.importTitle')}
          </DialogTitle>
        </DialogHeader>

        {result ? (
          <ImportSummary result={result} />
        ) : (
          <div className="space-y-2">
            {available.includes('conversations') && (
              <BackupGroupRow
                icon={<MessageSquare className="h-4 w-4" />}
                label={t('options.about.backup.conversations')}
                detail={t('options.about.storage.conversationsCount', {
                  count: inspection?.stats.conversations ?? 0,
                })}
                checked={selected.has('conversations')}
                onToggle={() => toggle('conversations')}
              />
            )}
            {available.includes('files') && (
              <BackupGroupRow
                icon={<FileText className="h-4 w-4" />}
                label={t('options.about.backup.files')}
                detail={`${t('options.about.storage.filesCount', {
                  count: inspection?.stats.files ?? 0,
                })} · ${formatBytes(inspection?.stats.fileBytes ?? 0)}`}
                checked={selected.has('files')}
                onToggle={() => toggle('files')}
              />
            )}
            {available.includes('config') && (
              <BackupGroupRow
                icon={<Settings2 className="h-4 w-4" />}
                label={t('options.about.backup.config')}
                detail={t('options.about.backup.configDetail')}
                checked={selected.has('config')}
                onToggle={() => toggle('config')}
              />
            )}

            {conflicts > 0 && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    {t('options.about.backup.overwrite')}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {t('options.about.backup.conflicts', { count: conflicts })}
                  </div>
                </div>
                <Switch
                  checked={overwrite}
                  onCheckedChange={setOverwrite}
                  disabled={busy}
                  aria-label={t('options.about.backup.overwrite')}
                />
              </div>
            )}

            {failed && (
              <p role="alert" className="text-xs text-destructive">
                {t('options.about.backup.importError')}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button type="button" onClick={onClose}>
              {t('common.close')}
            </Button>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                {t('common.cancel')}
              </Button>
              <Button
                type="button"
                onClick={() => void handleImport()}
                disabled={busy || selectedGroups.length === 0}
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {busy ? t('options.about.backup.importing') : t('common.import')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportSummary({ result }: { result: BackupImportResult }) {
  const { t } = useTranslation();
  const conversations =
    result.conversations.imported + result.conversations.skipped > 0;
  const files = result.files.imported + result.files.skipped > 0;

  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-3">
      <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
      {result.config && <p className="text-sm text-foreground">{t('options.about.backup.resultConfig')}</p>}
      {conversations && (
        <p className="text-sm text-foreground">
          {t('options.about.backup.resultConversations', {
            imported: result.conversations.imported,
            skipped: result.conversations.skipped,
          })}
        </p>
      )}
      {files && (
        <p className="text-sm text-foreground">
          {t('options.about.backup.resultFiles', {
            imported: result.files.imported,
            skipped: result.files.skipped,
          })}
        </p>
      )}
    </div>
  );
}
