import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CornerDownLeft } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTheme, THEME_OPTIONS } from '@/lib/theme';
import { DEFAULT_FONT_SIZE, FONT_SIZE_OPTIONS } from '@/lib/font-size';
import { DEFAULT_PASTE_THRESHOLD } from '@/lib/paste-threshold';
import {
  BUSY_SEND_BEHAVIORS,
  DEFAULT_BUSY_SEND,
  normalizeBusySend,
  type BusySendBehavior,
} from '@/lib/busy-send';
import { cn, isMacPlatform } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { storage } from '@/store/storage';
import { PasteThresholdField } from './components/PasteThresholdField';
import { LanguagePicker } from '@/components/ui/language-picker';
import { SettingRow } from './components/SettingRow';
import { SettingsGroup } from './components/SettingsGroup';
import { SettingsHeader } from './components/SettingsHeader';
import type {
  SendKey,
  Theme,
  FontSize,
  UISettings,
  MessageToolbarSettings,
  MessageActionVisibility,
  MessageActionToggle,
} from '@/types';
import { applyLanguage } from '@/i18n';

function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-border bg-muted px-1 font-mono text-[11px] leading-none text-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

function SendKeyBadge({ value }: { value: SendKey }) {
  const mac = isMacPlatform();
  const enterKey = (
    <Kbd>
      <CornerDownLeft className="h-3 w-3" />
    </Kbd>
  );
  if (value === 'enter') {
    return <span className="flex items-center gap-1">{enterKey}</span>;
  }
  // "Meta" is a loose shorthand: any modifier key triggers send.
  // Show the platform-appropriate modifiers: ⌘/⌥/⇧ on macOS, Ctrl/Alt/⇧ elsewhere.
  const modifiers = mac ? ['⌘', '⌥', '⇧'] : ['Ctrl', 'Alt', '⇧'];
  return (
    <span className="flex items-center gap-1">
      {modifiers.map((m, i) => (
        <span key={m} className="flex items-center gap-1">
          {i > 0 && <span className="text-muted-foreground">/</span>}
          <Kbd>{m}</Kbd>
        </span>
      ))}
      <span className="text-muted-foreground">+</span>
      {enterKey}
    </span>
  );
}

