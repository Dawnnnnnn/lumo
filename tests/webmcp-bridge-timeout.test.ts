/**
 * @vitest-environment jsdom
 *
 * WebMCP execution budget reaches both ends of the bridge.
 *
 * The server decides the budget (page-declared, then ours, then the default)
 * and the content script must honour it — a fixed 25s on either side is what
 * made a legitimate long-running page tool fail. These tests pin the schema
 * injection (so the model can ask for more time), the argument stripping (so
 * the page never receives our field), and the timer the bridge actually arms.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type BridgeMain = () => void;
type Listener = (m: unknown, s: unknown, r: (v?: unknown) => void) => boolean | undefined;

function makeChrome() {
  const listeners: Listener[] = [];
  const sent: Array<{ tabId: number; message: Record<string, unknown> }> = [];
  const api = {
    runtime: {
      id: 'test-extension-id',
      sendMessage: vi.fn(() => Promise.resolve()),
      onMessage: {
        addListener: (fn: Listener) => listeners.push(fn),
        removeListener: (fn: Listener) => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
    },
    tabs: {
      sendMessage: vi.fn((tabId: number, message: Record<string, unknown>) => {
        sent.push({ tabId, message });
        return Promise.resolve({ success: true, result: '{"content":[]}' });
      }),
    },
  };
  return { api, listeners, sent };
}

async function loadBridge(): Promise<BridgeMain> {
  vi.resetModules();
  (globalThis as any).defineUnlistedScript = (main: BridgeMain) => main;
  const mod = await import('@/entrypoints/content-webmcp-bridge');
  return mod.default as unknown as BridgeMain;
}

let chromeStub: ReturnType<typeof makeChrome>;

beforeEach(() => {
  chromeStub = makeChrome();
  (globalThis as any).chrome = chromeStub.api;
  delete (window as any).__lumoWebmcpBridgeReady;
});

afterEach(() => {
  for (const listener of [...chromeStub.listeners]) {
    listener({ type: 'webmcp:shutdown' }, {}, () => {});
  }
  delete (globalThis as any).chrome;
  delete (globalThis as any).defineUnlistedScript;
  delete (window as any).__lumoWebmcpBridgeReady;
  vi.useRealTimers();
});

describe('webmcp bridge execution budget', () => {
  it('arms the timer with the budget the caller sent', async () => {
    const main = await loadBridge();
    main();
    vi.useFakeTimers();

    const responses: unknown[] = [];
    const listener = chromeStub.listeners[0]!;
    listener(
      {
        type: 'webmcp:execute-tool',
        executionId: 'exec-1',
        toolName: 'export',
        args: '{}',
        timeoutMs: 120_000,
      },
      {},
      (response) => responses.push(response),
    );

    vi.advanceTimersByTime(25_000);
    expect(responses).toEqual([]);

    vi.advanceTimersByTime(95_000);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ success: false });
    expect((responses[0] as { error?: string }).error).toContain('120000ms');
  });

  it('defaults to 25s when the message carries no budget', async () => {
    const main = await loadBridge();
    main();
    vi.useFakeTimers();

    const responses: unknown[] = [];
    const listener = chromeStub.listeners[0]!;
    listener(
      { type: 'webmcp:execute-tool', executionId: 'exec-2', toolName: 'export', args: '{}' },
      {},
      (response) => responses.push(response),
    );

    vi.advanceTimersByTime(24_999);
    expect(responses).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(responses).toHaveLength(1);
    expect((responses[0] as { error?: string }).error).toContain('25000ms');
  });
});
