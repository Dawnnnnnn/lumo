/**
 * Assistant-turn snapshots.
 *
 * A streaming turn is written to disk in two shapes — a mid-stream checkpoint
 * (`interrupted: true`) and the settled reply — and both are "the same message
 * with different flags". Keeping that construction here makes the flag rules
 * testable without a hook, and keeps the streaming orchestrator focused on
 * lifecycle rather than message shape.
 *
 * A third shape exists once the user steers mid-turn: the assistant message is
 * closed early (it is superseded, not interrupted) and a user message follows
 * it, exactly as the wire prompt has it. See {@link appendSteeredSegment}.
 */

import { hasRenderableParts } from '@/lib/message-parts';
import type {
  ChatMessage,
  ChatMessagePart,
  ChatMessageVariant,
  Conversation,
  TokenUsageStats,
} from '@/types';

/**
 * Identity of one assistant turn, allocated before the first chunk arrives so
 * the streaming bubble and the persisted message agree on both fields.
 */
export interface AssistantTurn {
  /** The id the finished message will be saved under. */
  id: string;
  /** When the turn started — kept across retries so it reflects the user's ask. */
  timestamp: number;
}

export interface AssistantTurnOptions {
  /**
   * A checkpoint is always interrupted; a settled turn is complete unless the
   * user, a teardown or the step cap cut it short.
   */
  interrupted: boolean;
  /** Set when the configured step cap, rather than the model, ended the turn. */
  stopReason?: 'step-limit';
  usage?: TokenUsageStats;
  /** Regeneration variants collected for this turn, when any. */
  variants?: ChatMessageVariant[];
}

/**
 * Append the in-flight assistant turn to `conversation`, or return `null` when
 * it produced nothing worth storing.
 *
 * Never mutates the input: callers hold the previous conversation while a save
 * is in flight, and a mid-stream checkpoint must not leak into it.
 */
export function appendAssistantTurn(
  conversation: Conversation,
  turn: AssistantTurn,
  parts: ChatMessagePart[],
  options: AssistantTurnOptions,
): Conversation | null {
  if (!hasRenderableParts(parts)) return null;

  const message: ChatMessage = {
    ...turn,
    role: 'assistant',
    parts,
    ...(options.interrupted ? { interrupted: true } : {}),
    ...(options.stopReason ? { stopReason: options.stopReason } : {}),
    ...(options.usage ? { usage: options.usage } : {}),
    ...(options.variants ? { variants: options.variants } : {}),
  };

  return {
    ...conversation,
    messages: [...conversation.messages, message],
    updatedAt: Date.now(),
  };
}

/**
 * Close the in-flight segment at a steering boundary and record the user message
 * that superseded it.
 *
 * The closed assistant message is *not* interrupted: it ends where the model
 * naturally paused (every tool call of the step has a result), and the
 * conversation continues right after it. Marking it interrupted would tell the
 * user their reply was cut off when nothing was lost.
 *
 * An empty segment is dropped rather than stored — a step that produced nothing
 * renderable leaves no message behind, but the user message still lands.
 */
export function appendSteeredSegment(
  conversation: Conversation,
  turn: AssistantTurn,
  parts: ChatMessagePart[],
  userMessage: ChatMessage,
): Conversation {
  const withAssistant = appendAssistantTurn(conversation, turn, parts, { interrupted: false });
  const base = withAssistant ?? conversation;
  return {
    ...base,
    messages: [...base.messages, userMessage],
    updatedAt: Date.now(),
  };
}
