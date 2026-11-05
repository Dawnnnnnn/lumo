// @vitest-environment jsdom
/**
 * The GitHub dialog is a form plus a status line: the decision about *how* to
 * read a repository (tree + raw, or its archive) belongs to the data layer, so
 * this test only pins the contract the page depends on.
 *
 * What matters: the result is an ordinary `SkillInspection` handed to the same
 * review as every other channel, the status line says which step is running, and
 * a failure names a reason the user can act on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GitHubImportDialog } from '@/entrypoints/options/files/GitHubImportDialog';
import type { GitHubInspectionResult } from '@/lib/skills/import';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/skills/import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/skills/import')>();
  return { ...actual, inspectGitHubImport: vi.fn() };
});

const { inspectGitHubImport } = await import('@/lib/skills/import');
const inspect = vi.mocked(inspectGitHubImport);

const INSPECTION = {
  candidates: [],
  diagnostics: [],
  empty: false,
};

afterEach(() => {
  cleanup();
  inspect.mockReset();
});

function renderDialog() {
  const onPrepared = vi.fn();
  const onClose = vi.fn();
  render(<GitHubImportDialog open onClose={onClose} onPrepared={onPrepared} />);
  return { onPrepared, onClose };
}

function start(url: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: url } });
  fireEvent.click(screen.getByText('skills.github.download'));
}

describe('GitHubImportDialog', () => {
  it('hands the inspection to the review and closes', async () => {
    inspect.mockResolvedValue({ ok: true, mode: 'tree', inspection: INSPECTION });

    const { onPrepared, onClose } = renderDialog();
    start('https://github.com/o/r');

    await waitFor(() => expect(onPrepared).toHaveBeenCalledWith(INSPECTION));
    expect(onClose).toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledWith(
      'https://github.com/o/r',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('names the step that is running', async () => {
    let report: ((phase: 'scan' | 'manifests' | 'archive') => void) | undefined;
    inspect.mockImplementation(
      (_url, options) =>
        new Promise<GitHubInspectionResult>((resolve) => {
          report = options?.onPhase;
          report?.('scan');
          // Never resolves: the status line is what this case is about.
          void resolve;
        }),
    );

    renderDialog();
    start('https://github.com/o/r');

    await waitFor(() => expect(screen.getByText('skills.github.scanning')).toBeTruthy());
    expect(screen.getByText('skills.github.stop')).toBeTruthy();

    // Falling back to the archive is a different wait, and worth saying.
    report?.('archive');
    await waitFor(() => expect(screen.getByText(/skills\.github\.downloading/)).toBeTruthy());
  });

  it.each([
    ['invalid-url', 'skills.github.invalidUrl'],
    ['not-found', 'skills.github.notFound'],
    ['rate-limited', 'skills.github.rateLimited'],
    ['too-large', 'skills.github.tooLarge'],
    ['network', 'skills.github.network'],
  ] as const)('reports %s', async (reason, key) => {
    inspect.mockResolvedValue({ ok: false, reason });

    const { onPrepared } = renderDialog();
    start('https://github.com/o/r');

    await waitFor(() => expect(screen.getByText(key)).toBeTruthy());
    expect(onPrepared).not.toHaveBeenCalled();
  });

  it('cancels a read in flight', async () => {
    let signal: AbortSignal | undefined;
    inspect.mockImplementation(
      (_url, options) =>
        new Promise<GitHubInspectionResult>((resolve) => {
          signal = options?.signal;
          options?.signal?.addEventListener('abort', () =>
            resolve({ ok: false, reason: 'aborted' }),
          );
        }),
    );

    const { onPrepared, onClose } = renderDialog();
    start('https://github.com/o/r');

    await waitFor(() => expect(screen.getByText('skills.github.stop')).toBeTruthy());
    fireEvent.click(screen.getByText('skills.github.stop'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(signal?.aborted).toBe(true);
    expect(onPrepared).not.toHaveBeenCalled();
  });

  it('does not start until an address is typed', () => {
    renderDialog();
    expect(
      (screen.getByText('skills.github.download') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
