/**
 * One assistant turn, from prompt preparation to settlement.
 *
 * This is the orchestrator that used to live inside `useChatStream`. It owns no
 * React state: the hook passes a `dispatch` port plus the conversation
 * persistence ports, and the runner emits `StreamAction`s. That boundary makes
 * the whole streaming lifecycle — retries, overflow recovery, pre-send and
 * between-step compaction, checkpointing — testable without a hook, and leaves
 * the hook as a thin adapter over conversations and the reducer.
 *
 * Collaborators:
 * - {@link TurnSession}    abort controller, staleness, retry timer
 * - {@link TurnPersistence} snapshots, checkpoints, final save
 * - `lib/turn-compaction`  the actual fold (shared with manual `/compact`)
 * - `lib/stream-failure`   retry / overflow / fail policy
 */

import { v4 as uuidv4 } from 'uuid';
import {
  chatStream,
  generateCompactionSummary,
  resumeFingerprint,
  type ResumeState,
  type StepCompactionResult,
} from '@/lib/ai';
import {
  projectConversation,
  resolveReserveTokens,
  type CompactionEvent,
} from '@/lib/compaction';
import type { AssistantTurn } from '@/lib/conversation-turn';
import type { LiveUsage } from '@/lib/context-usage';
import { isOcrAvailable } from '@/lib/image-projection';
import { toUIMessages } from '@/lib/message-parts';
import { buildUserMessage } from '@/lib/user-message';
import { classifyError, toError } from '@/lib/provider-error';
import { MAX_RETRIES, retryDelay } from '@/lib/retry-policy';
import { decideStreamFailure } from '@/lib/stream-failure';
import { resolveSystemPrompt } from '@/lib/system-prompt';
import { appendSkillsIndex } from '@/lib/skills';
import { compactTurn, type SummarizeMessages } from '@/lib/turn-compaction';
import { notifyTurnComplete } from '@/lib/turn-notifier';
import { TurnPersistence } from '@/store/turn/persistence';
import { TurnSession } from '@/store/turn/session';
import type { StreamAction } from '@/store/stream-machine';
import { storage } from '@/store/storage';
import type {
  ChatMessagePart,
  ChatMessageVariant,
  CompactionNotice,
  CompactionSettings,
  Conversation,
  ModelConfig,
  ProviderConfig,
  QueuedUserInput,
  TokenUsageStats,
  TurnNotificationMode,
} from '@/types';

export interface TurnRunnerInput {
  conversation: Conversation;
  provider: ProviderConfig;
  model: ModelConfig;
  /** Replay the last completed step instead of the whole turn. */
  resume?: ResumeState | null;
  /** Allow the pre-send durable compaction (false on retries). */
  compact: boolean;
  /** Insert the conversation if the initial user-turn save failed. */
  canCreate: boolean;
  /** Reuse the turn identity across a manual retry. */
  turn?: AssistantTurn | null;
  /** Regeneration variants to attach to the finished turn. */
  variants?: ChatMessageVariant[];
}

export interface TurnRunnerPorts {
  dispatch: (action: StreamAction) => void;
  save: (conversation: Conversation, options?: { create?: boolean }) => Promise<void>;
  saveDraft: (conversation: Conversation) => Promise<void>;
  open: (conversation: Conversation) => Promise<void>;
  showCompactionNotice: (notice: CompactionNotice) => void;
  /** Persist the resume snapshot for a manual retry. */
  setResume: (resume: ResumeState | null) => void;
  /** Mirror the turn identity for the next manual retry. */
  setTurn: (turn: AssistantTurn | null) => void;
  /**
   * Take the messages the user composed while this turn was streaming.
   *
   * The queue itself lives with the composer (it is per-panel UI state, and the
   * user can withdraw an entry). The runner only ever consumes from it, at a
   * step boundary, through this port.
   */
  pullQueuedInputs: () => QueuedUserInput[];
}

export class TurnRunner {
  private readonly session = new TurnSession();
  private readonly persistence: TurnPersistence;
  private readonly summarize: SummarizeMessages;

  private system: string | undefined;
  private maxSteps = 0;
  private compactionSettings!: CompactionSettings;
  private turnNotification!: TurnNotificationMode;
  private ocrAvailable = false;
  private fingerprint = '';
  private resume: ResumeState | null = null;
  private overflowAttempted = false;
  /** Set once the turn has settled or failed; teardown flushes become no-ops. */
  private settled = false;
  /**
   * Waiters for the turn's terminal write.
   *
   * A caller that interrupts a turn in order to send something else has to know
   * when the aborted reply is *stored*, not merely aborted: appending the new
   * message before that write lands would order it before the reply it
   * interrupted, and the in-flight save would then drop it.
   */
  private settledWaiters: Array<() => void> = [];
  private settledNotified = false;