export function UISettingsPage() {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [language, setLanguage] = useState<UISettings['language']>('auto');
  const [fontSize, setFontSize] = useState<FontSize>(DEFAULT_FONT_SIZE);
  const [maxSplitPanels, setMaxSplitPanels] = useState<UISettings['maxSplitPanels']>(1);
  const [sendKey, setSendKey] = useState<UISettings['sendKey']>('enter');
  const [busySend, setBusySend] = useState<BusySendBehavior>(DEFAULT_BUSY_SEND);
  const [pasteThreshold, setPasteThreshold] = useState(DEFAULT_PASTE_THRESHOLD);
  const [autoCollapseReasoning, setAutoCollapseReasoning] = useState(true);
  const [messageToolbar, setMessageToolbar] = useState<MessageToolbarSettings>({
    copy: 'all',
    regenerate: 'show',
    delete: 'all',
    usage: 'show',
  });

  useEffect(() => {
    storage.getUISettings().then((settings) => {
      setLanguage(settings.language);
      setFontSize(settings.fontSize ?? DEFAULT_FONT_SIZE);
      setMaxSplitPanels(settings.maxSplitPanels ?? 1);
      setSendKey(settings.sendKey ?? 'enter');
      setBusySend(settings.busySend ?? DEFAULT_BUSY_SEND);
      setPasteThreshold(settings.pasteThreshold);
      setAutoCollapseReasoning(settings.autoCollapseReasoning);
      setMessageToolbar(settings.messageToolbar ?? {
        copy: 'all',
        regenerate: 'show',
        delete: 'all',
        usage: 'show',
      });
    });
  }, []);

  const handleLanguageChange = async (value: UISettings['language']) => {
    setLanguage(value);
    await applyLanguage(value);
    const settings = await storage.getUISettings();
    await storage.setUISettings({ ...settings, language: value });
  };

  const handleThemeChange = async (val: string) => {
    await setTheme(val as Theme);
  };

  const handleFontSizeChange = async (val: string) => {
    const size = Number(val) as FontSize;
    setFontSize(size);
    const settings = await storage.getUISettings();
    await storage.setUISettings({ ...settings, fontSize: size });
  };

  const handleMaxSplitPanelsChange = async (val: string) => {
    const panels = Number(val) as UISettings['maxSplitPanels'];
    setMaxSplitPanels(panels);
    const settings = await storage.getUISettings();
    await storage.setUISettings({ ...settings, maxSplitPanels: panels });
  };

  const handleSendKeyChange = async (val: string) => {
    const key = val as UISettings['sendKey'];
    setSendKey(key);
    const settings = await storage.getUISettings();
    await storage.setUISettings({ ...settings, sendKey: key });
  };

  const handleBusySendChange = async (val: string) => {
    const behavior = normalizeBusySend(val);
    setBusySend(behavior);
    const settings = await storage.getUISettings();
    await storage.setUISettings({ ...settings, busySend: behavior });
  };

  const handlePasteThresholdChange = async (threshold: number) => {
    setPasteThreshold(threshold);
    const settings = await storage.getUISettings();
    await storage.setUISettings({ ...settings, pasteThreshold: threshold });
  };

  const handleAutoCollapseReasoningChange = async (checked: boolean) => {
    setAutoCollapseReasoning(checked);
    const settings = await storage.getUISettings();
    await storage.setUISettings({ ...settings, autoCollapseReasoning: checked });
  };

  const handleToolbarChange = async <K extends keyof MessageToolbarSettings>(
    key: K,
    value: MessageToolbarSettings[K],
  ) => {
    const next = { ...messageToolbar, [key]: value };
    setMessageToolbar(next);
    const settings = await storage.getUISettings();
    await storage.setUISettings({ ...settings, messageToolbar: next });
  };

  return (
    <div className="max-w-2xl">
      <SettingsHeader
        title={t('options.ui.title')}
        description={t('options.ui.description')}
      />

      <div className="space-y-8">
        {/* Extension-wide: applies everywhere Lumo renders. */}
        <SettingsGroup title={t('options.ui.groupGeneral')}>
          <SettingRow label={t('options.ui.language')}>
            <LanguagePicker value={language} onChange={handleLanguageChange} />
          </SettingRow>

          <SettingRow label={t('options.ui.theme')}>
            <Select value={theme} onValueChange={handleThemeChange}>
              <SelectTrigger className="w-40" aria-label={t('options.ui.theme')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THEME_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {t(opt.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow label={t('options.ui.fontSize')}>
            <Select value={String(fontSize)} onValueChange={handleFontSizeChange}>
              <SelectTrigger className="w-40" aria-label={t('options.ui.fontSize')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FONT_SIZE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={String(opt.value)}>
                    {t(opt.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
        </SettingsGroup>

        {/* Side panel and composer behaviour. */}
        <SettingsGroup title={t('options.ui.groupSidebar')}>
          <SettingRow
            label={t('options.ui.maxSplitPanels')}
            description={t('options.ui.maxSplitPanelsDesc')}
          >
            <Select value={String(maxSplitPanels)} onValueChange={handleMaxSplitPanelsChange}>
              <SelectTrigger className="w-40" aria-label={t('options.ui.maxSplitPanels')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1</SelectItem>
                <SelectItem value="2">2</SelectItem>
                <SelectItem value="3">3</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow label={t('options.ui.sendKey')} description={t('options.ui.sendKeyDesc')}>
            <Select value={sendKey} onValueChange={handleSendKeyChange}>
              <SelectTrigger className="w-52" aria-label={t('options.ui.sendKey')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="enter">
                  <SendKeyBadge value="enter" />
                </SelectItem>
                <SelectItem value="meta-enter">
                  <SendKeyBadge value="meta-enter" />
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            label={t('options.ui.busySend')}
            description={t('options.ui.busySendDesc')}
          >
            <Select value={busySend} onValueChange={handleBusySendChange}>
              <SelectTrigger className="w-52" aria-label={t('options.ui.busySend')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BUSY_SEND_BEHAVIORS.map((behavior) => (
                  <SelectItem key={behavior} value={behavior}>
                    {t(`options.ui.busySend_${behavior}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            label={t('options.ui.pasteThreshold')}
            description={t('options.ui.pasteThresholdDesc')}
          >
            <PasteThresholdField
              value={pasteThreshold}
              onChange={handlePasteThresholdChange}
            />
          </SettingRow>

          <SettingRow
            label={t('options.ui.autoCollapseReasoning')}
            description={t('options.ui.autoCollapseReasoningDesc')}
          >
            <Switch
              checked={autoCollapseReasoning}
              onCheckedChange={handleAutoCollapseReasoningChange}
              aria-label={t('options.ui.autoCollapseReasoning')}
            />
          </SettingRow>
        </SettingsGroup>

        {/* Message toolbar action visibility. */}
        <SettingsGroup title={t('options.ui.groupMessageToolbar')}>
          <SettingRow label={t('options.ui.toolbarCopy')}>
            <Select
              value={messageToolbar.copy}
              onValueChange={(val) => handleToolbarChange('copy', val as MessageActionVisibility)}
            >
              <SelectTrigger className="w-40" aria-label={t('options.ui.toolbarCopy')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('options.ui.visibilityAll')}</SelectItem>
                <SelectItem value="assistant">{t('options.ui.visibilityAssistant')}</SelectItem>
                <SelectItem value="user">{t('options.ui.visibilityUser')}</SelectItem>
                <SelectItem value="hidden">{t('options.ui.visibilityHidden')}</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow label={t('options.ui.toolbarRegenerate')}>
            <Select
              value={messageToolbar.regenerate}
              onValueChange={(val) => handleToolbarChange('regenerate', val as MessageActionToggle)}
            >
              <SelectTrigger className="w-40" aria-label={t('options.ui.toolbarRegenerate')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="show">{t('options.ui.visibilityShow')}</SelectItem>
                <SelectItem value="hidden">{t('options.ui.visibilityHidden')}</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow label={t('options.ui.toolbarDelete')}>
            <Select
              value={messageToolbar.delete}
              onValueChange={(val) => handleToolbarChange('delete', val as MessageActionVisibility)}
            >
              <SelectTrigger className="w-40" aria-label={t('options.ui.toolbarDelete')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('options.ui.visibilityAll')}</SelectItem>
                <SelectItem value="assistant">{t('options.ui.visibilityAssistant')}</SelectItem>
                <SelectItem value="user">{t('options.ui.visibilityUser')}</SelectItem>
                <SelectItem value="hidden">{t('options.ui.visibilityHidden')}</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow label={t('options.ui.toolbarUsage')}>
            <Select
              value={messageToolbar.usage}
              onValueChange={(val) => handleToolbarChange('usage', val as MessageActionToggle)}
            >
              <SelectTrigger className="w-40" aria-label={t('options.ui.toolbarUsage')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="show">{t('options.ui.visibilityShow')}</SelectItem>
                <SelectItem value="hidden">{t('options.ui.visibilityHidden')}</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
        </SettingsGroup>
      </div>
    </div>
  );
}
