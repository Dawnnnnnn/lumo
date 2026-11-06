/**
 * Durability for one assistant turn.
 *
 * Every write of the in-flight turn goes through here: the throttled mid-stream
 * checkpoint, the forced checkpoint after a completed step, the teardown flush,
 * and the final save. The turn identity, variants and conversation are fixed
 * here so a snapshot cannot accidentally combine another turn's message with
 * this one's identity.
 *
 * Persistence never touches React. The orchestrator passes the save/open ports
 * and decides which state transition accompanies a successful write.
 */

import { appendAssistantTurn, appendSteeredSegment, type AssistantTurn } from '@/lib/conversation-turn';
import { hasRenderableParts } from '@/lib/message-parts';
import { toError } from '@/lib/provider-error';
import type {
  ChatMessage,
  ChatMessagePart,
  ChatMessageVariant,
  Conversation,
  TokenUsageStats,
} from '@/types';

/**
 * Minimum gap between mid-stream checkpoints.
 *
 * A turn can emit hundreds of chunks per second, so checkpointing on every
 * update would queue an IndexedDB write per token. One second bounds how much of
 * a reply an abrupt teardown can cost while keeping writes far enough apart to
 * stay off the render path.
 */
const CHECKPOINT_INTERVAL = 1000;

export interface SnapshotOptions {
  interrupted: boolean;
  stopReason?: 'step-limit';
  usage?: TokenUsageStats;
}

export interface TurnPersistencePorts {
  save: (conversation: Conversation, options?: { create?: boolean }) => Promise<void>;
  saveDraft: (conversation: Conversation) => Promise<void>;
  open: (conversation: Conversation) => Promise<void>;
  onSaveError: (error: Error) => void;
}

export interface TurnPersistenceInput {
  conversation: Conversation;
  turn: AssistantTurn;
  variants?: ChatMessageVariant[];
  canCreate: boolean;
  ports: TurnPersistencePorts;
}

export class TurnPersistence {
  conversation: Conversation;
  latestParts: ChatMessagePart[] = [];
  turn: AssistantTurn;

  private readonly variants?: ChatMessageVariant[];
  private readonly canCreate: boolean;
  private readonly ports: TurnPersistencePorts;
  private lastCheckpointAt = 0;
  private checkpointInFlight = false;

  constructor(input: TurnPersistenceInput) {
    this.conversation = input.conversation;
    this.turn = input.turn;
    this.variants = input.variants;
    this.canCreate = input.canCreate;
    this.ports = input.ports;
  }

  /** Adopt a new conversation version (a compaction checkpoint). */
  adopt(conversation: Conversation): void {
    this.conversation = conversation;
  }

  setParts(parts: ChatMessagePart[]): void {
    this.latestParts = parts;
  }

  /**
   * Close the in-flight assistant segment and append the user message that
   * superseded it.
   *
   * The segment settles as a complete message: it ended where the model paused
   * for its tool results, so nothing was lost and the "interrupted" label would
   * be a lie. The caller assigns the next segment's identity (see
   * {@link setTurn}) — the closed one now belongs to the transcript, and the
   * streaming bubble must not be keyed to it.
   */
  closeSegment(parts: ChatMessagePart[], userMessage: ChatMessage): Conversation {
    this.conversation = appendSteeredSegment(
      this.conversation,
      this.turn,
      parts,
      userMessage,
    );
    this.latestParts = [];
    // A segment boundary is a checkpoint: the closed segment and the user
    // message are written together, so the clock starts now.
    this.lastCheckpointAt = Date.now();
    return this.conversation;
  }

  /** Adopt the identity of the segment that is now streaming. */
  setTurn(turn: AssistantTurn): void {
    this.turn = turn;
  }

  /**
   * The conversation with this turn's assistant message appended, or `null`
   * when the parts are not worth storing.
   */
  snapshot(
    parts: ChatMessagePart[],
    options: SnapshotOptions,
    conversation: Conversation = this.conversation,
  ): Conversation | null {
    return appendAssistantTurn(conversation, this.turn, parts, {
      interrupted: options.interrupted,
      ...(options.stopReason ? { stopReason: options.stopReason } : {}),
      ...(options.usage ? { usage: options.usage } : {}),
      ...(this.variants ? { variants: this.variants } : {}),
    });
  }

  /** Force a checkpoint: a completed step is worth writing unconditionally. */
  async checkpoint(parts: ChatMessagePart[]): Promise<void> {
    const snapshot = this.snapshot(parts, { interrupted: true });
    if (!snapshot) return;
    this.lastCheckpointAt = Date.now();
    await this.ports.saveDraft(snapshot);
  }

  /**
   * Throttled checkpoint for stream updates. Serialises writes so overlapping
   * transactions on the same record cannot race.
   */
  checkpointThrottled(parts: ChatMessagePart[]): void {
    const now = Date.now();
    if (this.checkpointInFlight || now - this.lastCheckpointAt < CHECKPOINT_INTERVAL) {
      return;
    }
    this.checkpointInFlight = true;
    void this.checkpoint(parts)
      .catch((error) => {
        console.error('[Lumo] Failed to checkpoint the reply:', error);
      })
      .finally(() => {
        this.checkpointInFlight = false;
      });
  }

  /** Mark the checkpoint clock so a fold is not immediately followed by a write. */
  markCheckpointed(): void {
    this.lastCheckpointAt = Date.now();
  }

  /** Persist the latest partial turn for a teardown that cannot await. */
  async flush(): Promise<void> {
    if (!hasRenderableParts(this.latestParts)) return;
    try {
      await this.checkpoint(this.latestParts);
    } catch (error) {
      console.error('[Lumo] Failed to persist the interrupted reply:', error);
    }
  }

  /** Open and save a settled turn; the caller owns the state transition. */
  async saveSettled(conversation: Conversation): Promise<void> {
    try {
      await this.ports.save(conversation, { create: this.canCreate });
    } catch (error) {
      this.ports.onSaveError(toError(error));
    }
  }
}
