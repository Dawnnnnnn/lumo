// @vitest-environment jsdom
/**
 * The files page has two views of the same storage, and the tab is part of the
 * URL so a link (or a refresh) can land on either one.
 *
 * What matters here is the separation itself: each view carries only its own
 * actions, the Skills view is built from the skills index rather than from the
 * file list, and a skill that does not load is visible with the reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FilesPage } from '@/entrypoints/options/files/FilesPage';
import type { SkillIndexState } from '@/store/useSkills';
import type { FileMetadata } from '@/lib/mcp';

const SKILL_INDEX: SkillIndexState = {
  skills: [
    {
      name: 'pdf-tools',
      description: 'Extract and fill PDF forms',
      disableModelInvocation: false,
      path: 'skills/pdf-tools/SKILL.md',
      dir: 'skills/pdf-tools/',
      updatedAt: 1_700_000_000_000,
      license: 'MIT',
    },
  ],
  diagnostics: [
    {
      level: 'error',
      code: 'description-missing',
      message: 'a skill requires a non-empty "description" to be routable',
      path: 'skills/draft/SKILL.md',
    },
  ],
};

const FILES: FileMetadata[] = [
  {
    name: 'chat/quarterly.md',
    mimeType: 'text/markdown',
    size: 2048,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    conversationId: 'c1',
  },
  {
    name: 'skills/pdf-tools/SKILL.md',
    mimeType: 'text/markdown',
    size: 512,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  },
  {
    name: 'skills/draft/SKILL.md',
    mimeType: 'text/markdown',
    size: 128,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  },
];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/mcp', () => ({
  fileStorage: {
    listFiles: async () => FILES,
    readFileAsBlob: async () => null,
    deletePath: vi.fn(async () => []),
  },
  getPreviewCategory: (mimeType: string) => (mimeType.startsWith('text/') ? 'text' : 'unsupported'),
  inferMimeType: () => 'text/markdown',
}));

vi.mock('@/lib/conversation-store', () => ({
  listConversationMeta: async () => [{ id: 'c1', title: 'Quarterly planning' }],
}));

vi.mock('@/lib/side-panel-presence', () => ({
  useSidePanelPresence: () => false,
}));

vi.mock('@/lib/event-bus', () => ({
  useEvent: () => {},
  onEvent: () => () => {},
}));

vi.mock('@/store/useSkills', () => ({
  useSkillIndex: () => SKILL_INDEX,
  useSkills: () => SKILL_INDEX.skills,
}));

async function renderPage(hash = '') {
  window.location.hash = hash;
  render(<FilesPage />);
  // The library loads asynchronously; waiting keeps act() warnings out.
  await waitFor(() => expect(screen.getByText('options.files.title')).toBeTruthy());
  return screen;
}

describe('files page tabs', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  afterEach(() => {
    cleanup();
    window.location.hash = '';
  });

  it('opens on the files view, with the upload action and no import control', async () => {
    await renderPage();

    expect(screen.getByText('chat/quarterly.md').closest('[class]')).not.toBeNull();
    expect(screen.getByText('options.files.upload')).toBeTruthy();
    // Importing a skill belongs to the skills view; the files view does not
    // offer a second place for the same act.
    expect(screen.queryByTitle('skills.import.button')).toBeNull();
  });

  it('opens the skills view directly from the hash', async () => {
    await renderPage('files/skills');

    expect(screen.getByTitle('skills.import.button')).toBeTruthy();
    expect(screen.queryByText('options.files.upload')).toBeNull();
    expect(screen.getByText('Extract and fill PDF forms')).toBeTruthy();
    expect(screen.getByText('/skill:pdf-tools')).toBeTruthy();
  });

  it('switches views and updates the hash', async () => {
    await renderPage();

    // Radix tabs activate on mouse-down (the gesture that also moves focus),
    // not on click.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /options\.files\.tabs\.skills/ }), {
      button: 0,
    });

    await waitFor(() => expect(window.location.hash).toBe('#files/skills'));
    expect(screen.getByText('Extract and fill PDF forms')).toBeTruthy();
  });

  it('shows a skill that does not load, with the reason', async () => {
    await renderPage('files/skills');

    // The skill exists on disk but is not routable — exactly the case someone
    // opens a management screen to find.
    expect(
      screen.getByText('a skill requires a non-empty "description" to be routable'),
    ).toBeTruthy();
    expect(screen.getByText('skills.list.needsAttention')).toBeTruthy();
  });

  it('deletes a whole skill from the row menu, behind a confirmation', async () => {
    const { fileStorage } = await import('@/lib/mcp');
    const deletePath = vi.mocked(fileStorage.deletePath);

    await renderPage('files/skills');

    // Rows sort with errors first, so the first menu belongs to the broken skill.
    fireEvent.pointerDown(screen.getAllByLabelText('options.files.actions')[0]!, {
      button: 0,
      pointerType: 'mouse',
    });
    fireEvent.pointerUp(screen.getAllByLabelText('options.files.actions')[0]!, {
      button: 0,
      pointerType: 'mouse',
    });
    fireEvent.click(await waitFor(() => screen.getByText('skills.list.delete')));

    // Nothing is deleted until the confirmation is answered.
    expect(deletePath).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('skills.list.deleteConfirm')).toBeTruthy());

    fireEvent.click(screen.getByText('common.delete'));

    await waitFor(() => expect(deletePath).toHaveBeenCalledWith('skills/draft/'));
  });

  it('filters the file list by name and by conversation title', async () => {
    await renderPage();
    const search = screen.getByPlaceholderText('options.files.search');

    fireEvent.change(search, { target: { value: 'quarterly planning' } });
    await waitFor(() => expect(screen.getByText('chat/quarterly.md')).toBeTruthy());
    expect(screen.queryByText('skills/pdf-tools/')).toBeNull();

    fireEvent.change(search, { target: { value: 'nothing-like-this' } });
    await waitFor(() => expect(screen.getByText('options.files.noResults')).toBeTruthy());
  });
});
