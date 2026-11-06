import { useState, useReducer, useRef, useCallback, useMemo, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { generateCompactionSummary } from '@/lib/ai';
import type { ResumeState } from '@/lib/ai';
import { deriveConversationTitle } from '@/lib/conversation-title';
import { buildUserMessage } from '@/lib/user-message';
import type { AssistantTurn } from '@/lib/conversation-turn';
import type { LiveUsage } from '@/lib/context-usage';
import { classifyError, toError, type ChatErrorInfo } from '@/lib/provider-error';
import { compactTurn } from '@/lib/turn-compaction';
import { storage } from '@/store/storage';
import { useConversations } from '@/store/useConversations';
import {
  initialStreamState,
  selectStreamingMessage,
  streamReducer,
} from '@/store/stream-machine';
import { TurnRunner, type TurnRunnerInput } from '@/store/turn/runner';
import { useCompactionNotice } from '@/store/useCompactionNotice';
import { useStorageWatch } from '@/store/useStorageWatch';
import {
  DEFAULT_BUSY_SEND,
  normalizeBusySend,
  type BusySendBehavior,
} from '@/lib/busy-send';
import type { ConversationMeta } from '@/lib/conversation-store';
import type {
  ChatMessage,
  ChatMessageVariant,
  CompactionNotice,
  Conversation,
  ModelConfig,
  ProviderConfig,
  QueuedUserInput,
  TextAttachment,
} from '@/types';

export interface UseChatStreamReturn {
  /**
   * History list entries. Summaries rather than full conversations — the list
   * never needs message bodies. See `useConversations`.
   */
  conversations: ConversationMeta[];
  currentConversation: Conversation | null;
  isHistoryOpen: boolean;
  setIsHistoryOpen: (open: boolean) => void;
  isStreaming: boolean;
  /**
   * True while a summarization call is folding old history into a checkpoint.
   * Distinct from `isStreaming`: no assistant tokens are being produced.
   */
  isCompacting: boolean;
  /** Transient explanation for a manual action that was a no-op, if any. */
  compactionNotice: CompactionNotice | null;
  /**
   * The in-flight assistant turn, shaped as a real `ChatMessage` so the list can
   * render it through the same component and React key as the persisted one.
   * `null` until the turn has produced something worth showing.
   */
  streamingMessage: ChatMessage | null;
  chatError: ChatErrorInfo | null;
  isRetrying: boolean;
  retryAttempt: number;
  /**
   * Latest completed step of the in-flight turn. The ring anchors on it so the
   * context gauge is a measurement during a tool loop, not a guess from the
   * first token to the last.
   */
  liveUsage: LiveUsage | null;
  /**
   * Messages composed while a turn was streaming, waiting to be delivered.
   *
   * They are not in the conversation yet: the agent loop takes them at its next
   * step boundary, and anything left when the turn ends is sent as its own turn.
   */
  queuedInputs: QueuedUserInput[];
  handleSend: (input: string, images: string[], textAttachments: TextAttachment[], getProvider: () => ProviderConfig | undefined, getModel: () => ModelConfig | undefined, selectedProviderId: string, selectedModelId: string) => Promise<void>;
  handleRetry: (getProvider: () => ProviderConfig | undefined, getModel: () => ModelConfig | undefined) => void;
  /** Manually fold older history into a checkpoint. Backs the `/compact` command. */
  handleCompact: (getProvider: () => ProviderConfig | undefined, getModel: () => ModelConfig | undefined) => void;
  /**
   * Stops the turn and returns whatever was still queued, so the composer can
   * put it back: the user wrote those messages.
   */
  handleStop: () => QueuedUserInput[];
  /** Starts a blank chat, returning what was still queued for this one. */
  handleNewChat: () => QueuedUserInput[];
  /** Opens another conversation, returning what was still queued for this one. */
  handleSelectConversation: (id: string) => Promise<QueuedUserInput[]>;
  /** Withdraws one queued message (the composer puts it back in the draft). */
  handleDequeue: (id: string) => QueuedUserInput | null;
  handleDeleteConversation: (id: string) => Promise<void>;
  handleDeleteMessage: (messageId: string) => Promise<void>;
  handleRegenerateMessage: (messageId: string, getProvider: () => ProviderConfig | undefined, getModel: () => ModelConfig | undefined) => void;
  handleSwitchVariant: (variantIndex: number) => Promise<void>;
  handleClearAllConversations: () => Promise<void>;
}

export interface UseChatStreamOptions {
  /** Panel identifier for independent conversation state. Default 0. */
  panelId?: number;
  /** Session IDs occupied by other panels (for conflict detection on restore) */
  occupiedSessionIds?: string[];
}

/**
 * Chat composition root.
 *
 * This hook is deliberately thin: it owns conversation selection, the streaming
 * reducer, and the lifecycle of the active {@link TurnRunner}. Everything that
 * happens *inside* one assistant turn — prompt preparation, retries, overflow
 * recovery, compaction, checkpointing — lives in the runner, which has no React
 * dependency and is unit-testable on its own.
 */
export function useChatStream(options?: UseChatStreamOptions): UseChatStreamReturn {
  const {
    conversations,
    current: currentConversation,
    save: saveConversation,
    saveDraft: saveConversationDraft,
    open: openConversation,
    openById: openConversationById,
    remove: removeConversation,
    clearAll: clearAllConversations,
  } = useConversations({
    panelId: options?.panelId ?? 0,
    occupiedSessionIds: options?.occupiedSessionIds,
  });

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  // One state machine for the streaming turn: eight independent `useState`
  // values used to be updated in loose groups at a dozen sites, and disagreeing
  // members produced a spinner with no turn, or an error with no attempt count.
  const [stream, dispatch] = useReducer(streamReducer, initialStreamState);
  const {
    isStreaming,
    isCompacting,
    isRetrying,
    retryAttempt,
    turn: streamingTurn,
    parts: streamingParts,
    liveUsage,
    error: chatError,
  } = stream;

  const {
    notice: compactionNotice,
    show: showCompactionNotice,
    clear: clearCompactionNotice,
  } = useCompactionNotice();

  /** The runner that currently owns the UI, if any. */
  const activeRunnerRef = useRef<TurnRunner | null>(null);
  /** Resume snapshot for a manual retry; mirrors the runner's last checkpoint. */
  const resumeStateRef = useRef<ResumeState | null>(null);
  /** Turn identity across manual retries. */
  const turnRef = useRef<AssistantTurn | null>(null);
  /**
   * Set when the user stops *before* a runner exists.
   *
   * `handleSend` enters the streaming phase first and only then persists the user
   * turn, so the composer offers Stop while there is nothing to abort yet. Without
   * this flag that click would reset the UI and the send would still go on to
   * start a request nobody can see or cancel.
   */
  const stopRequestedRef = useRef(false);
  /** Manual `/compact` request, cancelled with the conversation change. */
  const compactionAbortRef = useRef<AbortController | null>(null);

  /**
   * Messages the user composed while a turn was streaming, in order.
   *
   * Kept in a ref as well as state because the runner reads it from inside the
   * agent loop (through `pullQueuedInputs`) and the send loop drains it after a
   * turn settles — neither can wait for a render. The state copy is only for the
   * composer's queue strip.
   */
  const queuedRef = useRef<QueuedUserInput[]>([]);
  const [queuedInputs, setQueuedInputs] = useState<QueuedUserInput[]>([]);

  /**
   * Model selection a queued delivery runs with.
   *
   * Remembered on every send instead of captured by the drain: a delivery can
   * happen after the turn ends, when the callback that queued it is long gone.
   * The getters are called at delivery time, so a model switch still applies.
   */
  const sendContextRef = useRef<{
    getProvider: () => ProviderConfig | undefined;
    getModel: () => ModelConfig | undefined;
    selectedProviderId: string;
    selectedModelId: string;
  } | null>(null);

  // Mirrors for the decisions that happen outside a render: a send that arrives
  // mid-stream must queue even if the callback that accepted it was built before
  // the stream started.
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  const isCompactingRef = useRef(isCompacting);
  isCompactingRef.current = isCompacting;

  /**
   * What a send does while a turn is streaming. Held in a ref rather than state:
   * the decision is taken inside `handleSend`, and a change made in the options
   * page must apply to the very next send without re-rendering the panel.
   */
  const busySendRef = useRef<BusySendBehavior>(DEFAULT_BUSY_SEND);
  useEffect(() => {
    let cancelled = false;
    void storage
      .getUISettings()
      .then((settings) => {
        if (!cancelled) busySendRef.current = normalizeBusySend(settings.busySend);
      })
      .catch(() => {
        // An unreadable settings blob leaves the shipped default in place.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useStorageWatch<{ busySend?: BusySendBehavior }>(
    'uiSettings',
    useCallback((next) => {
      if (next) busySendRef.current = normalizeBusySend(next.busySend);
    }, []),
  );

  /** Replace the queue and mirror it into state in one go. */
  const syncQueue = useCallback((next: QueuedUserInput[]) => {
    queuedRef.current = next;
    setQueuedInputs(next);
  }, []);

  /**
   * Take everything queued. Called by the turn at a step boundary; the loop
   * delivers all of it at once, because they were composed against the same
   * step and splitting them would make the model answer half an instruction.
   */
  const pullQueuedInputs = useCallback((): QueuedUserInput[] => {
    const items = queuedRef.current;
    if (items.length > 0) syncQueue([]);
    return items;
  }, [syncQueue]);

  /** Take the next queued message, for delivery as its own turn. */
  const shiftQueued = useCallback((): QueuedUserInput | null => {
    const [head, ...rest] = queuedRef.current;
    if (!head) return null;
    syncQueue(rest);
    return head;
  }, [syncQueue]);

  /** Withdraw one entry (the composer returns it to the draft). */
  const handleDequeue = useCallback((id: string): QueuedUserInput | null => {
    const item = queuedRef.current.find((entry) => entry.id === id) ?? null;
    if (item) syncQueue(queuedRef.current.filter((entry) => entry.id !== id));
    return item;
  }, [syncQueue]);

  /**
   * Drop the queue and hand it back, so the caller can put the text back in the
   * composer. Used when a turn is abandoned: the user wrote those messages.
   */
  const takeQueued = useCallback((): QueuedUserInput[] => {
    const items = queuedRef.current;
    if (items.length > 0) syncQueue([]);
    return items;
  }, [syncQueue]);

  /**
   * Start one assistant turn. The runner replaces any previous one; a new turn
   * cannot begin while `isStreaming`, so this is only a safety net.
   */
  const startTurn = useCallback(
    async (input: TurnRunnerInput) => {
      // A stop during the pre-flight save must not resurrect the turn.
      if (stopRequestedRef.current) return;
      activeRunnerRef.current?.abort();
      const runner = new TurnRunner(input, {
        dispatch,
        save: saveConversation,
        saveDraft: saveConversationDraft,
        open: openConversation,
        showCompactionNotice,
        setResume: (resume) => {
          resumeStateRef.current = resume;
        },
        setTurn: (turn) => {
          turnRef.current = turn;
        },
        pullQueuedInputs,
      });
      activeRunnerRef.current = runner;
      await runner.run();
    },
    [
      saveConversation,
      saveConversationDraft,
      openConversation,
      showCompactionNotice,
      pullQueuedInputs,
    ],
  );

  /** Durability-only flush of the active turn (teardown paths). */
  const flushActiveTurn = useCallback(() => {
    void activeRunnerRef.current?.flush();
  }, []);

  // Cancels the in-flight request and invalidates its pending callbacks.
  const abortActiveStream = useCallback(() => {
    const runner = activeRunnerRef.current;
    if (runner) {
      // Flush before aborting: a teardown/switch should not depend on the
      // stream's abort path getting a chance to settle, and the turn must not
      // dispatch into the conversation that is taking over.
      void runner.flush();
      runner.abort();
    }
    activeRunnerRef.current = null;
    resumeStateRef.current = null;
    turnRef.current = null;
    compactionAbortRef.current?.abort();
    compactionAbortRef.current = null;
    stopRequestedRef.current = false;
    // The queue belonged to the turn being abandoned. Callers that want to hand
    // it back to the composer drain it *before* getting here.
    takeQueued();
    dispatch({ type: 'reset' });
  }, [takeQueued]);

  /**
   * Last-chance persistence when the panel goes away mid-stream.
   *
   * Two triggers, because neither alone is enough:
   * - `visibilitychange` fires while the document is still alive, which is the
   *   only point at which an async IndexedDB write can still be relied on to
   *   commit. Closing the side panel hides it first, so this is the trigger that
   *   actually saves the reply.
   * - unmount covers teardown that never hides the document: a split panel being
   *   closed or collapsed by a width change.
   *
   * `pagehide`/`beforeunload` are deliberately not used: by then only synchronous
   * work is guaranteed to run, and IndexedDB is asynchronous.
   */
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flushActiveTurn();
    };
    document.addEventListener('visibilitychange', onHidden);

    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      flushActiveTurn();
      // Stop the request and any pending retry: nothing is left to render into,
      // and a retry firing after unmount would spend a model call for nobody.
      activeRunnerRef.current?.abort();
      compactionAbortRef.current?.abort();
    };
  }, [flushActiveTurn]);

  /**
   * Leaves the current conversation: any in-flight stream is abandoned and the
   * composer is reset before `target` (or a blank chat) takes over.
   *
   * An abandoned queue is *not* returned from here: `abortActiveStream` owns the
   * teardown, and a caller that wants the messages back drains the queue before
   * getting here (see `handleNewChat` and `handleSelectConversation`).
   */
  const switchConversation = useCallback(
    async (target: Conversation | null) => {
      abortActiveStream();
      await openConversation(target);
    },
    [abortActiveStream, openConversation],
  );

  const handleNewChat = useCallback((): QueuedUserInput[] => {
    // The queue is returned synchronously — the messages never reached the
    // model, and dropping them with the conversation would lose the user's work.
    const abandoned = takeQueued();
    void switchConversation(null).catch((error) => {
      console.error('[Lumo] Failed to start a new chat:', error);
    });
    return abandoned;
  }, [switchConversation, takeQueued]);

  const handleSelectConversation = useCallback(
    async (id: string): Promise<QueuedUserInput[]> => {
      setIsHistoryOpen(false);
      if (id === currentConversation?.id) return [];
      const abandoned = takeQueued();
      abortActiveStream();
      await openConversationById(id);
      return abandoned;
    },
    [currentConversation?.id, abortActiveStream, openConversationById, takeQueued],
  );

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      if (await removeConversation(id)) {
        abortActiveStream();
      }
    },
    [removeConversation, abortActiveStream],
  );

  const handleClearAllConversations = useCallback(async () => {
    abortActiveStream();
    await clearAllConversations();
  }, [abortActiveStream, clearAllConversations]);

  /**
   * Run one user message through the turn lifecycle: append it to the
   * conversation, persist it, and await the turn's settlement.
   *
   * Resolves once the turn is over (or immediately when it could not start).
   * Whatever was queued behind it is delivered by the drain effect, not here —
   * that path also covers a queue left over from a compaction, which this
   * callback never sees.
   */
  const sendTurn = useCallback(
    async (
      content: QueuedUserInput,
      base: Conversation | null,
      provider: ProviderConfig,
      model: ModelConfig,
      selectedProviderId: string,
      selectedModelId: string,
    ): Promise<void> => {
      const userMessage = buildUserMessage(content);

      let conv = base;
      if (!conv) {
        conv = {
          id: uuidv4(),
          title: deriveConversationTitle(content.text),
          messages: [],
          modelId: selectedModelId,
          providerId: selectedProviderId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }

      conv = {
        ...conv,
        messages: [...conv.messages, userMessage],
        updatedAt: Date.now(),
      };

      dispatch({ type: 'turn/start' });
      stopRequestedRef.current = false;
      clearCompactionNotice();
      // A new turn invalidates any snapshot left by the previous one.
      resumeStateRef.current = null;
      turnRef.current = null;

      const convWithUserMessage = conv;

      // The pointer write is best-effort and applies its state update
      // synchronously, so the user message renders regardless of whether the
      // write lands.
      void openConversation(convWithUserMessage).catch(() => {
        // Losing the pointer only costs conversation restoration on next open.
      });

      // The user turn is persisted before the request because the runner saves
      // with `insertIfMissing: false` — it must not resurrect a conversation the
      // user deleted mid-stream, which also means it cannot create this one.
      //
      // Crucially this is not allowed to gate the request. It used to be a bare
      // `await`, so a storage failure meant the stream was never reached while
      // `isStreaming` stayed true: the composer sat on "thinking" forever.
      let persistedUserTurn = true;
      try {
        await saveConversation(convWithUserMessage, { create: true });
      } catch (error) {
        persistedUserTurn = false;
        // Reported, but the turn still goes to the model: losing history is far
        // less disruptive than losing the ability to talk to the assistant.
        dispatch({ type: 'error', error: classifyError(toError(error)) });
      }

      try {
        await startTurn({
          conversation: convWithUserMessage,
          provider,
          model,
          resume: null,
          compact: true,
          canCreate: !persistedUserTurn,
        });
      } catch (error) {
        dispatch({
          type: 'turn/crashed',
          error: classifyError(toError(error)),
          clearParts: true,
        });
      }
    },
    [openConversation, saveConversation, startTurn, clearCompactionNotice],
  );

  /**
   * Abandon the running turn and wait until it has been written down.
   *
   * "Written down" is the whole point: the aborted reply is persisted
   * asynchronously, and appending its replacement before that write lands would
   * both order the new message before the reply it interrupted and let the
   * in-flight save drop it. Returns whatever was already queued so the caller can
   * put it back behind the message about to be sent.
   */
  const interruptActiveTurn = useCallback(
    async (): Promise<{ displaced: QueuedUserInput[]; conversation: Conversation | null }> => {
      // Drain before going idle: the drain effect must not deliver an older
      // queued message into the gap between the abort and the replacement.
      const displaced = takeQueued();
      const runner = activeRunnerRef.current;

      // Leave the streaming phase now. The partial reply stays on screen until
      // the saved message replaces it, so nothing flickers away in between.
      dispatch({ type: 'turn/stopped' });
      // Keep a concurrent start from slipping in before the replacement is ready.
      stopRequestedRef.current = true;
      runner?.stop();
      await runner?.whenSettled();
      stopRequestedRef.current = false;
      resumeStateRef.current = null;

      // The aborted turn's write just landed, so the replacement has to build on
      // the runner's version: the conversation this callback closed over predates
      // the reply it interrupted.
      return { displaced, conversation: runner?.conversation ?? null };
    },
    [takeQueued],
  );

  const handleSend = useCallback(
    async (
      input: string,
      images: string[],
      textAttachments: TextAttachment[],
      getProvider: () => ProviderConfig | undefined,
      getModel: () => ModelConfig | undefined,
      selectedProviderId: string,
      selectedModelId: string,
    ) => {
      const text = input.trim();
      if (!text && images.length === 0 && textAttachments.length === 0) return;

      const content: QueuedUserInput = {
        id: uuidv4(),
        text,
        images,
        textAttachments,
        timestamp: Date.now(),
      };

      // A queued message is delivered later, outside this call, so the selection
      // it should use is remembered here rather than captured by the drain.
      sendContextRef.current = {
        getProvider,
        getModel,
        selectedProviderId,
        selectedModelId,
      };

      const provider = getProvider();
      const model = getModel();

      // Mid-turn, the user's preference decides between two very different
      // promises:
      // - `steer` keeps the running reply and slips the message in at the next
      //   step boundary (the runner takes it from the queue);
      // - `interrupt` abandons the reply and sends right away.
      // Nothing is interrupted unless it can actually be replaced, so a missing
      // model selection queues the message instead of aborting the turn.
      let displaced: QueuedUserInput[] = [];
      let conversation = currentConversation;
      if (isStreamingRef.current || isCompactingRef.current) {
        // Only a turn that actually has a runner can be interrupted. In the
        // window between `turn/start` and the runner's creation (the pre-flight
        // save) there is nothing to abort yet, so the message queues instead of
        // racing a second turn into the same conversation.
        const canInterrupt =
          busySendRef.current === 'interrupt' &&
          isStreamingRef.current &&
          activeRunnerRef.current !== null &&
          provider &&
          model;
        if (!canInterrupt) {
          syncQueue([...queuedRef.current, content]);
          return;
        }
        const interrupted = await interruptActiveTurn();
        displaced = interrupted.displaced;
        conversation = interrupted.conversation ?? conversation;
      }

      if (!provider || !model) {
        if (displaced.length > 0) syncQueue([...displaced, ...queuedRef.current]);
        return;
      }

      await sendTurn(
        content,
        conversation,
        provider,
        model,
        selectedProviderId,
        selectedModelId,
      );

      // Messages already waiting keep their place behind this one rather than
      // disappearing with the turn it interrupted.
      if (displaced.length > 0) syncQueue([...displaced, ...queuedRef.current]);
    },
    [currentConversation, sendTurn, syncQueue, interruptActiveTurn],
  );

  /**
   * Deliver the head of the queue as its own turn.
   *
   * Used when a turn ends with messages still queued — they were composed against
   * a step that then turned out to be the last one, or against a compaction that
   * has just finished. Nothing is delivered while a turn is still live: the loop
   * takes the queue itself at its next boundary.
   */
  const deliverQueued = useCallback(() => {
    const context = sendContextRef.current;
    if (!context) return;
    const provider = context.getProvider();
    const model = context.getModel();
    if (!provider || !model) return;
    const next = shiftQueued();
    if (!next) return;
    void sendTurn(
      next,
      currentConversation,
      provider,
      model,
      context.selectedProviderId,
      context.selectedModelId,
    );
  }, [currentConversation, sendTurn, shiftQueued]);

  useEffect(() => {
    if (isStreaming || isCompacting) return;
    if (queuedRef.current.length === 0) return;
    deliverQueued();
  }, [isStreaming, isCompacting, deliverQueued]);

  const handleRetry = useCallback(
    (getProvider: () => ProviderConfig | undefined, getModel: () => ModelConfig | undefined) => {
      if (!currentConversation || isStreaming || isCompacting) return;

      const provider = getProvider();
      const model = getModel();
      if (!provider || !model) return;

      const resume = resumeStateRef.current;
      dispatch({ type: 'turn/resume', resume: Boolean(resume) });
      stopRequestedRef.current = false;
      // Resuming keeps the already-streamed steps on screen; the runner re-seeds
      // them and appends the remaining steps. Only a full restart clears the
      // transcript, and only then is a new identity warranted.
      if (!resume) turnRef.current = null;

      void startTurn({
        conversation: currentConversation,
        provider,
        model,
        resume,
        compact: false,
        canCreate: false,
        turn: resume ? turnRef.current : null,
      }).catch((error) => {
        dispatch({
          type: 'turn/crashed',
          error: classifyError(toError(error)),
          clearParts: false,
        });
      });
    },
    [currentConversation, isStreaming, isCompacting, startTurn],
  );

  /**
   * Manually fold older history into a checkpoint.
   *
   * Backs the `/compact` command. Unlike the automatic path this ignores the
   * live threshold — the user explicitly asked — but it still keeps
   * `keepRecentTokens` verbatim, so it behaves like pi's `/compact`.
   */
  const handleCompact = useCallback(
    (getProvider: () => ProviderConfig | undefined, getModel: () => ModelConfig | undefined) => {
      if (!currentConversation || isStreaming || isCompacting) return;
      const provider = getProvider();
      const model = getModel();
      if (!provider || !model) return;
      const conv = currentConversation;

      dispatch({ type: 'compacting', value: true });
      const controller = new AbortController();
      compactionAbortRef.current = controller;

      void (async () => {
        try {
          // Same cut rule as the automatic path: keep `keepRecentTokens` of
          // recent history verbatim and fold the rest. `/compact` only skips the
          // threshold check.
          const { compaction: compactionSettings } = await storage.getUISettings();
          const compacted = await compactTurn({
            conversation: conv,
            model,
            settings: compactionSettings,
            summarize: (args) => generateCompactionSummary({ provider, model, ...args }),
            signal: controller.signal,
            force: true,
          });
          if (!compacted) {
            // Nothing failed — the conversation simply has not crossed the
            // retained-token budget yet. Explain that instead of vanishing.
            showCompactionNotice({
              kind: 'nothing-to-compact',
              keepRecentTokens: compactionSettings.keepRecentTokens,
            });
            return;
          }

          // The user may have switched conversations while the summary ran.
          // Opening this record then would clobber the conversation they chose.
          if (controller.signal.aborted) return;

          // Open first, save last: the save adopts the renderable record
          // (screenshots replaced by Blob references), so memory matches a reload.
          await openConversation(compacted.conversation);
          await saveConversation(compacted.conversation);
          showCompactionNotice({
            kind: 'compacted',
            tokensBefore: compacted.tokensBefore,
            tokensAfter: compacted.tokensAfter,
          });
        } catch (error) {
          if (!controller.signal.aborted) {
            console.error('[Lumo] Failed to compact conversation context:', error);
          }
        } finally {
          // Only clear the spinner if this is still the compaction that owns it:
          // a switch may have aborted it and started another one.
          if (compactionAbortRef.current === controller) {
            compactionAbortRef.current = null;
            dispatch({ type: 'compacting', value: false });
          }
        }
      })();
    },
    [
      currentConversation,
      isStreaming,
      isCompacting,
      saveConversation,
      openConversation,
      showCompactionNotice,
    ],
  );

  const handleStop = useCallback((): QueuedUserInput[] => {
    // Remember the intent for the window between the first dispatch and the
    // runner's creation, where there is no runner to abort yet.
    stopRequestedRef.current = true;
    // Dispatch before aborting: the abort path may settle the turn synchronously,
    // and `turn/settled` must win over `turn/stopped` regardless of ordering.
    dispatch({ type: 'turn/stopped' });
    // The runner aborts a live request (whose abort path persists) or flushes
    // directly when it is waiting between retries.
    activeRunnerRef.current?.stop();
    // Stopping is an explicit abandon: nothing should resume into the turn.
    resumeStateRef.current = null;
    // Hand back what never reached the model. Whatever the loop already took was
    // written to the transcript, so it is not lost either way.
    return takeQueued();
  }, [takeQueued]);

  /**
   * The in-flight turn as a `ChatMessage`. Memoised on the turn identity + parts
   * so the object identity only changes when the content does, letting the
   * message component's `memo` skip renders driven by unrelated panel state.
   */
  const streamingMessage = useMemo(
    () => selectStreamingMessage(streamingTurn, streamingParts),
    [streamingTurn, streamingParts],
  );

  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      if (!currentConversation || isStreaming) return;
      const idx = currentConversation.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return;
      // Remove this message and everything after it.
      const updatedMessages = currentConversation.messages.slice(0, idx);
      // If all messages are deleted, remove the conversation entirely.
      if (updatedMessages.length === 0) {
        await removeConversation(currentConversation.id);
        return;
      }
      const updated: Conversation = {
        ...currentConversation,
        messages: updatedMessages,
        updatedAt: Date.now(),
      };
      await openConversation(updated);
      await saveConversation(updated);
    },
    [currentConversation, isStreaming, saveConversation, openConversation, removeConversation],
  );

  /**
   * Regenerate from a specific assistant message: removes that message (and
   * everything after it), keeps the preceding user message, and re-sends the
   * request to the model. This is the "Regenerate" affordance — the user is
   * unhappy with this particular response and wants the model to try again.
   */
  const handleRegenerateMessage = useCallback(
    (messageId: string, getProvider: () => ProviderConfig | undefined, getModel: () => ModelConfig | undefined) => {
      if (!currentConversation || isStreaming) return;
      const idx = currentConversation.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return;

      const message = currentConversation.messages[idx]!;
      // Only the last assistant message can be regenerated.
      if (message.role !== 'assistant') return;
      if (idx !== currentConversation.messages.length - 1) return;

      const provider = getProvider();
      const model = getModel();
      if (!provider || !model) return;

      // Archive the current response as a variant.
      const existingVariants: ChatMessageVariant[] = message.variants ?? [];
      const currentVariant: ChatMessageVariant = {
        id: message.id,
        parts: message.parts ?? [],
        timestamp: message.timestamp,
        ...(message.interrupted ? { interrupted: true } : {}),
        ...(message.stopReason ? { stopReason: message.stopReason } : {}),
        ...(message.usage ? { usage: message.usage } : {}),
      };
      const allVariants = [...existingVariants, currentVariant];

      // Remove the assistant message, keep everything before it.
      const updatedMessages = currentConversation.messages.slice(0, idx);
      if (updatedMessages.length === 0) return;

      const conv: Conversation = {
        ...currentConversation,
        messages: updatedMessages,
        updatedAt: Date.now(),
      };

      // Reset streaming state and fire the request.
      dispatch({ type: 'turn/start' });
      stopRequestedRef.current = false;
      resumeStateRef.current = null;
      turnRef.current = null;

      // Show the trimmed conversation immediately.
      void openConversation(conv).catch(() => {});

      // Persist the trimmed conversation, then execute the stream.
      void saveConversation(conv)
        .then(() =>
          startTurn({
            conversation: conv,
            provider,
            model,
            resume: null,
            compact: true,
            canCreate: false,
            variants: allVariants,
          }),
        )
        .catch((error) => {
          dispatch({
            type: 'turn/crashed',
            error: classifyError(toError(error)),
            clearParts: true,
          });
        });
    },
    [currentConversation, isStreaming, saveConversation, openConversation, startTurn],
  );

  /**
   * Switch the displayed variant on the last assistant message.
   *
   * `variantIndex` is the index into the combined slots [variants..., current],
   * where the last slot (index === variants.length) represents the latest
   * generation (the message's own `parts`). Only changes `activeVariantIndex`;
   * the actual parts/variants arrays are never mutated here.
   */
  const handleSwitchVariant = useCallback(
    async (variantIndex: number) => {
      if (!currentConversation || isStreaming) return;
      const messages = currentConversation.messages;
      if (messages.length === 0) return;

      const lastIdx = messages.length - 1;
      const lastMsg = messages[lastIdx]!;
      if (lastMsg.role !== 'assistant') return;

      const variants = lastMsg.variants ?? [];
      const totalSlots = variants.length + 1;
      if (variantIndex < 0 || variantIndex >= totalSlots) return;

      // If already showing this slot, no-op.
      const currentActive = lastMsg.activeVariantIndex ?? variants.length;
      if (variantIndex === currentActive) return;

      const isLatestSlot = variantIndex === variants.length;
      const updatedMsg: ChatMessage = {
        ...lastMsg,
        activeVariantIndex: isLatestSlot ? undefined : variantIndex,
      };

      const updatedMessages = [...messages.slice(0, lastIdx), updatedMsg];
      const updated: Conversation = {
        ...currentConversation,
        messages: updatedMessages,
        updatedAt: Date.now(),
      };

      await openConversation(updated);
      await saveConversation(updated);
    },
    [currentConversation, isStreaming, saveConversation, openConversation],
  );

  return {
    conversations,
    currentConversation,
    isHistoryOpen,
    setIsHistoryOpen,
    isStreaming,
    isCompacting,
    compactionNotice,
    streamingMessage,
    chatError,
    isRetrying,
    retryAttempt,
    liveUsage,
    queuedInputs,
    handleSend,
    handleRetry,
    handleCompact,
    handleStop,
    handleDequeue,
    handleNewChat,
    handleSelectConversation,
    handleDeleteConversation,
    handleDeleteMessage,
    handleRegenerateMessage,
    handleSwitchVariant,
    handleClearAllConversations,
  };
}
