// @vitest-environment jsdom
/**
 * The files view draws the storage tree, not a flat directory list.
 *
 * A skill with references is three path segments deep. The old list drew each
 * directory as a root-level sibling, so `skills/` and `skills/ai-sdk/` read as
 * unrelated rows and the nesting only existed in the names. These tests pin the
 * behaviour a reader actually needs: children appear under their parent, a
 * search reveals a deep hit without manual expansion, and the aggregate
 * `skills/` row cannot delete every capability at once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FileMetadata } from '@/lib/mcp/file-storage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/mcp', () => ({
  getPreviewCategory: () => 'text',
}));

const { FileListView } = await import('@/entrypoints/options/files/FileListView');

function meta(name: string, size = 100): FileMetadata {
  return { name, mimeType: 'text/markdown', size, createdAt: 1000, updatedAt: 1000 };
}

const FILES: FileMetadata[] = [
  meta('skills/ai-sdk/SKILL.md', 100),
  meta('skills/ai-sdk/references/spec.md', 200),
  meta('skills/webmcp/SKILL.md', 400),
  meta('docs/a.md'),
  meta('docs/b.md'),
];

function renderList(query = '') {
  const props = {
    files: FILES,
    query,
    loading: false,
    canDragToSidePanel: false,
    deleting: null,
    downloading: null,
    conversationTitle: () => null,
    onPreview: vi.fn(),
    onDownload: vi.fn(),
    onDownloadFolder: vi.fn(),
    onDelete: vi.fn(),
  };
  const result = render(<FileListView {...props} />);
  return { ...result, props };
}

/** The action trigger of the row whose disclosure/label text is `label`. */
function actionsOf(label: string): HTMLElement {
  const row = screen.getByText(label).closest('button')!.parentElement!;
  return within(row).getByLabelText('options.files.actions');
}

/** The disclosure button of a folder row, which carries its open state. */
function disclosure(label: string): HTMLElement {
  return screen.getByText(label).closest('button') as HTMLElement;
}

afterEach(() => {
  cleanup();
});

describe('files view as a path tree', () => {
  it('opens top-level folders by default and folds deeper ones', () => {
    renderList();

    // Namespaces are visible without a click, and open.
    expect(screen.getByText('skills')).toBeTruthy();
    expect(screen.getByText('docs')).toBeTruthy();
    expect(disclosure('skills').getAttribute('aria-expanded')).toBe('true');
    expect(disclosure('docs').getAttribute('aria-expanded')).toBe('true');

    // The skill's own files are one level deeper, so they start folded.
    expect(screen.getByText('ai-sdk')).toBeTruthy();
    expect(disclosure('ai-sdk').getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(disclosure('ai-sdk'));

    expect(disclosure('ai-sdk').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('references')).toBeTruthy();
    // Still one level too deep.
    expect(disclosure('references').getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(disclosure('references'));
    expect(disclosure('references').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('spec.md')).toBeTruthy();
  });

  it('reveals a deep match without any manual expansion while searching', () => {
    // The match is a file three levels down; its ancestors only exist because of
    // it, and searching must not leave it behind a closed row.
    renderList('spec');

    expect(screen.getByText('spec.md')).toBeTruthy();
    expect(screen.getByText('references')).toBeTruthy();
    // Unrelated subtrees are filtered out, not merely hidden.
    expect(screen.queryByText('webmcp')).toBeNull();
    expect(screen.queryByText('docs')).toBeNull();
  });

  it('keeps a collapsed single-file directory as one row, under its parent', () => {
    renderList();

    // `docs/` holds two documents, so it is a folder with two rows.
    expect(screen.getByText('a.md')).toBeTruthy();
    expect(screen.getByText('b.md')).toBeTruthy();

    // A directory with one file is that file, however deep it sits.
    fireEvent.click(disclosure('ai-sdk'));
    fireEvent.click(disclosure('references'));
    expect(screen.getByText('spec.md')).toBeTruthy();
  });

  it('offers download but not delete on the aggregate skills row', async () => {
    renderList();

    // Deleting `skills/` would erase every installed skill at once; the row only
    // backs them up, and deletion stays with the individual skill.
    fireEvent.pointerDown(actionsOf('skills'), { button: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(actionsOf('skills'), { button: 0, pointerType: 'mouse' });

    expect(await screen.findByText('options.files.downloadFolder')).toBeTruthy();
    expect(screen.queryByText('options.files.deleteFolder')).toBeNull();
  });

  it('keeps delete on an individual skill folder', async () => {
    renderList();

    fireEvent.pointerDown(actionsOf('ai-sdk'), { button: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(actionsOf('ai-sdk'), { button: 0, pointerType: 'mouse' });

    expect(await screen.findByText('options.files.deleteFolder')).toBeTruthy();
  });

  it('indents only the name cell, so numeric columns stay aligned', () => {
    renderList();

    const root = screen.getByText('skills').closest('button') as HTMLElement;
    const child = screen.getByText('ai-sdk').closest('button') as HTMLElement;

    expect(root.style.paddingInlineStart).toBe('0px');
    expect(child.style.paddingInlineStart).toBe('16px');
    // The grid row itself keeps its padding, so size/source/date do not shift.
    expect((root.parentElement as HTMLElement).style.paddingInlineStart).toBe('');
  });
});

describe('folder totals', () => {
  it('counts and sizes every descendant of a folder', async () => {
    renderList();

    // `skills` aggregates both skills; the badges are derived, not typo-prone.
    const skillsRow = screen.getByText('skills').closest('button')!;
    expect(within(skillsRow).getByText('options.files.fileCount')).toBeTruthy();

    fireEvent.pointerDown(actionsOf('skills'), { button: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(actionsOf('skills'), { button: 0, pointerType: 'mouse' });
    expect(await screen.findByText('options.files.downloadFolder')).toBeTruthy();

    await waitFor(() => expect(screen.queryByText('options.files.deleteFolder')).toBeNull());
  });
});
