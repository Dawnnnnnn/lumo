/**
 * Streaming-turn state machine.
 *
 * The hook used to hold eight independent `useState` values and update them in
 * loose groups at a dozen call sites. The groups are the actual transitions —
 * "a turn started", "a turn settled", "retry scheduled", "crash" — and getting
 * one member wrong produced UI that disagreed with itself (a spinner left on,
 * a stale live anchor, an error with no attempt count).
 *
 * Keeping the transitions explicit and pure makes each one testable and gives
 * the hook a single `dispatch` instead of eight setters. Refs stay outside: the
 * turn identity, resume snapshot and checkpoint writer must be readable from
 * async callbacks without re-subscribing.
 */

import type { ChatMessage, ChatMessagePart } from '@/types';
import { hasRenderableParts } from '@/lib/message-parts';
import type { LiveUsage } from '@/lib/context-usage';
import type { ChatErrorInfo } from '@/lib/provider-error';

import type { AssistantTurn } from '@/lib/conversation-turn';

export interface StreamState {
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  retryAttempt: number;
  /** Identity of the in-flight assistant turn, once allocated. */
  turn: AssistantTurn | null;
  /** Parts streamed so far for the in-flight turn. */
  parts: ChatMessagePart[];
  /** Latest completed step of the in-flight turn, when available. */
  liveUsage: LiveUsage | null;
  error: ChatErrorInfo | null;
}

export const initialStreamState: StreamState = {
  isStreaming: false,
  isCompacting: false,
  isRetrying: false,
  retryAttempt: 0,
  turn: null,
  parts: [],
  liveUsage: null,
  error: null,
};

export type StreamAction =
  /**
   * A fresh turn: clear everything from the previous one *and* enter the
   * streaming phase. Sending is what starts the phase — the composer must show
   * Stop and the list its "thinking" row from this dispatch, not from the first
   * token (a request that never returns still has to be cancellable).
   */
  | { type: 'turn/start' }
  /**
   * A retry of the current turn. `resume` keeps the already-streamed parts and
   * the turn identity; a full restart clears both.
   */
  | { type: 'turn/resume'; resume: boolean }
  /** The loop allocated (or reused) the assistant turn identity. */
  | { type: 'turn/begin'; turn: AssistantTurn }
  /**
   * A user message was delivered mid-turn: the streamed segment closed and the
   * continuation streams under a new identity, starting from empty parts.
   * Streaming never stopped, so the composer must not flip back to Send.
   */
  | { type: 'turn/steer'; turn: AssistantTurn }
  /** The turn produced its final state and was persisted. */
  | { type: 'turn/settled' }
  /** The user stopped: no spinner, but the partial reply stays until persisted. */
  | { type: 'turn/stopped' }
  /** An unexpected failure outside the stream: optionally drop the partial reply. */
  | { type: 'turn/crashed'; error: ChatErrorInfo; clearParts: boolean }
  /** Streamed parts changed. */
  | { type: 'parts'; parts: ChatMessagePart[] }
  /** A step completed, giving the ring a real prompt size to anchor on. */
  | { type: 'usage'; liveUsage: LiveUsage }
  /** A summarization call started or finished. */
  | { type: 'compacting'; value: boolean }
  /** A transient failure will be retried after a backoff. */
  | { type: 'retrying'; error: ChatErrorInfo; attempt: number; parts: ChatMessagePart[] }
  /** The failure is final for this turn. */
  | { type: 'failed'; error: ChatErrorInfo; attempt: number; parts: ChatMessagePart[] }
  /** A context overflow is being folded away before one retry. */
  | { type: 'overflow/recovering' }
  /** The fold succeeded; the retry is about to start. */
  | { type: 'overflow/recovered' }
  /** The fold failed or could not help; surface the original error. */
  | { type: 'overflow/failed'; error: ChatErrorInfo }
  /** Record or clear an error without changing the turn phase. */
  | { type: 'error'; error: ChatErrorInfo | null }
  /** Abandon everything (new chat, switch conversation, teardown). */
  | { type: 'reset' };

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case 'turn/start':
      return { ...initialStreamState, isStreaming: true };
    case 'turn/resume':
      return {
        ...state,
        isStreaming: true,
        isRetrying: false,
        retryAttempt: 0,
        error: null,
        liveUsage: null,
        ...(action.resume ? {} : { turn: null, parts: [] }),
      };
    case 'turn/begin':
      return { ...state, turn: action.turn };
    case 'turn/steer':
      return {
        ...state,
        turn: action.turn,
        parts: [],
        // The anchor described the closed segment's part list; the new segment
        // starts empty and re-anchors on its first completed step.
        liveUsage: null,
      };
    case 'turn/settled':
      return {
        ...initialStreamState,
        // A settled turn keeps no streaming UI; the saved message takes over.
      };
    case 'turn/stopped':
      return {
        ...state,
        isStreaming: false,
        isCompacting: false,
        isRetrying: false,
        retryAttempt: 0,
        error: null,
        liveUsage: null,
      };
    case 'turn/crashed':
      return {
        ...state,
        isStreaming: false,
        isRetrying: false,
        turn: null,
        error: action.error,
        parts: action.clearParts ? [] : state.parts,
      };
    case 'parts':
      return { ...state, parts: action.parts };
    case 'usage':
      return { ...state, liveUsage: action.liveUsage };
    case 'compacting':
      return { ...state, isCompacting: action.value };
    case 'retrying':
      return {
        ...state,
        isRetrying: true,
        retryAttempt: action.attempt,
        error: action.error,
        parts: action.parts,
      };
    case 'failed':
      return {
        ...state,
        isStreaming: false,
        isRetrying: false,
        retryAttempt: action.attempt,
        error: action.error,
        parts: action.parts,
      };
    case 'overflow/recovering':
      return { ...state, isRetrying: true, isCompacting: true };
    case 'overflow/recovered':
      return { ...state, isRetrying: false, isCompacting: false, liveUsage: null };
    case 'overflow/failed':
      return {
        ...state,
        isStreaming: false,
        isCompacting: false,
        isRetrying: false,
        retryAttempt: 0,
        error: action.error,
      };
    case 'error':
      return { ...state, error: action.error };
    case 'reset':
      return { ...initialStreamState };
  }
}

/**
 * The in-flight turn shaped as a real message, or `null` before it renders.
 *
 * Takes the two fields rather than the whole state so the memoized result keeps
 * its identity when unrelated fields change (a compaction flag must not make
 * the message list re-render).
 */
export function selectStreamingMessage(
  turn: AssistantTurn | null,
  parts: readonly ChatMessagePart[],
): ChatMessage | null {
  if (!turn || !hasRenderableParts(parts)) return null;
  return {
    id: turn.id,
    timestamp: turn.timestamp,
    role: 'assistant',
    parts: [...parts],
  };
}