  constructor(
    private readonly input: TurnRunnerInput,
    private readonly ports: TurnRunnerPorts,
  ) {
    const turn = input.turn ?? { id: uuidv4(), timestamp: Date.now() };
    this.ports.setTurn(turn);
    this.persistence = new TurnPersistence({
      conversation: input.conversation,
      turn,
      ...(input.variants ? { variants: input.variants } : {}),
      canCreate: input.canCreate,
      ports: {
        save: (conversation, options) => ports.save(conversation, options),
        saveDraft: (conversation) => ports.saveDraft(conversation),
        open: (conversation) => ports.open(conversation),
        onSaveError: (error) => {
          if (this.session.isCurrent()) {
            this.ports.dispatch({ type: 'error', error: classifyError(error) });
          }
        },
      },
    });
    this.summarize = (args) =>
      generateCompactionSummary({ provider: input.provider, model: input.model, ...args });
  }

  /** Execute the turn (including internal retries) until it settles. */
  async run(): Promise<void> {
    try {
      await this.prepare();
      this.ports.dispatch({ type: 'turn/begin', turn: this.persistence.turn });
      await this.execute(0, this.input.resume ?? null, this.input.compact);
    } catch (error) {
      this.failFatally(error);
    }
  }

  /**
   * The user pressed Stop. A live request is aborted and its terminal callback
   * persists/settles; a turn waiting between retries has nothing to settle, so
   * it flushes and drops ownership immediately.
   */
  stop(): void {
    if (this.session.hasPendingRequest()) {
      this.session.abort();
      return;
    }
    this.session.invalidate();
    this.settled = true;
    // Bypass `flush()`'s settled guard: this is the one write the turn still
    // owes, and future teardown flushes must not repeat it.
    void this.persistence.flush().finally(() => this.notifySettled());
  }

  /** Hard drop for conversation switches and teardown: no settlement callbacks. */
  abort(): void {
    this.session.dispose();
    // Nothing will be written, but a waiter must not hang on a teardown.
    this.notifySettled();
  }

  /**
   * Resolves once the turn is fully written down (or abandoned).
   *
   * Resolves immediately when the turn already ended, so a caller that
   * interrupts can await this unconditionally.
   */
  whenSettled(): Promise<void> {
    if (this.settledNotified) return Promise.resolve();
    return new Promise((resolve) => this.settledWaiters.push(resolve));
  }

  /**
   * The conversation including everything this turn wrote.
   *
   * Read after {@link whenSettled} by a caller that interrupted the turn in
   * order to send something else: it must build on the settled version, not on
   * the one it closed over, or the interrupted reply is never recorded.
   */
  get conversation(): Conversation {
    return this.persistence.conversation;
  }

  private notifySettled(): void {
    if (this.settledNotified) return;
    this.settledNotified = true;
    for (const resolve of this.settledWaiters.splice(0)) resolve();
  }

  /** Durability-only flush for teardown paths that cannot await. */
  async flush(): Promise<void> {
    if (this.settled) return;
    await this.persistence.flush();
  }

  private async prepare(): Promise<void> {
    const conversation = this.input.conversation;
    const base =
      conversation.systemPrompt !== undefined
        ? conversation.systemPrompt
        : resolveSystemPrompt(await storage.getSystemPrompt());
    if (conversation.systemPrompt !== undefined) {
      this.persistence.adopt(conversation);
    } else {
      this.persistence.adopt({ ...conversation, systemPrompt: base ?? undefined });
    }
    // The skills index is rebuilt for every turn instead of being snapshotted
    // with the user's prompt. The snapshot exists so a resumed run replays what
    // was sent; the index is not part of the message history, and installing or
    // deleting a skill has to take effect on the next message — not on the next
    // conversation. See `lib/skills/index.ts`.
    this.system = await appendSkillsIndex(base);

    // Read per turn so a cap or budget changed in the options page applies to
    // the next message instead of the next reload.
    const settings = await storage.getUISettings();
    this.maxSteps = settings.maxSteps;
    this.compactionSettings = settings.compaction;
    this.turnNotification = settings.turnNotification;
    this.ocrAvailable = await isOcrAvailable();
  }

