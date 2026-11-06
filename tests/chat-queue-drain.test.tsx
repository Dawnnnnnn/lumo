// @vitest-environment jsdom
/**
 * The composer's queue, end to end through the hook.
 *
 * Three contracts are pinned here:
 * 1. A send that arrives mid-stream is *kept*, not dropped.
 * 2. When the loop reaches a step boundary it delivers it — the transcript gains
 *    a closed assistant segment, then the user message, and streaming continues
 *    under the same turn.
 * 3. Anything left when the turn ends on its own is sent as its own turn.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ChatMessagePart, ModelConfig, ProviderConfig, QueuedUserInput } from '@/types';

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
      contextWindow: 1_000_000,
    },
  ],
};
const model: ModelConfig = provider.models[0]!;

/** Captured options of the most recent `chatStream` call. */
let streamOpts: {
  pullQueuedInput?: () => QueuedUserInput[];
  onInputInjected?: (input: QueuedUserInput) => Promise<void> | void;
  onUpdate?: (parts: ChatMessagePart[]) => void;
  onFinish: (parts: ChatMessagePart[], reason: string) => void;
} | null = null;
/** Released by the test to let the open request finish. */
let finishStream: (() => void) | null = null;

const chatStream = vi.fn(async (opts: NonNullable<typeof streamOpts>) => {
  streamOpts = opts;
  await new Promise<void>((resolve) => {
    finishStream = resolve;
  });
  opts.onFinish([{ type: 'text', text: 'reply', state: 'done' }], 'finished');
});

vi.mock('@/lib/ai', () => ({
  resumeFingerprint: () => 'fp',
  generateCompactionSummary: async () => ({ text: 'SUMMARY' }),
  chatStream: (opts: NonNullable<typeof streamOpts>) => chatStream(opts),
}));

vi.mock('@/lib/system-prompt', () => ({ resolveSystemPrompt: () => undefined }));

vi.mock('@/store/storage', () => ({
  storage: {
    getSystemPrompt: async () => ({ enabled: false, prompt: '' }),
    getUISettings: async () => ({
      maxSteps: 0,
      compaction: { enabled: false, reserve: { unit: 'tokens', value: 100 }, keepRecentTokens: 1 },
    }),
    bumpConversationsRevision: async () => {},
  },
}));

const { useChatStream } = await import('@/store/useChatStream');

function stubChrome() {
  chatStream.mockClear();
  streamOpts = null;
  finishStream = null;
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (o: Record<string, unknown>) => {
          Object.assign(store, o);
        },
      },
      session: {
        get: async () => ({}),
        set: async () => {},
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const send = (
  handleSend: ReturnType<typeof useChatStream>['handleSend'],
  text: string,
): Promise<void> => handleSend(text, [], [], () => provider, () => model, 'p1', 'm1');

describe('mid-turn queue', () => {
  it('keeps a message sent while streaming instead of dropping it', async () => {
    stubChrome();
    const { result } = renderHook(() => useChatStream({ panelId: 0 }));

    await act(async () => {
      void send(result.current.handleSend, 'hi');
      await sleep(80);
    });
    expect(result.current.isStreaming).toBe(true);

    await act(async () => {
      void send(result.current.handleSend, 'also check the header');
      await sleep(10);
    });

    // Queued, visible, and not yet part of the conversation.
    expect(result.current.queuedInputs.map((item) => item.text)).toEqual([
      'also check the header',
    ]);
    expect(
      result.current.currentConversation?.messages.filter((m) => m.role === 'user'),
    ).toHaveLength(1);

    await act(async () => {
      finishStream?.();
    });

    // The turn settled, so the queue takes over as its own turn. That happens
    // once the settled message is written, hence the wait.
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(2), { timeout: 5000 });

    await act(async () => {
      finishStream?.();
      await sleep(100);
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(result.current.queuedInputs).toHaveLength(0);

    // The queued message ran as its own turn after the first one settled.
    const roles = result.current.currentConversation!.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
  }, 20_000);

  it('delivers a queued message at a step boundary, closing the segment', async () => {
    stubChrome();
    const { result } = renderHook(() => useChatStream({ panelId: 0 }));

    await act(async () => {
      void send(result.current.handleSend, 'hi');
      await sleep(80);
    });
    const opts = streamOpts!;
    expect(opts.pullQueuedInput).toBeTypeOf('function');

    await act(async () => {
      void send(result.current.handleSend, 'actually the sidebar');
      await sleep(10);
    });
    expect(result.current.queuedInputs).toHaveLength(1);

    // The loop's first step streamed something, then reached a boundary.
    await act(async () => {
      opts.onUpdate?.([{ type: 'text', text: 'checking…', state: 'done' }]);
      const delivered = opts.pullQueuedInput!();
      for (const input of delivered) await opts.onInputInjected!(input);
      await sleep(60);
    });

    // Streaming never stopped, the queue is empty, and the transcript already
    // holds the closed segment followed by the user's message.
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.queuedInputs).toHaveLength(0);
    expect(result.current.currentConversation!.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    const closed = result.current.currentConversation!.messages[1]!;
    expect(closed.interrupted).toBeUndefined();

    // The streaming bubble is now the *new* segment, so it is empty, not a copy
    // of the closed message.
    expect(result.current.streamingMessage).toBeNull();

    await act(async () => {
      finishStream?.();
      await sleep(200);
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(result.current.currentConversation!.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  }, 20_000);

  it('hands the queue back when the user stops', async () => {
    stubChrome();
    const { result } = renderHook(() => useChatStream({ panelId: 0 }));

    await act(async () => {
      void send(result.current.handleSend, 'hi');
      await sleep(80);
    });
    await act(async () => {
      void send(result.current.handleSend, 'never mind');
      await sleep(10);
    });

    let abandoned: QueuedUserInput[] = [];
    act(() => {
      abandoned = result.current.handleStop();
    });

    expect(abandoned.map((item) => item.text)).toEqual(['never mind']);
    expect(result.current.queuedInputs).toHaveLength(0);

    await act(async () => {
      finishStream?.();
      await sleep(150);
    });
    // Stopping abandons the turn: the queue must not fire as a follow-up.
    expect(chatStream).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('withdraws a single queued message', async () => {
    stubChrome();
    const { result } = renderHook(() => useChatStream({ panelId: 0 }));

    await act(async () => {
      void send(result.current.handleSend, 'hi');
      await sleep(80);
    });
    await act(async () => {
      void send(result.current.handleSend, 'first');
      void send(result.current.handleSend, 'second');
      await sleep(10);
    });
    expect(result.current.queuedInputs).toHaveLength(2);

    const head = result.current.queuedInputs[0]!;
    let withdrawn: QueuedUserInput | null = null;
    act(() => {
      withdrawn = result.current.handleDequeue(head.id);
    });

    expect(withdrawn).toMatchObject({ text: 'first' });
    expect(result.current.queuedInputs.map((item) => item.text)).toEqual(['second']);

    await act(async () => {
      finishStream?.();
      await sleep(200);
      finishStream?.();
      await sleep(300);
    });
  }, 20_000);
});
