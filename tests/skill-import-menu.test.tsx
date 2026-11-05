// @vitest-environment jsdom
/**
 * Skill import is one button with two channels, not a zip dialog on click.
 *
 * Clicking "Import skills" used to open the archive picker immediately, which
 * made the packaging the page's decision instead of the user's. The trigger now
 * only reveals the menu; the pickers stay untouched until a channel is chosen,
 * and the folder channel is the one that must open a *directory* picker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FilesPage } from '@/entrypoints/options/files/FilesPage';

afterEach(cleanup);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/mcp', () => ({
  fileStorage: {
    listFiles: async () => [],
    deleteFile: async () => {},
  },
  isSystemPath: () => false,
  getPreviewCategory: () => 'other',
}));

vi.mock('@/lib/conversation-store', () => ({
  listConversationMeta: async () => [],
}));

vi.mock('@/lib/side-panel-presence', () => ({
  useSidePanelPresence: () => false,
}));

vi.mock('@/lib/event-bus', () => ({
  useEvent: () => {},
  onEvent: () => () => {},
}));

// The review step asks storage what is already installed. Keeping the pure path
// helpers real and stubbing only the store means discovery and validation run for
// real, which is the point of an end-to-end channel test.
vi.mock('@/lib/mcp/file-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp/file-storage')>();
  return {
    ...actual,
    fileStorage: {
      listByPrefix: async () => [],
      exists: async () => false,
    },
  };
});

const ARCHIVE_INPUT = 'input[accept=".zip,application/zip"]';
const FOLDER_INPUT = 'input[webkitdirectory]';

type Channel = 'archive' | 'folder';

/**
 * Records picker opens without letting jsdom try to show a file dialog.
 *
 * Nothing else is observable about `<input type="file">` in a test environment:
 * the browser's dialog is the effect, and its trigger is the click.
 */
function recordPicks(input: HTMLInputElement, picks: Channel[], channel: Channel) {
  input.addEventListener('click', (event) => {
    event.preventDefault();
    picks.push(channel);
  });
}

/** Renders the page on the Skills tab and hands back the trigger plus both pickers. */
async function renderPage() {
  // The tab is part of the hash, so a link (or a refresh) lands on Skills.
  window.location.hash = 'files/skills';
  render(<FilesPage />);
  // The library loads asynchronously; waiting keeps act() warnings out.
  const trigger = await waitFor(() => screen.getByTitle('skills.import.button'));

  return {
    trigger,
    archiveInput: document.querySelector<HTMLInputElement>(ARCHIVE_INPUT)!,
    folderInput: document.querySelector<HTMLInputElement>(FOLDER_INPUT)!,
  };
}

/** Opens the menu and returns the two channel items. */
async function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.pointerUp(trigger, { button: 0, pointerType: 'mouse' });
  fireEvent.click(trigger);

  return {
    archiveItem: await waitFor(() => screen.getByText('skills.import.fromArchive')),
    folderItem: screen.getByText('skills.import.fromFolder'),
  };
}

describe('skill import menu', () => {
  it('reveals both channels without opening a picker', async () => {
    const { trigger, archiveInput, folderInput } = await renderPage();
    const picks: Channel[] = [];
    recordPicks(archiveInput, picks, 'archive');
    recordPicks(folderInput, picks, 'folder');

    await openMenu(trigger);

    // The regression: the trigger used to send the archive picker straight to
    // the user, before they had said anything about the packaging.
    expect(picks).toEqual([]);
    expect(screen.getByText('skills.import.fromArchive')).toBeTruthy();
    expect(screen.getByText('skills.import.fromFolder')).toBeTruthy();
  });

  it('opens the archive picker only when that channel is chosen', async () => {
    const { trigger, archiveInput, folderInput } = await renderPage();
    const picks: Channel[] = [];
    recordPicks(archiveInput, picks, 'archive');
    recordPicks(folderInput, picks, 'folder');

    const { archiveItem } = await openMenu(trigger);
    fireEvent.pointerUp(archiveItem, { pointerType: 'mouse' });
    fireEvent.click(archiveItem);

    await waitFor(() => expect(picks).toEqual(['archive']));
  });

  it('opens a directory picker for the folder channel', async () => {
    const { trigger, folderInput, archiveInput } = await renderPage();
    // A directory picker, not a second file picker: `webkitdirectory` is the
    // attribute that makes Chrome walk the chosen folder, and `accept` would
    // filter it back down to individual files.
    expect(folderInput).toBeTruthy();
    expect(folderInput.hasAttribute('multiple')).toBe(true);
    expect(folderInput.hasAttribute('accept')).toBe(false);

    const picks: Channel[] = [];
    recordPicks(archiveInput, picks, 'archive');
    recordPicks(folderInput, picks, 'folder');

    const { folderItem } = await openMenu(trigger);
    fireEvent.pointerUp(folderItem, { pointerType: 'mouse' });
    fireEvent.click(folderItem);

    await waitFor(() => expect(picks).toEqual(['folder']));
  });
});

describe('skill import review', () => {
  it('opens the review for a folder instead of installing it immediately', async () => {
    const { folderInput } = await renderPage();

    const manifest = new File(
      ['---\nname: demo-skill\ndescription: Demonstrates the review step.\n---\n'],
      'SKILL.md',
    );
    Object.defineProperty(manifest, 'webkitRelativePath', { value: 'demo/SKILL.md' });
    Object.defineProperty(folderInput, 'files', { value: [manifest] });

    fireEvent.change(folderInput);

    // A package with exactly one skill still gets a review: importing is a write.
    await waitFor(() => expect(screen.getByText('skills.review.title')).toBeTruthy());
    expect(screen.getByText('demo-skill')).toBeTruthy();
    expect(screen.getByText('Demonstrates the review step.')).toBeTruthy();
    // Nothing is installed until the review is confirmed.
    expect(screen.getByText('skills.review.confirm')).toBeTruthy();
  });
});