  private async execute(
    attempt: number,
    resume: ResumeState | null,
    compact: boolean,
  ): Promise<void> {
    if (!this.session.isCurrent()) return;
    if (compact && !resume && this.compactionSettings.enabled) {
      await this.compactBeforeSend();
    }
    if (!this.session.isCurrent()) return;

    const conversation = this.persistence.conversation;
    const uiMessages = toUIMessages(projectConversation(conversation));
    this.fingerprint = this.fingerprintOf(conversation);
    const resumeFrom = resume && resume.fingerprint === this.fingerprint ? resume : null;
    this.resume = resumeFrom;
    this.ports.setResume(this.resume);

    try {
      await chatStream({
        provider: this.input.provider,
        model: this.input.model,
        messages: uiMessages,
        system: this.system,
        signal: this.session.signal,
        conversationId: conversation.id,
        isVision: this.input.model.isVision,
        maxSteps: this.maxSteps,
        resume: resumeFrom ?? undefined,
        compaction: {
          enabled: this.compactionSettings.enabled,
          reserveTokens: resolveReserveTokens(
            this.compactionSettings.reserve,
            this.input.model.contextWindow ?? 0,
          ),
          keepRecentTokens: this.compactionSettings.keepRecentTokens,
          ...(conversation.compaction
            ? {
                priorSummary: conversation.compaction.summary,
                summaryMessageCount: 1,
              }
            : {}),
        },
        onCompactBeforeStep: () => this.compactBetweenSteps(),
        onUsage: (usage, coveredPartCount) => {
          if (!this.session.isCurrent()) return;
          const liveUsage: LiveUsage = { usage, coveredPartCount };
          this.ports.dispatch({ type: 'usage', liveUsage });
        },
        onCompaction: (event) => this.handleCompactionEvent(event),
        // Mid-turn delivery: the user's message is folded into the prompt at the
        // step boundary the loop is about to continue past, and the segment it
        // supersedes is written to the transcript before the next request.
        pullQueuedInput: () =>
          this.session.hasPendingRequest() ? this.ports.pullQueuedInputs() : [],
        onInputInjected: (input) => this.steerSegment(input),
        onStepComplete: (checkpoint) => {
          if (!this.session.isCurrent()) return;
          this.resume = { ...checkpoint, fingerprint: this.fingerprint };
          this.ports.setResume(this.resume);
          void this.persistence.checkpoint(checkpoint.parts).catch((error) => {
            console.error('[Lumo] Failed to checkpoint the reply:', error);
          });
        },
        onUpdate: (parts) => {
          this.persistence.setParts(parts);
          if (!this.session.isCurrent()) return;
          this.ports.dispatch({ type: 'parts', parts });
          this.persistence.checkpointThrottled(parts);
        },
        onFinish: (parts, reason, usage) => {
          void this.persist(parts, reason, usage);
        },
        onError: (error) => this.handleError(error, attempt),
      });
    } catch (error) {
      // `chatStream` reports provider failures through `onError`; reaching here
      // means something outside the stream broke (settings, system prompt).
      this.failFatally(error);
    }
  }

  /**
   * Deliver one queued user message: close the streamed segment, record the
   * message, and continue the turn under a new identity.
   *
   * Called from inside the agent loop, so it must not throw: failing to store
   * the boundary costs a checkpoint, not the answer.
   */
  private async steerSegment(input: QueuedUserInput): Promise<void> {
    const userMessage = buildUserMessage(input);
    const closed = this.persistence.closeSegment(this.persistence.latestParts, userMessage);
    try {
      // The closed segment and the user message land in one write: a teardown
      // between them would otherwise restore a transcript where the message
      // appears out of nowhere.
      await this.ports.saveDraft(closed);
    } catch (error) {
      console.error('[Lumo] Failed to store the steered segment:', error);
    }
    if (!this.session.isCurrent()) return;

    // The conversation just grew, so a checkpoint taken before the delivery can
    // no longer replay it — its prompt has no user message in it.
    this.fingerprint = this.fingerprintOf(closed);
    this.resume = null;
    this.ports.setResume(null);

    const next: AssistantTurn = { id: uuidv4(), timestamp: Date.now() };
    this.persistence.setTurn(next);
    this.ports.setTurn(next);
    this.ports.dispatch({ type: 'turn/steer', turn: next });
    void this.ports.open(closed).catch(() => {
      // Pointer persistence is best-effort; the id is unchanged anyway.
    });
  }

