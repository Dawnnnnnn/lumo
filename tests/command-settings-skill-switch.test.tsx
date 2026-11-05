// @vitest-environment jsdom
/**
 * The Commands page's `/skill:*` switch.
 *
 * One switch for the whole family rather than a row per skill: the shortcuts are
 * one mechanism, and a per-skill list would duplicate the Skills tab while
 * implying that "off" means something about the skill itself — it does not, it
 * only removes the composer shortcut.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_COMMAND_SETTINGS } from '@/lib/slash-commands';
import type { CommandSettings } from '@/lib/slash-commands';

const settings: CommandSettings = { ...DEFAULT_COMMAND_SETTINGS };
const setSettings = vi.fn(async () => {});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/store/useCommands', () => ({
  useCommandSettings: () => ({ settings, isLoaded: true, setSettings }),
  useEnabledCommands: () => [],
}));

const { CommandSettingsPage } = await import('@/entrypoints/options/CommandSettings');

afterEach(() => {
  cleanup();
  setSettings.mockClear();
});

describe('Commands page — skill commands switch', () => {
  it('shows the family switch as on by default', () => {
    render(<CommandSettingsPage />);

    const control = screen.getByRole('switch', { name: 'options.commands.skillCommands' });
    expect(control.getAttribute('aria-checked')).toBe('true');
  });

  it('writes the flag when switched off', () => {
    render(<CommandSettingsPage />);

    fireEvent.click(screen.getByRole('switch', { name: 'options.commands.skillCommands' }));

    expect(setSettings).toHaveBeenCalledWith({
      ...DEFAULT_COMMAND_SETTINGS,
      skillCommandsEnabled: false,
    });
  });
});
