// @vitest-environment jsdom
/**
 * A file row in the options page (`options.html#files`) must be draggable into
 * an open side panel, arriving as a file reference chip.
 *
 * This spans two documents, which is exactly where it can silently break. The
 * side panel classifies a drag by whether *it* saw the `dragstart`: a drag from
 * the options tab did not, so it takes the external path alongside page drags,
 * where the payload used to be read as text/HTML only — the file reference would
 * have degraded into a plain `[filename: name]` text chip. Both halves are asserted
 * against the real components: the payload the row writes, and what the panel
 * makes of it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, screen, cleanup, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import type { ChatPanelHandle } from '@/components/chat/ChatPanel';
import type { FileMetadata } from '@/lib/mcp/file-storage';
import { LUMO_FILE_REF_MIME } from '@/lib/constants';

const FILE_NAME = 'notes/report.md';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts?.count == null ? key : `${key}:${opts.count}`) }),
}));

vi.mock('@/lib/mcp', () => ({
  fileStorage: {
    listFiles: async (): Promise<FileMetadata[]> => [
      { name: FILE_NAME, mimeType: 'text/markdown', size: 10, createdAt: 1, updatedAt: 1, conversationId: 'c1' },
    ],
    getFilesByConversation: async () => [],
    readFileAsBlob: async () => null,
    deleteFile: async () => true,
  },
  getPreviewCategory: () => 'text',
  isSystemPath: (path: string) => path.startsWith('skills/'),
}));

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
        models: [{ id: 'm1', modelId: 'm1', displayName: 'M1', isVision: false }],
      },
    ],
    getUISettings: async () => ({ language: 'en', theme: 'light', maxSplitPanels: 1, sendKey: 'enter' }),
    getCommandSettings: async () => ({ enabled: true, userCommands: [], disabledBuiltins: [] }),
    getMentionSettings: async () => ({ enabled: true, tabsEnabled: true, filesEnabled: true }),
    getOcrSettings: async () => ({ enabled: false, providerId: '', modelId: '', prompt: '' }),
  },
}));

vi.mock('@/store/useChatStream', () => ({
  useChatStream: () => ({
    conversations: [],
    currentConversation: null,
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

// Only the input box and the drop path matter here.
vi.mock('@/components/chat/ChatHeader', () => ({ ChatHeader: () => null }));
vi.mock('@/components/chat/ChatMessageList', () => ({ ChatMessageList: () => null }));
vi.mock('@/components/chat/ConversationHistory', () => ({ ConversationHistory: () => null }));

const { FilesPage } = await import('@/entrypoints/options/files/FilesPage');
const { ChatPanel } = await import('@/components/chat/ChatPanel');

/** A `DataTransfer` stand-in: jsdom has no usable implementation. */
function fakeDataTransfer(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    effectAllowed: 'none',
    dropEffect: 'none',
    files: [] as unknown as FileList,
    types: Object.keys(data),
    setData: (type: string, value: string) => {
      data[type] = value;
    },
    getData: (type: string) => data[type] ?? '',
  };
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

/** Side panel contexts the stubbed `getContexts` reports; `null` drops the API. */
let sidePanelContexts: { contextType: string }[] | null = [{ contextType: 'SIDE_PANEL' }];

beforeEach(() => {
  sidePanelContexts = [{ contextType: 'SIDE_PANEL' }];
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: (p: string) => `chrome-extension://test${p}`,
      openOptionsPage: vi.fn(),
      /**
       * A getter, so a test can drop the API by assigning `null` after this stub
       * is installed — that is Chrome < 116, where presence is undetectable and
       * the drag must stay available.
       */
      get getContexts() {
        return sidePanelContexts === null ? undefined : async () => sidePanelContexts;
      },
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

describe('options file list as a drag source', () => {
  it('carries the file reference on the row itself, with a plain-text fallback', async () => {
    render(<FilesPage />);
    await settle();

    const row = screen.getByText(FILE_NAME).closest('[draggable="true"]');
    expect(row, 'the row is the drag handle — no separate grip control').toBeTruthy();

    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(row!, { dataTransfer });

    expect(dataTransfer.getData(LUMO_FILE_REF_MIME)).toBe(FILE_NAME);
    // For drop targets that know nothing about Lumo.
    expect(dataTransfer.getData('text/plain')).toBe(`[filename: ${FILE_NAME}]`);
    expect(dataTransfer.effectAllowed).toBe('copy');
  });

  it('adds no control to the row beyond its action menu', async () => {
    render(<FilesPage />);
    await settle();

    const row = screen.getByText(FILE_NAME).closest('[draggable="true"]')!;
    // Preview / download / delete live behind one trigger, so the drag surface
    // stays a row rather than a toolbar.
    expect(row.querySelectorAll('button')).toHaveLength(1);
  });
});

describe('the drag depends on an open side panel', () => {
  it('stops offering the drag while no panel is open', async () => {
    sidePanelContexts = [];
    render(<FilesPage />);
    await settle();

    const row = screen.getByText(FILE_NAME).closest('[draggable]')!;
    expect(row.getAttribute('draggable')).toBe('false');
    // No tooltip promising a gesture the row will not perform.
    expect(row.getAttribute('title')).toBeNull();
  });

  it('re-checks when the tab is focused, so opening the panel is noticed', async () => {
    sidePanelContexts = [];
    render(<FilesPage />);
    await settle();
    expect(screen.getByText(FILE_NAME).closest('[draggable]')!.getAttribute('draggable')).toBe('false');

    // Opening the panel moves focus off this tab; coming back is the signal.
    sidePanelContexts = [{ contextType: 'SIDE_PANEL' }];
    await act(async () => {
      fireEvent.focus(window);
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(screen.getByText(FILE_NAME).closest('[draggable]')!.getAttribute('draggable')).toBe('true');
  });

  it('keeps the drag when presence cannot be detected at all', async () => {
    // Chrome < 116: a failed probe must not take the feature away.
    sidePanelContexts = null;
    render(<FilesPage />);
    await settle();

    expect(screen.getByText(FILE_NAME).closest('[draggable]')!.getAttribute('draggable')).toBe('true');
  });
});

describe('side panel receiving a file dragged from another document', () => {
  it('attaches it as a file reference, not as plain text', async () => {
    const ref = createRef<ChatPanelHandle>();
    render(
      <ChatPanel
        ref={ref}
        panelIndex={0}
        showSettings
        showSplitButton={false}
        showClose={false}
        occupiedSessionIds={[]}
      />,
    );
    await settle();

    // No `dragstart` was seen in this document, mirroring a drag that began in
    // the options tab.
    const dataTransfer = fakeDataTransfer({
      [LUMO_FILE_REF_MIME]: FILE_NAME,
      'text/plain': `[filename: ${FILE_NAME}]`,
    });
    await act(async () => {
      fireEvent.drop(screen.getByRole('textbox'), { dataTransfer });
    });

    // The chip shows the file name under a "file" label; a text attachment would
    // instead show the raw `[filename: ...]` wrapper.
    expect(screen.getByText(FILE_NAME)).toBeTruthy();
    expect(screen.getByText('sidebar.files.file')).toBeTruthy();
    expect(screen.queryByText(`[filename: ${FILE_NAME}]`)).toBeNull();
  });
});