  private async compactBeforeSend(): Promise<void> {
    this.ports.dispatch({ type: 'compacting', value: true });
    try {
      const compacted = await compactTurn({
        conversation: this.persistence.conversation,
        model: this.input.model,
        settings: this.compactionSettings,
        summarize: this.summarize,
        signal: this.session.signal,
      });
      if (compacted) {
        this.persistence.adopt(compacted.conversation);
        await this.ports.save(compacted.conversation);
      }
    } catch (error) {
      if (!this.session.signal.aborted) {
        console.error('[Lumo] Failed to compact conversation context:', error);
      }
    } finally {
      if (this.session.isCurrent()) {
        this.ports.dispatch({ type: 'compacting', value: false });
      }
    }
  }

  /**
   * Durable between-step fold. The store owns the transcript, so it returns the
   * projection the loop should use next; the loop keeps the live tail itself.
   */
  private async compactBetweenSteps(): Promise<StepCompactionResult | null> {
    if (!this.session.isCurrent() || this.session.signal.aborted) return null;
    this.ports.dispatch({ type: 'compacting', value: true });
    try {
      const compacted = await compactTurn({
        conversation: this.persistence.conversation,
        model: this.input.model,
        settings: this.compactionSettings,
        summarize: this.summarize,
        signal: this.session.signal,
        force: true,
      });
      if (!compacted) return null;
      if (!this.session.isCurrent()) return null;

      // Write the checkpoint and the partial turn together: a teardown between
      // this fold and the next checkpoint must lose neither.
      const snapshot = this.persistence.snapshot(
        this.persistence.latestParts,
        { interrupted: true },
        compacted.conversation,
      );
      await this.ports.saveDraft(snapshot ?? compacted.conversation);
      if (!this.session.isCurrent()) return null;

      this.persistence.adopt(compacted.conversation);
      this.resume = null;
      this.ports.setResume(null);
      this.fingerprint = this.fingerprintOf(compacted.conversation);
      this.persistence.markCheckpointed();
      // Keep the open conversation on the same checkpoint: a manual retry after
      // this turn must resume from the compacted prompt, not the old one.
      void this.ports.open(compacted.conversation).catch(() => {
        // Pointer persistence is best-effort; the id is unchanged.
      });
      this.ports.showCompactionNotice({
        kind: 'compacted',
        tokensBefore: compacted.tokensBefore,
        tokensAfter: compacted.tokensAfter,
      });
      return {
        uiMessages: toUIMessages(projectConversation(compacted.conversation)),
        ...(compacted.conversation.compaction
          ? { priorSummary: compacted.conversation.compaction.summary }
          : {}),
      };
    } catch (error) {
      console.error('[Lumo] Failed to compact context between steps:', error);
      return null;
    } finally {
      if (this.session.isCurrent()) {
        this.ports.dispatch({ type: 'compacting', value: false });
      }
    }
  }

  private async persist(
    parts: ChatMessagePart[],
    stoppedReason: string,
    usage?: TokenUsageStats,
  ): Promise<void> {
    // From here on the turn is settling: a teardown must not overwrite the
    // final/interrupted record with a duplicate draft.
    this.settled = true;
    const hitStepLimit = stoppedReason === 'step-limit';
    const updated = this.persistence.snapshot(parts, {
      interrupted: this.session.signal.aborted || hitStepLimit,
      ...(hitStepLimit ? { stopReason: 'step-limit' as const } : {}),
      ...(usage ? { usage } : {}),
    });

    if (!updated) {
      if (this.session.isCurrent()) {
        this.ports.setTurn(null);
        this.ports.dispatch({ type: 'turn/settled' });
      }
      this.session.invalidate();
      this.notifySettled();
      return;
    }

    // Write before leaving the streaming phase. A message queued behind this
    // turn is delivered as soon as the UI reports idle, and it saves the
    // conversation this turn produces — a write still in flight at that point
    // would land last and drop the new message.
    await this.persistence.saveSettled(updated);
    // Adopt the settled record so callers reading `conversation` see the
    // message that was just written.
    this.persistence.adopt(updated);

    if (!this.session.isCurrent()) {
      this.session.invalidate();
      return;
    }

    if (!hitStepLimit) {
      this.resume = null;
      this.ports.setResume(null);
    }
    this.ports.setTurn(null);
    void this.ports.open(updated).catch(() => {
      // Pointer persistence is best-effort; the id is unchanged anyway.
    });
    this.ports.dispatch({ type: 'turn/settled' });

    if (!this.session.signal.aborted) {
      void notifyTurnComplete(this.turnNotification, {
        title: this.persistence.conversation.title,
        elapsedMs: Date.now() - this.persistence.turn.timestamp,
      });
    }

    this.session.invalidate();
    this.notifySettled();
  }

