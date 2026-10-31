import { describe, it, expect } from 'vitest';
import {
  initialStreamState,
  selectStreamingMessage,
  streamReducer,
  type StreamState,
} from '@/store/stream-machine';
import type { AssistantTurn } from '@/lib/conversation-turn';
import type { ChatMessagePart } from '@/types';

/**
 * Every transition used to be a loose group of `setState` calls scattered across
 * the hook. These tests pin the members of each group, which is the only way to
 * catch a spinner that survives a crash or an error that outlives its attempt.
 */

const TURN: AssistantTurn = { id: 'turn-1', timestamp: 1000 };
const TEXT: ChatMessagePart[] = [{ type: 'text', text: 'hello', state: 'done' }];

function streamingState(overrides: Partial<StreamState> = {}): StreamState {
  return {
    ...initialStreamState,
    isStreaming: true,
    turn: TURN,
    parts: TEXT,
    ...overrides,
  };
}

describe('streamReducer', () => {
  it('starts a fresh turn with nothing carried over, already streaming', () => {
    const state = streamReducer(
      { ...streamingState(), isCompacting: true, error: { message: 'x', category: 'server' } },
      { type: 'turn/start' },
    );
    // Sending enters the streaming phase immediately: Stop is available and the
    // list shows its "thinking" row before the first token arrives.
    expect(state).toEqual({ ...initialStreamState, isStreaming: true });
  });

  it('leaves the streaming phase when the turn settles', () => {
    const started = streamReducer(initialStreamState, { type: 'turn/start' });
    const settled = streamReducer(
      { ...started, turn: TURN, parts: TEXT },
      { type: 'turn/settled' },
    );
    expect(settled.isStreaming).toBe(false);
    expect(settled).toEqual(initialStreamState);
  });

  it('resumes with the streamed parts and turn identity intact', () => {
    const state = streamReducer(streamingState(), { type: 'turn/resume', resume: true });
    expect(state.isStreaming).toBe(true);
    expect(state.turn).toBe(TURN);
    expect(state.parts).toBe(TEXT);
    expect(state.error).toBeNull();
    expect(state.liveUsage).toBeNull();
  });

  it('restarts from scratch when there is no snapshot to resume', () => {
    const state = streamReducer(streamingState(), { type: 'turn/resume', resume: false });
    expect(state.turn).toBeNull();
    expect(state.parts).toEqual([]);
  });

  it('records the allocated turn identity', () => {
    const state = streamReducer(initialStreamState, { type: 'turn/begin', turn: TURN });
    expect(state.turn).toBe(TURN);
  });

  it('settles into the idle state', () => {
    const state = streamReducer(
      { ...streamingState(), isCompacting: true, liveUsage: { usage: {} as never, coveredPartCount: 1 } },
      { type: 'turn/settled' },
    );
    expect(state).toEqual(initialStreamState);
  });

  it('stops the spinner but keeps the partial reply until it is persisted', () => {
    const state = streamReducer(
      { ...streamingState(), isCompacting: true, error: { message: 'x', category: 'server' } },
      { type: 'turn/stopped' },
    );
    expect(state.isStreaming).toBe(false);
    expect(state.isCompacting).toBe(false);
    expect(state.parts).toBe(TEXT);
    expect(state.turn).toBe(TURN);
    expect(state.error).toBeNull();
  });

  it('clears the turn identity on a crash and can drop the partial reply', () => {
    const error = { message: 'boom', category: 'unknown' as const };
    const kept = streamReducer(streamingState(), {
      type: 'turn/crashed',
      error,
      clearParts: false,
    });
    expect(kept.turn).toBeNull();
    expect(kept.parts).toBe(TEXT);
    expect(kept.isStreaming).toBe(false);
    expect(kept.error).toBe(error);

    const dropped = streamReducer(streamingState(), {
      type: 'turn/crashed',
      error,
      clearParts: true,
    });
    expect(dropped.parts).toEqual([]);
  });

  it('keeps streaming while a retry is pending', () => {
    const error = { message: '502', category: 'server' as const };
    const state = streamReducer(streamingState(), {
      type: 'retrying',
      error,
      attempt: 2,
      parts: TEXT,
    });
    expect(state.isStreaming).toBe(true);
    expect(state.isRetrying).toBe(true);
    expect(state.retryAttempt).toBe(2);
    expect(state.error).toBe(error);
  });

  it('ends the turn when the failure is final', () => {
    const error = { message: '401', category: 'auth' as const };
    const state = streamReducer(streamingState(), {
      type: 'failed',
      error,
      attempt: 4,
      parts: TEXT,
    });
    expect(state.isStreaming).toBe(false);
    expect(state.isRetrying).toBe(false);
    expect(state.retryAttempt).toBe(4);
    expect(state.error).toBe(error);
  });

  it('marks overflow recovery without losing the stream phase', () => {
    const recovering = streamReducer(streamingState(), { type: 'overflow/recovering' });
    expect(recovering.isStreaming).toBe(true);
    expect(recovering.isCompacting).toBe(true);
    expect(recovering.isRetrying).toBe(true);

    const recovered = streamReducer(recovering, { type: 'overflow/recovered' });
    expect(recovered.isStreaming).toBe(true);
    expect(recovered.isCompacting).toBe(false);
    expect(recovered.isRetrying).toBe(false);
    expect(recovered.liveUsage).toBeNull();
  });

  it('surfaces the original error when overflow recovery cannot help', () => {
    const error = { message: 'context_length_exceeded', category: 'unknown' as const };
    const state = streamReducer(
      streamReducer(streamingState(), { type: 'overflow/recovering' }),
      { type: 'overflow/failed', error },
    );
    expect(state.isStreaming).toBe(false);
    expect(state.isCompacting).toBe(false);
    expect(state.isRetrying).toBe(false);
    expect(state.retryAttempt).toBe(0);
    expect(state.error).toBe(error);
  });

  it('sets and clears an error without changing the phase', () => {
    const error = { message: 'persist failed', category: 'storage' as const };
    const set = streamReducer(streamingState(), { type: 'error', error });
    expect(set.error).toBe(error);
    expect(set.isStreaming).toBe(true);
    expect(streamReducer(set, { type: 'error', error: null }).error).toBeNull();
  });
});

describe('selectStreamingMessage', () => {
  it('returns null before a turn identity or renderable content exists', () => {
    expect(selectStreamingMessage(null, TEXT)).toBeNull();
    expect(selectStreamingMessage(TURN, [])).toBeNull();
    expect(
      selectStreamingMessage(TURN, [{ type: 'text', text: '', state: 'streaming' }]),
    ).toBeNull();
  });

  it('shapes the in-flight turn as a real assistant message', () => {
    expect(selectStreamingMessage(TURN, TEXT)).toEqual({
      id: 'turn-1',
      timestamp: 1000,
      role: 'assistant',
      parts: TEXT,
    });
  });
});
