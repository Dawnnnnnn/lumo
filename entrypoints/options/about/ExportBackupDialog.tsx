import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download,
  FileText,
  Loader2,
  MessageSquare,
  Settings2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { buildBackupZip } from '@/lib/backup';
import { downloadBlob } from '@/lib/zip-download';
import { formatBytes } from '@/lib/utils';
import type { StorageUsageReport } from '@/lib/storage-usage';
import type { BackupGroup, BackupSelection } from '@/lib/backup';
import { BackupGroupRow } from './BackupGroupRow';

const ALL_SELECTED: BackupSelection = { conversations: true, files: true, config: true };

/**
 * Choose what goes into a backup.
 *
 * The rows are the archive's top-level directories, one to one, so the dialog
 * teaches the format without a sentence of documentation: selecting
 * `Conversations` is selecting `conversations/`.
 */
export function ExportBackupDialog({
  open,
  onOpenChange,
  report,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  report: StorageUsageReport | null;
}) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState<BackupSelection>(ALL_SELECTED);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelection(ALL_SELECTED);
    setBusy(false);
    setFailed(false);
  }, [open]);

  const toggle = (group: BackupGroup) => {
    setFailed(false);
    setSelection((previous) => ({ ...previous, [group]: !previous[group] }));
  };

  const selectedCount = Object.values(selection).filter(Boolean).length;

  const handleExport = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const backup = await buildBackupZip(selection);
      await downloadBlob(backup.blob, backup.filename);
      onOpenChange(false);
    } catch (error) {
      console.error('[backup] export failed:', error);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t('options.about.backup.exportTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <BackupGroupRow
            icon={<MessageSquare className="h-4 w-4" />}
            label={t('options.about.backup.conversations')}
            detail={t('options.about.storage.conversationsCount', {
              count: report?.conversations.count ?? 0,
            })}
            checked={selection.conversations}
            onToggle={() => toggle('conversations')}
          />
          <BackupGroupRow
            icon={<FileText className="h-4 w-4" />}
            label={t('options.about.backup.files')}
            detail={
              report
                ? `${t('options.about.storage.filesCount', { count: report.files.count })} · ${formatBytes(
                    report.files.bytes,
                  )}`
                : undefined
            }
            checked={selection.files}
            onToggle={() => toggle('files')}
          />
          <BackupGroupRow
            icon={<Settings2 className="h-4 w-4" />}
            label={t('options.about.backup.config')}
            detail={t('options.about.backup.configDetail')}
            checked={selection.config}
            onToggle={() => toggle('config')}
          />

          {failed && (
            <p role="alert" className="text-xs text-destructive">
              {t('options.about.backup.exportError')}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => void handleExport()}
            disabled={busy || selectedCount === 0}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {busy ? t('options.about.backup.exporting') : t('common.export')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
