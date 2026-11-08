// @vitest-environment jsdom
/**
 * The about page's two claims that matter if they are wrong.
 *
 * **The channel line.** It is the answer to "which build is this", and every
 * install route can be present at once as separate extensions — a badge that
 * says "Chrome Web Store" on an unpacked build, or on the Edge listing, would
 * make every version-specific bug report misleading.
 *
 * **The clear buttons.** They delete unrecoverable user data. What is exercised
 * here is the boundary: a declined confirmation must touch nothing, an accepted
 * one must also fix up the panel pointers and broadcast the change (otherwise a
 * side panel keeps a conversation open that no longer exists), and neither button
 * may go anywhere near the settings area where providers and API keys live.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { CHROME_STORE_ID, EDGE_STORE_ID } from '@/lib/extension-info';
import type { StorageUsageReport } from '@/lib/storage-usage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

const clearConversations = vi.fn(async () => {});
const clearFiles = vi.fn(async () => 2);
const resetPanelConversations = vi.fn(async () => ['currentConversationId']);
const bumpConversationsRevision = vi.fn(async () => {});

vi.mock('@/lib/conversation-store', () => ({
  clearConversations: () => clearConversations(),
}));
vi.mock('@/lib/mcp/file-storage', () => ({
  fileStorage: { clearFiles: () => clearFiles() },
}));
vi.mock('@/lib/panel-storage', () => ({
  localPanelStorage: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
  resetPanelConversations: () => resetPanelConversations(),
}));
vi.mock('@/store/storage', () => ({
  storage: { bumpConversationsRevision: () => bumpConversationsRevision() },
}));

const { AboutIdentity } = await import('@/entrypoints/options/about/AboutIdentity');
const { StorageUsageCard } = await import('@/entrypoints/options/about/StorageUsageCard');

function report(overrides: Partial<StorageUsageReport> = {}): StorageUsageReport {
  return {
    conversations: { count: 3, bytes: 4096 },
    screenshots: { count: 2, bytes: 8192 },
    files: { count: 1, bytes: 512 },
    origin: null,
    ...overrides,
  };
}

const EMPTY = report({
  conversations: { count: 0, bytes: 0 },
  screenshots: { count: 0, bytes: 0 },
  files: { count: 0, bytes: 0 },
});

function buttonFor(container: HTMLElement, key: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[title="${key}"]`);
  if (!button) throw new Error(`no button titled ${key}`);
  return button;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AboutIdentity', () => {
  it('badges the chrome store channel with its own listing name', () => {
    vi.stubGlobal('chrome', {
      runtime: { id: CHROME_STORE_ID, getManifest: () => ({ version: '1.0.6' }) },
    });

    const { container } = render(<AboutIdentity />);

    expect(container.textContent).toContain('options.about.channels.chrome');
    expect(container.textContent).toContain('options.about.channelDesc.store');
    expect(container.textContent).not.toContain('options.about.channels.edge');
    expect(container.textContent).toContain('v1.0.6');
    expect(container.textContent).toContain(CHROME_STORE_ID);
  });

  it('badges the edge store channel with its own listing name', () => {
    vi.stubGlobal('chrome', {
      runtime: { id: EDGE_STORE_ID, getManifest: () => ({ version: '1.0.6' }) },
    });

    const { container } = render(<AboutIdentity />);

    // Same package, different listing: the badge must name the store the user
    // installed from, and the id line must show the id that store assigned.
    expect(container.textContent).toContain('options.about.channels.edge');
    expect(container.textContent).toContain('options.about.channelDesc.store');
    expect(container.textContent).not.toContain('options.about.channels.chrome');
    expect(container.textContent).toContain(EDGE_STORE_ID);
  });

  it('leaves an unpacked build unbadged, describing it in prose instead', () => {
    vi.stubGlobal('chrome', {
      runtime: { id: 'localbuildlocalbuildlocalbuild00', getManifest: () => ({ version: '1.0.6' }) },
    });

    const { container } = render(<AboutIdentity />);

    // A badge would imply an official channel this build did not come from.
    expect(container.textContent).not.toContain('options.about.channels.chrome');
    expect(container.textContent).not.toContain('options.about.channels.edge');
    expect(container.textContent).toContain('options.about.channelDesc.github');
  });
});

describe('StorageUsageCard clearing', () => {
  it('clears history, repoints the panels and broadcasts, in that order', async () => {
    vi.stubGlobal('confirm', () => true);
    const refresh = vi.fn(async () => {});
    const { container } = render(
      <StorageUsageCard report={report()} loading={false} refresh={refresh} />,
    );

    await click(buttonFor(container, 'options.about.storage.clearChat'));

    expect(clearConversations).toHaveBeenCalledOnce();
    // Without this the sidebar keeps a pointer to a deleted conversation.
    expect(resetPanelConversations).toHaveBeenCalledOnce();
    // Bumped last, so other contexts re-read a database that has settled.
    expect(bumpConversationsRevision).toHaveBeenCalledOnce();
    expect(clearConversations.mock.invocationCallOrder[0]!).toBeLessThan(
      bumpConversationsRevision.mock.invocationCallOrder[0]!,
    );
    expect(refresh).toHaveBeenCalled();
    // Files are a separate button and a separate decision.
    expect(clearFiles).not.toHaveBeenCalled();
  });

  it('touches nothing when the confirmation is declined', async () => {
    vi.stubGlobal('confirm', () => false);
    const { container } = render(
      <StorageUsageCard report={report()} loading={false} refresh={vi.fn()} />,
    );

    await click(buttonFor(container, 'options.about.storage.clearChat'));
    await click(buttonFor(container, 'options.about.storage.clearFiles'));

    expect(clearConversations).not.toHaveBeenCalled();
    expect(clearFiles).not.toHaveBeenCalled();
  });

  it('clears files without disturbing the chat history', async () => {
    vi.stubGlobal('confirm', () => true);
    const { container } = render(
      <StorageUsageCard report={report()} loading={false} refresh={vi.fn()} />,
    );

    await click(buttonFor(container, 'options.about.storage.clearFiles'));

    expect(clearFiles).toHaveBeenCalledOnce();
    expect(clearConversations).not.toHaveBeenCalled();
    expect(bumpConversationsRevision).not.toHaveBeenCalled();
  });

  it('disables both buttons when there is nothing to clear', () => {
    const { container } = render(
      <StorageUsageCard report={EMPTY} loading={false} refresh={vi.fn()} />,
    );

    expect(buttonFor(container, 'options.about.storage.clearChat').disabled).toBe(true);
    expect(buttonFor(container, 'options.about.storage.clearFiles').disabled).toBe(true);
  });

  it('offers history clearing when only screenshots are left', () => {
    // Blobs outlive their conversation records if a write was interrupted, and
    // they are the larger half of chat storage — the button has to reach them.
    const { container } = render(
      <StorageUsageCard
        report={report({
          conversations: { count: 0, bytes: 0 },
          screenshots: { count: 4, bytes: 40960 },
        })}
        loading={false}
        refresh={vi.fn()}
      />,
    );

    expect(buttonFor(container, 'options.about.storage.clearChat').disabled).toBe(false);
  });
});

describe('StorageUsageCard rows', () => {
  it('counts screenshots into the chat history line rather than a row of their own', () => {
    const { container } = render(
      <StorageUsageCard report={report()} loading={false} refresh={vi.fn()} />,
    );

    // 4 KB of conversation JSON + 8 KB of offloaded screenshots. They are
    // deleted by the same button, so reporting them apart would imply a
    // decision the user does not have.
    expect(container.textContent).toContain('12.0 KB');
    expect(container.textContent).not.toContain('options.about.storage.screenshots');
  });
});

describe('StorageUsageCard quota bar', () => {
  it('hides the browser estimate when the browser does not expose one', () => {
    const { container } = render(
      <StorageUsageCard report={report()} loading={false} refresh={vi.fn()} />,
    );

    expect(container.textContent).not.toContain('options.about.storage.origin');
  });

  it('shows the estimate as a proportion when it is available', () => {
    const { container } = render(
      <StorageUsageCard
        report={report({ origin: { usage: 2048, quota: 8192 } })}
        loading={false}
        refresh={vi.fn()}
      />,
    );

    expect(container.textContent).toContain('options.about.storage.origin');
    const bar = container.querySelector<HTMLElement>('.bg-primary');
    expect(bar?.style.width).toBe('25%');
  });
});