  private handleCompactionEvent(event: CompactionEvent): void {
    if (!this.session.isCurrent()) return;
    if (event.phase === 'start') {
      this.ports.dispatch({ type: 'compacting', value: true });
      return;
    }
    this.ports.dispatch({ type: 'compacting', value: false });
    if (event.phase === 'end') {
      this.ports.showCompactionNotice({
        kind: 'compacted',
        tokensBefore: event.tokensBefore,
        tokensAfter: event.tokensAfter,
      });
    }
  }

  private handleError(error: unknown, attempt: number): void {
    // A user Stop aborts the request; a provider error racing that abort must
    // not start a retry against a turn the user already abandoned.
    if (!this.session.isCurrent() || this.session.signal.aborted) return;

    const normalized = toError(error);
    const errorInfo = classifyError(normalized);
    const action = decideStreamFailure({
      error: normalized,
      category: errorInfo.category,
      attempt,
      maxRetries: MAX_RETRIES,
      producedParts: this.persistence.latestParts.length > 0,
      compactionEnabled: this.compactionSettings.enabled,
      overflowRecoveryAttempted: this.overflowAttempted,
    });

    if (action.kind === 'recover-overflow') {
      this.overflowAttempted = true;
      this.ports.dispatch({ type: 'overflow/recovering' });
      void this.recoverOverflow(errorInfo, attempt);
      return;
    }

    if (action.kind === 'retry') {
      this.ports.dispatch({
        type: 'retrying',
        error: errorInfo,
        attempt: action.nextAttempt,
        parts: this.persistence.latestParts,
      });
      const resume = this.resume;
      this.session.schedule(() => {
        void this.execute(action.nextAttempt, resume, false);
      }, retryDelay(attempt));
      return;
    }

    this.ports.dispatch({
      type: 'failed',
      error: errorInfo,
      attempt: action.nextAttempt > MAX_RETRIES ? MAX_RETRIES : action.nextAttempt,
      parts: this.persistence.latestParts,
    });
    void this.persistence.checkpoint(this.persistence.latestParts).catch((error) => {
      console.error('[Lumo] Failed to persist the failed reply:', error);
    });
    this.settled = true;
    void notifyTurnComplete(this.turnNotification, {
      title: this.persistence.conversation.title,
      failed: true,
      elapsedMs: Date.now() - this.persistence.turn.timestamp,
    });
    this.session.invalidate();
    this.notifySettled();
  }

  /**
   * Fold once and retry the turn against the compacted prompt. A retry against
   * the same oversized prompt can only fail again, so this happens once per turn.
   */
  private async recoverOverflow(
    errorInfo: ReturnType<typeof classifyError>,
    attempt: number,
  ): Promise<void> {
    try {
      const compacted = await compactTurn({
        conversation: this.persistence.conversation,
        model: this.input.model,
        settings: this.compactionSettings,
        summarize: this.summarize,
        signal: this.session.signal,
        force: true,
      });
      if (!compacted) throw new Error('Nothing could be compacted');
      this.persistence.adopt(compacted.conversation);
      await this.ports.save(compacted.conversation);
      if (!this.session.isCurrent() || this.session.signal.aborted) return;

      this.resume = null;
      this.ports.setResume(null);
      this.ports.showCompactionNotice({
        kind: 'compacted',
        tokensBefore: compacted.tokensBefore,
        tokensAfter: compacted.tokensAfter,
      });
      this.ports.dispatch({ type: 'overflow/recovered' });
      await this.execute(attempt, null, false);
    } catch (error) {
      if (!this.session.isCurrent() || this.session.signal.aborted) return;
      console.error('[Lumo] Context-overflow recovery failed:', error);
      this.ports.dispatch({ type: 'overflow/failed', error: errorInfo });
      this.session.invalidate();
    }
  }

  private failFatally(error: unknown): void {
    if (!this.session.isCurrent() || this.session.signal.aborted) return;
    this.ports.setTurn(null);
    this.ports.dispatch({
      type: 'turn/crashed',
      error: classifyError(toError(error)),
      clearParts: false,
    });
    this.session.invalidate();
    this.notifySettled();
  }

  private fingerprintOf(conversation: Conversation): string {
    return resumeFingerprint({
      conversationId: conversation.id,
      provider: this.input.provider,
      model: this.input.model,
      messageCount: conversation.messages.length,
      ocrAvailable: this.ocrAvailable,
      ...(conversation.compaction
        ? {
            compaction: {
              firstKeptMessageId: conversation.compaction.firstKeptMessageId,
              createdAt: conversation.compaction.createdAt,
            },
          }
        : {}),
    });
  }
}
