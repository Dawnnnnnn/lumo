// @vitest-environment jsdom
/**
 * Dropping a file in from the operating system.
 *
 * `options.html#files` describes itself as managing files "uploaded manually",
 * but until now nothing could put one there: the side panel's drop handler read
 * `dataTransfer.files` only in its image branch, so a dropped `.md` fell through
 * to the text/HTML classification — which is empty for an OS drag — and silently
 * did nothing, and the options page had no drop handler at all.
 *
 * What the two surfaces must agree on is asserted here rather than in
 * `file-import.test.ts`, because the interesting part is the wiring: which drop
 * stores, which conversation it is tagged with, and what the input ends up
 * holding. The classification itself is unit-tested separately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, screen, cleanup, fireEvent } from '@testing-library/react';
import type { FileMetadata } from '@/lib/mcp/file-storage';
import { LUMO_FILE_REF_MIME } from '@/lib/constants';

interface Write {
  name: string;
  conversationId?: string;
  mimeType?: string;
}

/** Every `writeFile` this test's components performed, in order. */
let writes: Write[] = [];

/** Whether the selected model claims vision support. */
let isVision = true;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.count == null ? key : `${key}:${opts.count}`,
  }),
}));

/**
 * The real extension map and preview categories, a recording `fileStorage`.
 * Substituting a simplified classifier here would test the test.
 */
vi.mock('@/lib/mcp', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mcp/file-storage')>(
    '@/lib/mcp/file-storage',
  );
  return {
    inferMimeType: actual.inferMimeType,
    getPreviewCategory: actual.getPreviewCategory,
    fileStorage: {
      listFiles: async (): Promise<FileMetadata[]> => [],
      getFilesByConversation: async (): Promise<FileMetadata[]> => [],
      readFileAsBlob: async () => null,
      deleteFile: async () => true,
      exists: async () => false,
      writeFile: async (name: string, _content: Blob, options?: Omit<Write, 'name'>) => {
        writes.push({ name, ...options });
        return { name };
      },
    },
  };
});

vi.mock('@/lib/conversation-store', () => ({
  listConversationMeta: async () => [],
}));

vi.mock('@/store/storage', () => ({
  storage: {
    getProviders: async () => [
      {
        id: 'p1',
        name: 'P',
        apiKey: 'k',
        baseUrl: 'https://x',
        models: [{ id: 'm1', modelId: 'm1', displayName: 'M1', get isVision() { return isVision; } }],
      },
    ],
    getUISettings: async () => ({ language: 'en', theme: 'light', maxSplitPanels: 1, sendKey: 'enter' }),
    getCommandSettings: async () => ({ enabled: true, userCommands: [], disabledBuiltins: [] }),
    getMentionSettings: async () => ({ enabled: true, tabsEnabled: true, filesEnabled: true }),
    getOcrSettings: async () => ({ enabled: false, providerId: '', modelId: '', prompt: '' }),
  },
}));

/** The conversation the panel is currently on; `null` is "no chat open". */
let currentConversation: { id: string; title: string; messages: [] } | null = null;

vi.mock('@/store/useChatStream', () => ({
  useChatStream: () => ({
    conversations: [],
    get currentConversation() {
      return currentConversation;
    },
    isHistoryOpen: false,
    setIsHistoryOpen: vi.fn(),
    isStreaming: false,
    streamingMessage: null,
    chatError: null,
    isRetrying: false,
    retryAttempt: 0,
    handleSend: vi.fn(),
    handleRetry: vi.fn(),
    handleStop: vi.fn(),
    handleNewChat: vi.fn(),
    handleSelectConversation: vi.fn(),
    handleDeleteConversation: vi.fn(),
    handleClearAllConversations: vi.fn(),
  }),
}));

vi.mock('@/components/chat/ChatHeader', () => ({ ChatHeader: () => null }));
vi.mock('@/components/chat/ChatMessageList', () => ({ ChatMessageList: () => null }));
vi.mock('@/components/chat/ConversationHistory', () => ({ ConversationHistory: () => null }));

