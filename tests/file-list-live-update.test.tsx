// @vitest-environment jsdom
/**
 * Live file-list updates in the two list views.
 *
 * `ConversationFiles` used to poll IndexedDB every 3 seconds — the only polling
 * loop in the app, and one that kept running while idle and while collapsed.
 * `FilesPage` did not refresh at all: it loaded once on mount, so a file an
 * agent wrote after the options tab was opened never appeared.
 *
 * Both now react to `files:changed`. These tests drive the real components and
 * the real event bus, because the thing that can silently break is the wiring
 * between them, not the bus (covered in `event-bus.test.ts`) or the emit
 * (covered in `file-storage-events.test.ts`).
 *
 * Timers are faked and asserted on, so a reintroduced `setInterval` fails here
 * rather than quietly costing an IndexedDB read per second forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, screen, cleanup } from '@testing-library/react';
import { emitEvent, resetEventBusForTests } from '@/lib/event-bus';
import type { FileMetadata } from '@/lib/mcp/file-storage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => `${key}:${opts?.count ?? ''}` }),
}));

/** What the stubbed storage will return on the next read. */
let storedFiles: FileMetadata[] = [];
/** Counts reads, to prove reloads are event-driven rather than timer-driven. */
let listCalls = 0;

function meta(name: string): FileMetadata {
  return { name, mimeType: 'text/markdown', size: 10, createdAt: 1, updatedAt: 1, conversationId: 'c1' };
}

vi.mock('@/lib/mcp', () => ({
  fileStorage: {
    listFiles: async () => {
      listCalls++;
      return storedFiles;
    },
    getFilesByConversation: async (id: string) => {
      listCalls++;
      return storedFiles.filter((f) => f.conversationId === id);
    },
    readFileAsBlob: async () => null,
    deleteFile: async () => true,
  },
  getPreviewCategory: () => 'text',
  isSystemPath: (path: string) => path.startsWith('skills/'),
}));

vi.mock('@/lib/conversation-store', () => ({
  listConversationMeta: async () => [],
}));

const { ConversationFiles } = await import('@/components/chat/ConversationFiles');
const { FilesPage } = await import('@/entrypoints/options/files/FilesPage');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  storedFiles = [];
  listCalls = 0;
  vi.stubGlobal('chrome', {
    runtime: { getURL: (p: string) => `chrome-extension://test${p}`, onMessage: { addListener: () => {}, removeListener: () => {} }, sendMessage: () => Promise.resolve() },
    tabs: { query: async () => [], create: async () => {}, update: async () => {} },
    windows: { update: async () => {} },
  });
});

afterEach(() => {
  // Vitest does not auto-cleanup React trees unless globals are enabled, and a
  // leftover tree makes `getByText` ambiguous in the next test.
  cleanup();
  resetEventBusForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let the mount-time async load settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ConversationFiles', () => {
  it('shows a file that appeared after mount, without waiting for a poll', async () => {
    render(<ConversationFiles conversationId="c1" onReference={() => {}} />);
    await settle();
    // Renders nothing while the conversation has no files.
    expect(screen.queryByText(/sidebar.files.count/)).toBeNull();

    storedFiles = [meta('notes.md')];
    await act(async () => {
      emitEvent('files:changed', { names: ['notes.md'], reason: 'write' });
      await Promise.resolve();
    });

    expect(screen.getByText('sidebar.files.count:1')).toBeTruthy();
  });

  it('drops a file that was deleted elsewhere', async () => {
    storedFiles = [meta('notes.md')];
    render(<ConversationFiles conversationId="c1" onReference={() => {}} />);
    await settle();
    expect(screen.getByText('sidebar.files.count:1')).toBeTruthy();

    storedFiles = [];
    await act(async () => {
      emitEvent('files:changed', { names: ['notes.md'], reason: 'delete' });
      await Promise.resolve();
    });

    expect(screen.queryByText(/sidebar.files.count/)).toBeNull();
  });

  it('does not poll', async () => {
    storedFiles = [meta('notes.md')];
    render(<ConversationFiles conversationId="c1" onReference={() => {}} />);
    await settle();
    const afterMount = listCalls;

    // Well past the old 3-second interval.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(listCalls).toBe(afterMount);
  });

  it('stops reacting once unmounted', async () => {
    storedFiles = [meta('notes.md')];
    const { unmount } = render(<ConversationFiles conversationId="c1" onReference={() => {}} />);
    await settle();
    unmount();
    const afterUnmount = listCalls;

    await act(async () => {
      emitEvent('files:changed', { names: ['notes.md'], reason: 'write' });
      await Promise.resolve();
    });

    expect(listCalls).toBe(afterUnmount);
  });
});

describe('FilesPage', () => {
  it('shows a file that appeared after the tab was opened', async () => {
    render(<FilesPage />);
    await settle();
    expect(screen.queryByText('notes.md')).toBeNull();

    storedFiles = [meta('notes.md')];
    await act(async () => {
      emitEvent('files:changed', { names: ['notes.md'], reason: 'write' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('notes.md')).toBeTruthy();
  });

  it('reloads silently, keeping the list on screen instead of flashing a spinner', async () => {
    storedFiles = [meta('a.md')];
    render(<FilesPage />);
    await settle();

    storedFiles = [meta('a.md'), meta('b.md')];
    await act(async () => {
      emitEvent('files:changed', { names: ['b.md'], reason: 'write' });
      // Deliberately assert mid-reload, before the read resolves: the existing
      // row must still be rendered rather than replaced by the loading state.
      expect(screen.getByText('a.md')).toBeTruthy();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('b.md')).toBeTruthy();
  });

  it('stops reacting once unmounted', async () => {
    storedFiles = [meta('a.md')];
    const { unmount } = render(<FilesPage />);
    await settle();
    unmount();
    const afterUnmount = listCalls;

    await act(async () => {
      emitEvent('files:changed', { names: ['a.md'], reason: 'write' });
      await Promise.resolve();
    });

    expect(listCalls).toBe(afterUnmount);
  });
});
