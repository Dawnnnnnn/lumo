// @vitest-environment jsdom
/**
 * The two backup dialogs' decisions.
 *
 * Export must pass exactly the checked groups to the archive builder, and import
 * must pass exactly the checked groups plus the conflict choice. Those arguments
 * are the whole contract between the UI and the data layer; the archive itself
 * is covered by `backup-format.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

const buildBackupZip = vi.fn(async () => ({
  blob: new Blob(['zip'], { type: 'application/zip' }),
  filename: 'lumo-backup.zip',
  manifest: {},
  stats: {},
}));
const downloadBlob = vi.fn(async () => undefined);

vi.mock('@/lib/backup', () => ({ buildBackupZip }));
vi.mock('@/lib/zip-download', () => ({ downloadBlob }));

import type { BackupInspection } from '@/lib/backup';

const { ExportBackupDialog } = await import('@/entrypoints/options/about/ExportBackupDialog');
const { ImportBackupDialog } = await import('@/entrypoints/options/about/ImportBackupDialog');

const report = {
  conversations: { count: 3, bytes: 4096 },
  screenshots: { count: 1, bytes: 512 },
  files: { count: 2, bytes: 100 },
  origin: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('ExportBackupDialog', () => {
  it('exports every checked group', async () => {
    render(<ExportBackupDialog open onOpenChange={vi.fn()} report={report} />);

    fireEvent.click(screen.getByLabelText('options.about.backup.files'));
    fireEvent.click(screen.getByRole('button', { name: 'common.export' }));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledOnce());
    expect(buildBackupZip).toHaveBeenCalledWith({
      conversations: true,
      files: false,
      config: true,
    });
  });

  it('shows the API-key warning only while configuration is selected', () => {
    render(<ExportBackupDialog open onOpenChange={vi.fn()} report={report} />);

    expect(screen.getByText('options.about.backup.configWarning')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('options.about.backup.config'));
    expect(screen.queryByText('options.about.backup.configWarning')).toBeNull();
  });
});

describe('ImportBackupDialog', () => {
  const archive = {
    manifest: {
      format: 'lumo-backup',
      version: 1,
      createdAt: '2026-11-06T00:00:00.000Z',
      appVersion: '1.0.22',
      contents: ['conversations', 'files', 'config'],
      stats: { conversations: 1, conversationBlobs: 1, files: 1, fileBytes: 10 },
    },
    config: {},
    conversations: { records: [], blobs: [] },
    files: { files: [], directories: [] },
  } as never;

  const inspection: BackupInspection = {
    available: ['conversations', 'files', 'config'],
    stats: { conversations: 1, conversationBlobs: 1, files: 1, fileBytes: 10 },
    conflicts: { conversations: 0, files: 1 },
  };

  it('passes the selected groups and the overwrite choice', async () => {
    const onImport = vi.fn(async () => ({
      config: true,
      conversations: { imported: 1, skipped: 0 },
      files: { imported: 1, skipped: 0 },
    }));
    render(
      <ImportBackupDialog
        archive={archive}
        inspection={inspection}
        onClose={vi.fn()}
        onImport={onImport}
      />,
    );

    // A file conflict is present, so the destructive choice is offered.
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'common.import' }));

    await waitFor(() => expect(onImport).toHaveBeenCalledOnce());
    expect(onImport).toHaveBeenCalledWith(
      { conversations: true, files: true, config: true },
      { overwrite: true },
    );
    expect(await screen.findByText('options.about.backup.importComplete')).toBeTruthy();
    expect(screen.getByText('options.about.backup.resultFiles:{"imported":1,"skipped":0}')).toBeTruthy();
  });

  it('hides the overwrite switch when nothing collides', () => {
    render(
      <ImportBackupDialog
        archive={archive}
        inspection={{ ...inspection, conflicts: { conversations: 0, files: 0 } }}
        onClose={vi.fn()}
        onImport={vi.fn()}
      />,
    );

    expect(screen.queryByRole('switch')).toBeNull();
  });
});
