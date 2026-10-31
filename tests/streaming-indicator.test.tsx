// @vitest-environment jsdom
/**
 * The composer's waiting state is driven entirely by `isStreaming`: it decides
 * whether the send button becomes Stop and whether the list shows its "thinking"
 * row. The reducer rewrite briefly made `turn/start` reset that flag to `false`,
 * so a sent message produced neither — and every `if (isStreaming) return` guard
 * in the store silently stopped holding.
 *
 * These tests pin the flag across the three ways a turn can leave the phase:
 * settle, stop, and a stop that lands before the runner even exists.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ChatMessagePart, ModelConfig, ProviderConfig } from '@/types';

const provider: ProviderConfig = {
  id: 'p1',
  name: 'P',
  type: 'openai-chat',
  baseUrl: 'https://x/v1',
  apiKey: 'k',
  models: [
    {
      id: 'm1',
      modelId: 'gpt-x',
      displayName: 'M',
      isVision: false,
      // Large enough that pre-send compaction never fires: this is about the
      // streaming flag, not folding.
      contextWindow: 1_000_000,
    },
  ],
};
const model: ModelConfig = provider.models[0]!;

/** Set while `chatStream` is awaiting; calling it delivers the reply. */
let finishStream: (() => void) | null = null;
/** When set, the next `saveConversation` call waits for it. */
let nextSaveGate: Promise<void> | null = null;

const chatStream = vi.fn(
  async (opts: { onFinish: (parts: ChatMessagePart[], reason: string) => void }) => {
    await new Promise<void>((resolve) => {
      finishStream = resolve;
    });
    opts.onFinish([{ type: 'text', text: 'reply', state: 'done' }], 'finished');
  },
);

vi.mock('@/lib/ai', () => ({
  resumeFingerprint: () => 'fp',
  generateCompactionSummary: async () => ({ text: 'SUMMARY' }),
  chatStream: (opts: Parameters<typeof chatStream>[0]) => chatStream(opts),
}));

vi.mock('@/lib/system-prompt', () => ({ resolveSystemPrompt: () => undefined }));

vi.mock('@/store/storage', () => ({
  storage: {
    getSystemPrompt: async () => ({ enabled: false, prompt: '' }),
    getUISettings: async () => ({
      maxSteps: 0,
      compaction: {
        enabled: true,
        reserve: { unit: 'tokens', value: 100 },
        keepRecentTokens: 1,
      },
    }),
    bumpConversationsRevision: async () => {},
  },
}));

// Only `saveConversation` is gated: it is the one write `handleSend` waits on
// before the runner starts, i.e. the window where Stop has nothing to abort.
vi.mock('@/lib/conversation-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/conversation-store')>();
  return {
    ...actual,
    saveConversation: async (...args: Parameters<typeof actual.saveConversation>) => {
      const gate = nextSaveGate;
      if (gate) {
        nextSaveGate = null;
        await gate;
      }
      return actual.saveConversation(...args);
    },
  };
});

const { useChatStream } = await import('@/store/useChatStream');

function stubChrome() {
  chatStream.mockClear();
  finishStream = null;
  nextSaveGate = null;
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (o: Record<string, unknown>) => {
          Object.assign(store, o);
        },
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('streaming indication', () => {
  it('enters the streaming phase as soon as the turn is sent', async () => {
    stubChrome();
    const { result } = renderHook(() => useChatStream({ panelId: 0 }));

    let send: Promise<void> | undefined;
    await act(async () => {
      send = result.current.handleSend('hi', [], [], () => provider, () => model, 'p1', 'm1');
      await sleep(60);
    });

    // This is what makes the composer render Stop instead of Send and the list
    // render its "thinking" row while the request is still open.
    expect(result.current.isStreaming).toBe(true);
    expect(chatStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishStream?.();
      await sleep(150);
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(false), { timeout: 3000 });
    await act(async () => {
      await send;
    });
  }, 20_000);

  it('leaves the phase when the user stops', async () => {
    stubChrome();
    const { result } = renderHook(() => useChatStream({ panelId: 0 }));

    await act(async () => {
      void result.current.handleSend('hi', [], [], () => provider, () => model, 'p1', 'm1');
      await sleep(60);
    });
    expect(result.current.isStreaming).toBe(true);

    act(() => {
      result.current.handleStop();
    });
    expect(result.current.isStreaming).toBe(false);

    // Let the aborted stream unwind so nothing is left in flight.
    await act(async () => {
      finishStream?.();
      await sleep(120);
    });
  }, 20_000);

  it('does not start the request when stopped during the pre-flight save', async () => {
    stubChrome();
    const { result } = renderHook(() => useChatStream({ panelId: 0 }));
    let releaseGate: (() => void) | null = null;
    nextSaveGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    let send: Promise<void> | undefined;
    await act(async () => {
      send = result.current.handleSend('hi', [], [], () => provider, () => model, 'p1', 'm1');
      await sleep(60);
    });

    expect(result.current.isStreaming).toBe(true);
    expect(chatStream).not.toHaveBeenCalled();

    act(() => {
      result.current.handleStop();
    });

    await act(async () => {
      releaseGate?.();
      await send;
      await sleep(100);
    });

    // The user turn may be stored, but nothing was sent and nothing is streaming.
    expect(result.current.isStreaming).toBe(false);
    expect(chatStream).not.toHaveBeenCalled();
  }, 20_000);
});
