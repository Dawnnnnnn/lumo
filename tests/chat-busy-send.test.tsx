// @vitest-environment jsdom
/**
 * Busy-send behaviour: what a send does while an assistant turn is streaming.
 *
 * `steer` is covered end to end by `chat-queue-drain.test.tsx`. This suite pins
 * the other mode, which makes a much stronger promise: the running reply is
 * abandoned, and the replacement is ordered *after* the reply it interrupted —
 * which is why the delivery waits for the aborted turn's write to land.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type {
  ChatMessage,
  ChatMessagePart,
  ModelConfig,
  ProviderConfig,
} from '@/types';

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

/** What the mocked user settings report; the mode under test flips per case. */
let busySend: 'steer' | 'interrupt' = 'interrupt';

interface StreamOptions {
  signal?: AbortSignal;
  onUpdate?: (parts: ChatMessagePart[]) => void;
  onFinish: (parts: ChatMessagePart[], reason: string) => void;
}

const chatStream = vi.fn(async (opts: StreamOptions) => {
  const call = chatStream.mock.calls.length;
  if (call > 1) {
    // The replacement turn answers straight away.
    opts.onFinish([{ type: 'text', text: 'second reply', state: 'done' }], 'finished');
    return;
  }
  const partial: ChatMessagePart = { type: 'text', text: 'working', state: 'streaming' };
  opts.onUpdate?.([partial]);
  await new Promise<void>((resolve) => {
    if (opts.signal?.aborted) {
      resolve();
      return;
    }
    opts.signal?.addEventListener('abort', () => resolve(), { once: true });
  });
  // Mirrors the real stream: an abort settles with what was streamed so far.
  opts.onFinish(
    [{ type: 'text', text: 'working', state: 'done' }],
    opts.signal?.aborted ? 'aborted' : 'finished',
  );
});

vi.mock('@/lib/ai', () => ({
  resumeFingerprint: () => 'fp',
  generateCompactionSummary: async () => ({ text: 'SUMMARY' }),
  chatStream: (opts: StreamOptions) => chatStream(opts),
}));

vi.mock('@/lib/system-prompt', () => ({ resolveSystemPrompt: () => undefined }));

vi.mock('@/store/storage', () => ({
  storage: {
    getSystemPrompt: async () => ({ enabled: false, prompt: '' }),
    getUISettings: async () => ({
      maxSteps: 0,
      busySend,
      compaction: {
        enabled: false,
        reserve: { unit: 'tokens', value: 100 },
        keepRecentTokens: 1,
      },
    }),
    bumpConversationsRevision: async () => {},
  },
}));

const { useChatStream } = await import('@/store/useChatStream');

function stubChrome() {
  chatStream.mockClear();
  busySend = 'interrupt';
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (o: Record<string, unknown>) => {
          Object.assign(store, o);
        },
      },
      session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const send = (
  handleSend: ReturnType<typeof useChatStream>['handleSend'],
  text: string,
  getModel: () => ModelConfig | undefined = () => model,
): Promise<void> => handleSend(text, [], [], () => provider, getModel, 'p1', 'm1');

function textOf(message: ChatMessage | undefined): string {
  if (!message?.parts) return '';
  return message.parts
    .filter((part): part is Extract<ChatMessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

describe('busy send: interrupt', () => {
  it('abandons the running reply and sends immediately', async () => {
    stubChrome();
    const { result } = renderHook(() => useChatStream({ panelId: 0 }));

    await act(async () => {
      void send(result.current.handleSend, 'hi');
      await sleep(80);
    });
    expect(result.current.isStreaming).toBe(true);
    expect(chatStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      void send(result.current.handleSend, 'stop that');
      // The replacement request only starts once the aborted turn is written.
      await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(2), { timeout: 5000 });
      await sleep(200);
    });

    // Nothing is queued in this mode: the message went straight through.
    expect(result.current.queuedInputs).toHaveLength(0);

    const messages = result.current.currentConversation!.messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    // The interrupted reply is kept, labelled, and ordered before the message
    // that replaced it.
    expect(messages[1]!.interrupted).toBe(true);
    expect(textOf(messages[1])).toBe('working');
    expect(textOf(messages[2])).toBe('stop that');
    expect(textOf(messages[3])).toBe('second reply');

    await waitFor(() => expect(result.current.isStreaming).toBe(false));
  }, 20_000);

  it('queues instead of interrupting when there is nothing to send with', async () => {
    stubChrome();
    const { result } = renderHook(() => useChatStream({ panelId: 0 }));

    await act(async () => {
      void send(result.current.handleSend, 'hi');
      await sleep(80);
    });
    expect(result.current.isStreaming).toBe(true);

    await act(async () => {
      // No model selected: interrupting would abandon the reply for nothing.
      void send(result.current.handleSend, 'later', () => undefined);
      await sleep(60);
    });

    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.queuedInputs.map((item) => item.text)).toEqual(['later']);
  }, 20_000);

  it('keeps steering when the setting says so', async () => {
    stubChrome();
    busySend = 'steer';
    const { result } = renderHook(() => useChatStream({ panelId: 0 }));
    // Let the settings read land before sending.
    await act(async () => {
      await sleep(20);
    });

    await act(async () => {
      void send(result.current.handleSend, 'hi');
      await sleep(80);
    });
    await act(async () => {
      void send(result.current.handleSend, 'later');
      await sleep(60);
    });

    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.queuedInputs.map((item) => item.text)).toEqual(['later']);
  }, 20_000);
});
