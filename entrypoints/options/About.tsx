import { useTranslation } from 'react-i18next';
import { applyLanguage } from '@/i18n';
import { Download, RefreshCw, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/lib/theme';
import { storage } from '@/store/storage';
import { SettingsGroup } from './components/SettingsGroup';
import { SettingsHeader } from './components/SettingsHeader';
import { AboutIdentity } from './about/AboutIdentity';
import { AboutLinks } from './about/AboutLinks';
import { DataTransfer } from './about/DataTransfer';
import { StorageUsageCard } from './about/StorageUsageCard';
import { useStorageUsage } from './about/useStorageUsage';

/**
 * Version, install channel, links, and what Lumo's data costs.
 *
 * Grouped on one page because all three answer the same class of question — the
 * ones a user asks when reporting a bug or wondering where their disk went, and
 * which no other settings page could answer.
 */
export function AboutPage() {
  const { t, i18n } = useTranslation();
  const { setTheme } = useTheme();
  const usage = useStorageUsage();

  const handleExport = async () => {
    try {
      const config = await storage.exportConfig();
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lumo-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
    }
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const config = JSON.parse(text);
        await storage.importConfig(config);
        // Apply imported UI preferences (language/theme) immediately.
        const settings = await storage.getUISettings();
        await applyLanguage(settings.language);
        await setTheme(settings.theme);
        void usage.refresh(true);
        alert(t('options.about.importExport.importSuccess'));
      } catch {
        alert(t('options.about.importExport.importError'));
      }
    };
    input.click();
  };

  return (
    <div className="max-w-2xl">
      <SettingsHeader
        title={t('options.about.title')}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void usage.refresh()}
            disabled={usage.loading}
          >
            <RefreshCw className={`me-2 h-4 w-4 ${usage.loading ? 'animate-spin' : ''}`} />
            {t('options.about.refresh')}
          </Button>
        }
      />

      <div className="space-y-8">
        <AboutIdentity />

        <SettingsGroup title={t('options.about.groupLinks')}>
          <AboutLinks />
        </SettingsGroup>

        <SettingsGroup title={t('options.about.storage.title')}>
          <StorageUsageCard {...usage} />
        </SettingsGroup>

        <SettingsGroup title={t('options.about.backup.title')}>
          <DataTransfer report={usage.report} refresh={() => usage.refresh(true)} />
        </SettingsGroup>

        <SettingsGroup title={t('options.about.importExport.title')}>
          <div className="flex gap-3">
            <Button variant="outline" onClick={handleExport}>
              <Download className="me-2 h-4 w-4" />
              {t('options.about.importExport.exportConfig')}
            </Button>
            <Button variant="outline" onClick={handleImport}>
              <Upload className="me-2 h-4 w-4" />
              {t('options.about.importExport.importConfig')}
            </Button>
          </div>
        </SettingsGroup>
      </div>
    </div>
  );
}
