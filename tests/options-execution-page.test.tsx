/**
 * @vitest-environment jsdom
 *
 * Cover for the Personalization / Execution split.
 *
 * The execution-side settings (tool step limit, end-of-turn notification,
 * context compaction, the experimental switch) used to live on the
 * Personalization page even though none of them change how Lumo looks. Moving
 * them is a pure re-parenting, so the thing worth guarding is exactly that: each
 * row renders on the page that owns it, and no longer on the page it left.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { DEFAULT_COMPACTION_SETTINGS } from '@/lib/compaction';
import { DEFAULT_MAX_STEPS } from '@/lib/max-steps';
import { DEFAULT_TURN_NOTIFICATION } from '@/lib/turn-notification';
import { ExecutionSettingsPage } from '@/entrypoints/options/ExecutionSettings';
import { UISettingsPage } from '@/entrypoints/options/UISettings';

// `vi.mock` factories are hoisted above the imports, so the shared fixtures have
// to be created through `vi.hoisted` and read lazily by the factory.
const h = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  setUISettings: vi.fn(async () => {}),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Echo the key so assertions can target it without duplicating copy.
    t: (key: string, vars?: Record<string, unknown>) =>
      vars && 'steps' in vars ? `${key}:${vars.steps}` : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/store/storage', () => ({
  storage: {
    getUISettings: async () => h.state,
    setUISettings: h.setUISettings,
  },
}));

// Personalization's chrome: theme state and language switching both reach for
// browser-side singletons that have no meaning under jsdom.
vi.mock('@/lib/theme', () => ({
  THEME_OPTIONS: [{ value: 'system', labelKey: 'options.ui.themeSystem' }],
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}));

vi.mock('@/i18n', () => ({ applyLanguage: vi.fn(async () => {}) }));

/** One stored `UISettings` record, the shape both pages read and write. */
const settings = {
  language: 'auto',
  theme: 'system',
  fontSize: 14,
  maxSplitPanels: 1,
  sendKey: 'enter',
  busySend: 'steer',
  pasteThreshold: 2000,
  maxSteps: DEFAULT_MAX_STEPS,
  autoCollapseReasoning: true,
  messageToolbar: { copy: 'all', regenerate: 'show', delete: 'all', usage: 'show' },
  compaction: { ...DEFAULT_COMPACTION_SETTINGS, enabled: true },
  turnNotification: DEFAULT_TURN_NOTIFICATION,
  programmaticTools: true,
};

h.state = settings;

afterEach(() => {
  cleanup();
  settings.compaction.enabled = true;
});

const EXECUTION_KEYS = [
  'options.execution.maxSteps',
  'options.execution.turnNotification',
  'options.execution.compactionEnabled',
  'options.execution.compactionReserve',
  'options.execution.compactionKeepRecent',
  'options.execution.programmaticTools',
];

describe('execution settings page', () => {
  it('renders every execution row', async () => {
    render(<ExecutionSettingsPage />);
    for (const key of EXECUTION_KEYS) {
      expect(await screen.findByText(key)).toBeTruthy();
    }
  });

  it('reads the tool step limit through the shared preset list', async () => {
    render(<ExecutionSettingsPage />);
    // `maxSteps` defaults to 0, which the field renders as "never pause".
    expect(await screen.findByText('options.execution.maxStepsNever')).toBeTruthy();
  });

  it('hides the compaction budgets while compaction is off', async () => {
    settings.compaction.enabled = false;

    render(<ExecutionSettingsPage />);
    await screen.findByText('options.execution.compactionEnabled');
    expect(screen.queryByText('options.execution.compactionReserve')).toBeNull();
    expect(screen.queryByText('options.execution.compactionKeepRecent')).toBeNull();
  });
});

describe('personalization page', () => {
  it('no longer carries execution rows', async () => {
    render(<UISettingsPage />);
    await screen.findByText('options.ui.title');
    // The composer rows it keeps, so a silent render failure cannot pass this.
    expect(screen.getByText('options.ui.sendKey')).toBeTruthy();
    for (const key of EXECUTION_KEYS) {
      expect(screen.queryByText(key)).toBeNull();
    }
  });
});