const { FilesPage } = await import('@/entrypoints/options/files/FilesPage');
const { ChatPanel } = await import('@/components/chat/ChatPanel');

/**
 * A `DataTransfer` stand-in: jsdom has no usable implementation.
 *
 * `types` includes `'Files'` whenever files are present, as the real one does —
 * that is the flag both drop targets use to tell an OS drag from an internal one.
 */
function fakeDataTransfer(files: File[] = [], data: Record<string, string> = {}) {
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    files: files as unknown as FileList,
    types: [...Object.keys(data), ...(files.length > 0 ? ['Files'] : [])],
    setData: (type: string, value: string) => {
      data[type] = value;
    },
    getData: (type: string) => data[type] ?? '',
  };
}

function droppedFile(name: string, type: string, content = 'x'): File {
  return new File([content], name, { type });
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

function renderPanel() {
  render(
    <ChatPanel
      panelIndex={0}
      showSettings
      showSplitButton={false}
      showClose={false}
      occupiedSessionIds={[]}
    />,
  );
}

beforeEach(() => {
  writes = [];
  isVision = true;
  currentConversation = { id: 'c1', title: 'T', messages: [] };
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: (p: string) => `chrome-extension://test${p}`,
      openOptionsPage: vi.fn(),
      getContexts: async () => [{ contextType: 'SIDE_PANEL' }],
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: () => false },
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: { query: async () => [], create: async () => {}, update: async () => {} },
    windows: { update: async () => {} },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('side panel receiving files from the OS', () => {
  it('stores a text file against the open conversation and references it', async () => {
    renderPanel();
    await settle();

    const dataTransfer = fakeDataTransfer([droppedFile('notes.md', 'text/markdown')]);
    await act(async () => {
      fireEvent.drop(screen.getByRole('textbox'), { dataTransfer });
    });
    await settle();

    // Tagged with the conversation, which is what puts it in the conversation
    // file list rather than only in the global table.
    expect(writes).toEqual([
      { name: 'notes.md', mimeType: 'text/markdown', conversationId: 'c1' },
    ]);

    // Arrives as a file reference chip — the same shape as a row dragged in from
    // the options page — not as a text attachment holding the raw wrapper.
    expect(screen.getByText('notes.md')).toBeTruthy();
    expect(screen.getByText('sidebar.files.file')).toBeTruthy();
    expect(screen.queryByText('[filename: notes.md]')).toBeNull();
  });

  it('still stores the file when no chat is open, just unattributed', async () => {
    currentConversation = null;
    renderPanel();
    await settle();

    await act(async () => {
      fireEvent.drop(screen.getByRole('textbox'), {
        dataTransfer: fakeDataTransfer([droppedFile('notes.md', 'text/markdown')]),
      });
    });
    await settle();

    // No conversation to attribute it to, so the source column reads
    // "Manual / Unknown" — better than inventing a conversation for a drop.
    expect(writes).toEqual([{ name: 'notes.md', mimeType: 'text/markdown', conversationId: undefined }]);
  });

  it('keeps an image inline and out of storage', async () => {
    renderPanel();
    await settle();

    await act(async () => {
      fireEvent.drop(screen.getByRole('textbox'), {
        dataTransfer: fakeDataTransfer([droppedFile('shot.png', 'image/png')]),
      });
    });
    await settle();

    // The whole point of the constraint: the file manager never sees a binary.
    expect(writes).toEqual([]);
    expect(document.querySelector('img')).toBeTruthy();
  });

  it('ignores an image the model cannot read rather than storing it', async () => {
    isVision = false;
    renderPanel();
    await settle();

    await act(async () => {
      fireEvent.drop(screen.getByRole('textbox'), {
        dataTransfer: fakeDataTransfer([droppedFile('shot.png', 'image/png')]),
      });
    });
    await settle();

    expect(writes).toEqual([]);
    expect(document.querySelector('img')).toBeNull();
  });

  it('refuses other binaries silently', async () => {
    renderPanel();
    await settle();

    await act(async () => {
      fireEvent.drop(screen.getByRole('textbox'), {
        dataTransfer: fakeDataTransfer([
          droppedFile('bundle.zip', 'application/zip'),
          droppedFile('paper.pdf', 'application/pdf'),
        ]),
      });
    });
    await settle();

    expect(writes).toEqual([]);
    // No attachment chip, and no message: a mis-drag is not an error to report.
    expect(screen.queryByText('sidebar.files.file')).toBeNull();
  });

  it('splits a mixed drop: text stored, image inline', async () => {
    renderPanel();
    await settle();

    await act(async () => {
      fireEvent.drop(screen.getByRole('textbox'), {
        dataTransfer: fakeDataTransfer([
          droppedFile('shot.png', 'image/png'),
          droppedFile('notes.md', 'text/markdown'),
        ]),
      });
    });
    await settle();

    expect(writes.map((w) => w.name)).toEqual(['notes.md']);
    expect(document.querySelector('img')).toBeTruthy();
  });

  it('does not fall back to text classification for an OS drop', async () => {
    renderPanel();
    await settle();

    // A refused drop must not leave a stray text attachment behind: Chrome puts
    // the file's URL in text/plain for some sources, which would otherwise be
    // attached as if the user had dragged a snippet of page text.
    await act(async () => {
      fireEvent.drop(screen.getByRole('textbox'), {
        dataTransfer: fakeDataTransfer([droppedFile('bundle.zip', 'application/zip')], {
          'text/plain': 'file:///home/user/bundle.zip',
        }),
      });
    });
    await settle();

    expect(screen.queryByText('file:///home/user/bundle.zip')).toBeNull();
  });
});

describe('options file manager receiving files from the OS', () => {
  it('stores a dropped text file with no conversation attached', async () => {
    const { container } = render(<FilesPage />);
    await settle();

    const surface = container.firstElementChild!;
    await act(async () => {
      fireEvent.drop(surface, {
        dataTransfer: fakeDataTransfer([droppedFile('manual.txt', 'text/plain')]),
      });
    });
    await settle();

    expect(writes).toEqual([
      { name: 'manual.txt', mimeType: 'text/plain', conversationId: undefined },
    ]);
  });

  it('ignores a drag that carries no OS files', async () => {
    const { container } = render(<FilesPage />);
    await settle();

    const surface = container.firstElementChild!;

    // This page is its own drag source — dragging a row across the table must not
    // register as something droppable.
    const rowDrag = fakeDataTransfer([], { [LUMO_FILE_REF_MIME]: 'notes/report.md' });
    await act(async () => {
      fireEvent.dragOver(surface, { dataTransfer: rowDrag });
      fireEvent.drop(surface, { dataTransfer: rowDrag });
    });
    await settle();

    expect(writes).toEqual([]);
    expect(surface.firstElementChild!.className).not.toContain('outline-dashed');
  });

  it('marks itself as a drop target only while OS files are over it', async () => {
    const { container } = render(<FilesPage />);
    await settle();

    // The surface spans the whole pane so a near-miss cannot navigate the tab to
    // the file; the highlight stays on the card, where the file actually lands.
    const surface = container.firstElementChild!;
    const card = surface.firstElementChild!;
    const dataTransfer = fakeDataTransfer([droppedFile('manual.txt', 'text/plain')]);

    await act(async () => {
      fireEvent.dragOver(surface, { dataTransfer });
    });
    expect(card.className).toContain('outline-dashed');

    // Purely visual: no wording is introduced for a transient drag state.
    expect(surface.textContent).not.toMatch(/drop/i);

    await act(async () => {
      fireEvent.dragLeave(surface, { dataTransfer, relatedTarget: document.body });
    });
    expect(card.className).not.toContain('outline-dashed');
  });
});
