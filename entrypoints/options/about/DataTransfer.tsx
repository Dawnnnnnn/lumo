import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { applyLanguage } from '@/i18n';
import { applyTheme } from '@/lib/theme';
import { storage } from '@/store/storage';
import {
  applyBackup,
  inspectBackup,
  readBackupFile,
  type BackupImportResult,
  type BackupInspection,
  type BackupSelection,
  type LoadedBackup,
} from '@/lib/backup';
import type { StorageUsageReport } from '@/lib/storage-usage';
import { ExportBackupDialog } from './ExportBackupDialog';
import { ImportBackupDialog } from './ImportBackupDialog';

/**
 * Export and import one archive containing conversations, files and settings.
 *
 * Parsing and applying are separate clicks: choosing a zip only opens the review
 * dialog, and nothing is written until that dialog is confirmed. The config
 * actions on the page stay JSON and lightweight; this is the full backup path.
 */
export function DataTransfer({
  report,
  refresh,
}: {
  report: StorageUsageReport | null;
  refresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [archive, setArchive] = useState<LoadedBackup | null>(null);
  const [inspection, setInspection] = useState<BackupInspection | null>(null);
  const [reading, setReading] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setFailed(false);
    setReading(true);
    try {
      const loaded = await readBackupFile(file);
      const inspected = await inspectBackup(loaded);
      setArchive(loaded);
      setInspection(inspected);
    } catch (error) {
      console.error('[backup] could not read archive:', error);
      setFailed(true);
    } finally {
      setReading(false);
    }
  };

  const handleImport = async (
    selection: BackupSelection,
    options: { overwrite: boolean },
  ): Promise<BackupImportResult> => {
    if (!archive) throw new Error('No backup archive is loaded');

    const result = await applyBackup(archive, selection, options);

    // Settings are the only group whose effect is not visible through the data
    // itself: language and palette must be applied now, or the page keeps the
    // previous configuration until the next reload.
    if (result.config) {
      const settings = await storage.getUISettings();
      await applyLanguage(settings.language);
      applyTheme(settings.theme);
    }
    if (result.conversations.imported > 0) {
      await storage.bumpConversationsRevision();
    }
    await refresh();
    return result;
  };

  const closeImport = () => {
    setArchive(null);
    setInspection(null);
  };

  return (
    <>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={() => setExportOpen(true)}>
            <Download className="me-2 h-4 w-4" />
            {t('options.about.backup.export')}
          </Button>
          <Button
            variant="outline"
            onClick={() => inputRef.current?.click()}
            disabled={reading}
          >
            {reading ? (
              <Loader2 className="me-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="me-2 h-4 w-4" />
            )}
            {reading ? t('options.about.backup.reading') : t('options.about.backup.import')}
          </Button>
        </div>

        {failed && (
          <p role="alert" className="text-xs text-destructive">
            {t('options.about.backup.invalidArchive')}
          </p>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset before the async read so picking the same zip again still
          // fires a change event.
          event.target.value = '';
          void handleFile(file);
        }}
      />

      <ExportBackupDialog open={exportOpen} onOpenChange={setExportOpen} report={report} />
      <ImportBackupDialog
        archive={archive}
        inspection={inspection}
        onClose={closeImport}
        onImport={handleImport}
      />
    </>
  );
}
