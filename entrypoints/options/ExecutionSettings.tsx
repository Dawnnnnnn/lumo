import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { DEFAULT_MAX_STEPS } from '@/lib/max-steps';
import {
  DEFAULT_COMPACTION_SETTINGS,
  KEEP_RECENT_TOKEN_PRESETS,
  MAX_COMPACTION_TOKENS,
  MIN_KEEP_RECENT_TOKENS,
} from '@/lib/compaction';
import {
  DEFAULT_TURN_NOTIFICATION,
  TURN_NOTIFICATION_MODES,
  type TurnNotificationMode,
} from '@/lib/turn-notification';
import { storage } from '@/store/storage';
import { MaxStepsField } from './components/MaxStepsField';
import { ReserveField } from './components/ReserveField';
import { TokenBudgetField } from './components/TokenBudgetField';
import { SettingRow } from './components/SettingRow';
import { SettingsGroup } from './components/SettingsGroup';
import { SettingsHeader } from './components/SettingsHeader';
import type { CompactionSettings } from '@/types';

/**
 * How a reply runs once it is sent: the tool-loop budget, when the user is told
 * it finished, and how the context window is kept from filling up.
 *
 * These used to sit inside Personalization, which is about how Lumo *looks* and
 * how the composer behaves — none of them change the interface, they change what
 * the agent is allowed to do. Storage is unchanged: all of it still lives in
 * `UISettings`, so nothing has to be migrated.
 */
export function ExecutionSettingsPage() {
  const { t } = useTranslation();
  const [maxSteps, setMaxSteps] = useState(DEFAULT_MAX_STEPS);
  const [turnNotification, setTurnNotification] = useState<TurnNotificationMode>(
    DEFAULT_TURN_NOTIFICATION,
  );
  const [compaction, setCompaction] = useState<CompactionSettings>(DEFAULT_COMPACTION_SETTINGS);
  const [programmaticTools, setProgrammaticTools] = useState(false);

  useEffect(() => {
    storage.getUISettings().then((settings) => {
      setMaxSteps(settings.maxSteps);
      setTurnNotification(settings.turnNotification ?? DEFAULT_TURN_NOTIFICATION);
      setCompaction(settings.compaction ?? DEFAULT_COMPACTION_SETTINGS);
      setProgrammaticTools(settings.programmaticTools === true);
    });
  }, []);

  const handleMaxStepsChange = async (steps: number) => {
    setMaxSteps(steps);
    const settings = await storage.getUISettings();
    await storage.setUISettings({ ...settings, maxSteps: steps });
  };

  const handleTurnNotificationChange = async (val: string) => {
    const mode = val as TurnNotificationMode;
    setTurnNotification(mode);
    const settings = await storage.getUISettings();
    await storage.setUISettings({ ...settings, turnNotification: mode });
  };

  const handleProgrammaticToolsChange = async (checked: boolean) => {
    setProgrammaticTools(checked);
    const settings = await storage.getUISettings();
    await storage.setUISettings({ ...settings, programmaticTools: checked });
  };

  const updateCompaction = async (patch: Partial<CompactionSettings>) => {
    const next = { ...compaction, ...patch };
    setCompaction(next);
    const settings = await storage.getUISettings();
    await storage.setUISettings({ ...settings, compaction: next });
  };

  return (
    <div className="max-w-2xl">
      <SettingsHeader
        title={t('options.execution.title')}
        description={t('options.execution.description')}
      />

      <div className="space-y-8">
        {/* What one reply is allowed to do, and how the user hears about it. */}
        <SettingsGroup title={t('options.execution.groupRun')}>
          <SettingRow
            label={t('options.execution.maxSteps')}
            description={t('options.execution.maxStepsDesc')}
          >
            <MaxStepsField value={maxSteps} onChange={handleMaxStepsChange} />
          </SettingRow>

          <SettingRow
            label={t('options.execution.turnNotification')}
            description={t('options.execution.turnNotificationDesc')}
          >
            <Select value={turnNotification} onValueChange={handleTurnNotificationChange}>
              <SelectTrigger
                className="w-40"
                aria-label={t('options.execution.turnNotification')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TURN_NOTIFICATION_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`options.execution.turnNotification_${mode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
        </SettingsGroup>

        {/* Context compaction: keeps long chats inside the model window. */}
        <SettingsGroup title={t('options.execution.groupCompaction')}>
          <SettingRow
            label={t('options.execution.compactionEnabled')}
            description={t('options.execution.compactionEnabledDesc')}
          >
            <Switch
              checked={compaction.enabled}
              onCheckedChange={(checked) => void updateCompaction({ enabled: checked })}
              aria-label={t('options.execution.compactionEnabled')}
            />
          </SettingRow>

          {/* Budgets only matter while compaction is on — hide them otherwise. */}
          {compaction.enabled && (
            <>
              <SettingRow
                label={t('options.execution.compactionReserve')}
                description={t('options.execution.compactionReserveDesc')}
              >
                <ReserveField
                  value={compaction.reserve}
                  onChange={(value) => void updateCompaction({ reserve: value })}
                />
              </SettingRow>

              <SettingRow label={t('options.execution.compactionKeepRecent')}>
                <TokenBudgetField
                  value={compaction.keepRecentTokens}
                  onChange={(value) => void updateCompaction({ keepRecentTokens: value })}
                  presets={KEEP_RECENT_TOKEN_PRESETS}
                  min={MIN_KEEP_RECENT_TOKENS}
                  max={MAX_COMPACTION_TOKENS}
                  ariaLabel={t('options.execution.compactionKeepRecent')}
                  placeholder="20000"
                />
              </SettingRow>
            </>
          )}
        </SettingsGroup>

        {/* Experimental shell mode. */}
        <SettingsGroup title={t('options.execution.groupExperimental')}>
          <SettingRow label={t('options.execution.programmaticTools')}>
            <Switch
              checked={programmaticTools}
              onCheckedChange={(checked) => void handleProgrammaticToolsChange(checked)}
              aria-label={t('options.execution.programmaticTools')}
            />
          </SettingRow>
        </SettingsGroup>
      </div>
    </div>
  );
}
