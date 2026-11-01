import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isToolUIPart } from 'ai';
import { AnimatePresence, motion } from 'motion/react';
import {
  MessageSquare,
  Bot,
  User,
  Wrench,
  ChevronDown,
  FileText,
  Brain,
  Clock,
  AlertCircle,
  ArrowDown,
  ArrowUp,
  PenLine,
  Sigma,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useStorageWatch } from '@/store/useStorageWatch';
import { normalizeMessage, toolPartName } from '@/lib/message-parts';
import { panelConversationKey } from '@/lib/panel-storage';
import { primarySlot } from '@/lib/panel-order';
import { getConversation } from '@/lib/conversation-store';
import { conversationTitle } from '@/lib/conversation-title';
import { safeStringify } from '@/lib/tool-output';
import { storage } from '@/store/storage';
import type { PanelLayout } from '@/lib/panel-order';
import type { Conversation, ChatMessage, ChatMessagePart, TokenUsageStats } from '@/types';
import { SettingsHeader } from './components/SettingsHeader';
import type { ToolPart } from '@/lib/message-parts';

/**
 * Debug entry representing one logical "card" in the timeline.
 * We flatten a conversation's messages + parts into these entries
 * so tool calls are properly separated from text segments.
 */
interface DebugEntry {
  id: string;
  timestamp: number;
  type: 'system-prompt' | 'user' | 'assistant-text' | 'assistant-reasoning' | 'tool-call';
  /** The raw text content (for text/reasoning/system-prompt) */
  content?: string;
  /** For tool-call entries */
  toolPart?: ToolPart;
  /** For file parts */
  fileUrl?: string;
  fileMediaType?: string;
  /** Token usage for this assistant turn (only on the first text entry of a turn). */
  usage?: TokenUsageStats;
}

/**
 * Flatten a conversation into a linear timeline of debug entries.
 * Text chunks between tool calls are merged into single entries,
 * but tool calls always create their own entry.
 */
function buildTimeline(conversation: Conversation): DebugEntry[] {
  const entries: DebugEntry[] = [];

  // System prompt entry
  if (conversation.systemPrompt) {
    entries.push({
      id: `${conversation.id}-system`,
      timestamp: conversation.createdAt,
      type: 'system-prompt',
      content: conversation.systemPrompt,
    });
  }

  for (const message of conversation.messages) {
    const parts = normalizeMessage(message);

    if (message.role === 'user') {
      // Merge all user text parts into one entry
      const textParts = parts.filter(
        (p): p is Extract<ChatMessagePart, { type: 'text' }> => p.type === 'text',
      );
      const fileParts = parts.filter(
        (p): p is Extract<ChatMessagePart, { type: 'file' }> => p.type === 'file',
      );

      const content = textParts.map((p) => p.text).join('');
      entries.push({
        id: message.id,
        timestamp: message.timestamp,
        type: 'user',
        content: content || (fileParts.length > 0 ? `[${fileParts.length} file(s)]` : ''),
        fileUrl: fileParts[0]?.url,
        fileMediaType: fileParts[0]?.mediaType,
      });
    } else {
      // Assistant: split by tool calls
      let pendingText = '';
      let pendingReasoning = '';
      let textIdx = 0;
      let reasoningIdx = 0;
      // Attach usage to the first text entry of this assistant turn.
      let usageAttached = false;

      const flushText = () => {
        if (pendingText) {
          const entry: DebugEntry = {
            id: `${message.id}-text-${textIdx}`,
            timestamp: message.timestamp,
            type: 'assistant-text',
            content: pendingText,
          };
          if (!usageAttached && message.usage) {
            entry.usage = message.usage;
            usageAttached = true;
          }
          entries.push(entry);
          pendingText = '';
          textIdx++;
        }
      };

      const flushReasoning = () => {
        if (pendingReasoning) {
          entries.push({
            id: `${message.id}-reasoning-${reasoningIdx}`,
            timestamp: message.timestamp,
            type: 'assistant-reasoning',
            content: pendingReasoning,
          });
          pendingReasoning = '';
          reasoningIdx++;
        }
      };

      for (const part of parts) {
        if (part.type === 'text') {
          flushReasoning();
          pendingText += part.text;
        } else if (part.type === 'reasoning') {
          flushText();
          pendingReasoning += part.text;
        } else if (isToolUIPart(part)) {
          flushText();
          flushReasoning();
          entries.push({
            id: `${message.id}-tool-${(part as ToolPart).toolCallId}`,
            timestamp: message.timestamp,
            type: 'tool-call',
            toolPart: part as ToolPart,
          });
        }
        // skip step-start and file parts on assistant side for now
      }

      flushText();
      flushReasoning();
    }
  }

  return entries;
}

export function ChatDebugPage() {
  const { t } = useTranslation();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * Active side panel window IDs, discovered via `chrome.runtime.getContexts`.
   * Empty means no side panel is open (or we couldn't query).
   */
  const [activeWindows, setActiveWindows] = useState<number[]>([]);
  /**
   * The window we are currently inspecting. Defaults to the window this options
   * page lives in (if it has a side panel), otherwise the first active one.
   */
  const [targetWindowId, setTargetWindowId] = useState<number | null>(null);
  /**
   * Whether the async discovery of side panel windows has finished. Until it
   * has, `targetWindowId` is still `null` from its initial value rather than
   * from a definite "no side panel open" answer, so fallback paths that read
   * from local storage must wait — otherwise they run against empty local keys
   * (conversation pointers live in session storage since window isolation).
   */
  const [windowResolved, setWindowResolved] = useState(false);
  /**
   * The panels on screen in the side panel, left to right.
   */
  const [visibleOrder, setVisibleOrder] = useState<number[]>([]);
  const [trackedSlot, setTrackedSlot] = useState<number | null>(null);

  const selectedPanel =
    trackedSlot !== null && visibleOrder.includes(trackedSlot)
      ? trackedSlot
      : primarySlot(visibleOrder);

  const applyLayout = useCallback((order: number[]) => {
    setVisibleOrder(order);
    setTrackedSlot((prev) =>
      prev !== null && order.includes(prev) ? prev : primarySlot(order) ?? null,
    );
  }, []);

  // Discover active side panel windows and select the default target
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const runtime = chrome.runtime;
        let sidePanelWindowIds: number[] = [];

        // Primary: ask the browser which side panels are alive.
        if (runtime?.getContexts) {
          const contexts = await runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
          sidePanelWindowIds = [
            ...new Set(
              contexts
                .map((ctx) => ctx.windowId)
                .filter((id): id is number => id != null && id >= 0),
            ),
          ];
        }

        // Fallback: `getContexts` may return [] in some Chrome builds or
        // during dev mode. Scan session storage for window-scoped layout
        // keys (`w<id>_splitViewVisible`) — if a side panel wrote one, its
        // window is (or recently was) active.
        if (sidePanelWindowIds.length === 0) {
          try {
            const allSession = await chrome.storage.session.get(null);
            const windowIds = new Set<number>();
            for (const key of Object.keys(allSession)) {
              const m = /^w(\d+)_/.exec(key);
              if (m) windowIds.add(Number(m[1]));
            }
            sidePanelWindowIds = [...windowIds];
          } catch { /* session scan failed; proceed with empty list */ }
        }

        if (cancelled) return;
        setActiveWindows(sidePanelWindowIds);

        // Determine which window to inspect by default
        const currentWindow = await chrome.windows.getCurrent();
        const myWindowId = currentWindow.id;
        if (cancelled) return;

        if (myWindowId != null && sidePanelWindowIds.includes(myWindowId)) {
          setTargetWindowId(myWindowId);
        } else if (sidePanelWindowIds.length > 0) {
          setTargetWindowId(sidePanelWindowIds[0]!);
        } else {
          // No side panels open — fall back to local storage (legacy behavior)
          setTargetWindowId(null);
        }
      } catch {
        // getContexts not available or failed — fall back
        setTargetWindowId(null);
      } finally {
        if (!cancelled) setWindowResolved(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Refresh active windows when side panel opens/closes
  useEffect(() => {
    const refresh = async () => {
      try {
        const runtime = chrome.runtime;
        let ids: number[] = [];

        if (runtime?.getContexts) {
          const contexts = await runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
          ids = [
            ...new Set(
              contexts
                .map((ctx) => ctx.windowId)
                .filter((id): id is number => id != null && id >= 0),
            ),
          ];
        }

        // Same session-scan fallback as the initial discovery.
        if (ids.length === 0) {
          try {
            const allSession = await chrome.storage.session.get(null);
            const windowIds = new Set<number>();
            for (const key of Object.keys(allSession)) {
              const m = /^w(\d+)_/.exec(key);
              if (m) windowIds.add(Number(m[1]));
            }
            ids = [...windowIds];
          } catch { /* ignore */ }
        }

        setActiveWindows(ids);
        setTargetWindowId((prev) => {
          if (prev != null && ids.includes(prev)) return prev;
          return ids.length > 0 ? ids[0]! : null;
        });
      } catch { /* ignore */ }
    };

    // Listen for any storage changes that might indicate panel state change
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName !== 'session') return;
      // If any window-scoped visible layout key changed, refresh
      const hasLayoutChange = Object.keys(changes).some((k) =>
        /^w\d+_splitViewVisible$/.test(k),
      );
      if (hasLayoutChange) void refresh();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  // Load visible layout for the target window
  useEffect(() => {
    if (targetWindowId == null) {
      // Fallback: read from local storage (legacy / no active panel)
      void storage.getSplitViewVisible().then((layout) => {
        applyLayout(layout.order);
      });
      return;
    }
    const key = `w${targetWindowId}_splitViewVisible`;
    void chrome.storage.session.get(key).then((result) => {
      const layout = result[key] as PanelLayout | undefined;
      if (layout?.order) {
        applyLayout(layout.order);
      } else {
        // Fallback to local
        void storage.getSplitViewVisible().then((l) => applyLayout(l.order));
      }
    }).catch(() => {
      void storage.getSplitViewVisible().then((l) => applyLayout(l.order));
    });
  }, [windowResolved, targetWindowId, applyLayout]);

  // Watch for layout changes from the target window
  useEffect(() => {
    if (targetWindowId == null) return;
    const key = `w${targetWindowId}_splitViewVisible`;
    const listener = (
      changes: { [k: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName !== 'session') return;
      if (!(key in changes)) return;
      const newLayout = changes[key]?.newValue as PanelLayout | undefined;
      if (newLayout?.order && newLayout.order.length > 0) {
        applyLayout(newLayout.order);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [targetWindowId, applyLayout]);

  // Also keep the legacy local watcher for backward compat
  useStorageWatch<PanelLayout>(
    'splitViewVisible',
    useCallback((newValue) => {
      // Only use local watcher when no target window (fallback mode)
      if (!windowResolved || targetWindowId != null) return;
      const order = newValue?.order;
      if (!order || order.length === 0) return;
      applyLayout(order);
    }, [applyLayout, windowResolved, targetWindowId]),
  );

  /**
   * Resolve the conversation the selected panel currently has open.
   * Reads from session storage (window-scoped) first, falls back to local.
   */
  const loadPanelConversation = useCallback(async (panelId: number) => {
    let currentId: string | null | undefined = null;

    if (targetWindowId != null) {
      // Read from session storage for the target window
      const sessionKey = `w${targetWindowId}_${panelConversationKey(panelId)}`;
      const sessionResult = await chrome.storage.session.get(sessionKey);
      currentId = sessionResult[sessionKey] as string | null | undefined;
    }

    // Fallback to local storage
    if (!currentId) {
      const convKey = panelConversationKey(panelId);
      const result = await chrome.storage.local.get(convKey);
      currentId = result[convKey] as string | null | undefined;
    }

    if (!currentId) return null;
    return getConversation(currentId);
  }, [targetWindowId]);

  // Load conversation when selected panel changes
  useEffect(() => {
    // The layout has not arrived yet; stay on the loading state rather than
    // querying a slot that may not exist.
    if (selectedPanel === undefined) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const loaded = await loadPanelConversation(selectedPanel);
        if (cancelled) return;
        setConversation(loaded);
      } catch (error) {
        if (cancelled) return;
        console.error('[Lumo] Failed to load conversation for debug view:', error);
        setConversation(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedPanel, loadPanelConversation]);

  // Live updates while streaming. Conversations live in IndexedDB, which has no
  // change event, so this watches the revision counter and re-reads.
  useStorageWatch<number>(
    'conversationsRevision',
    useCallback(() => {
      if (selectedPanel === undefined) return;
      void loadPanelConversation(selectedPanel)
        .then(setConversation)
        .catch(() => { /* transient read failure; the next bump retries */ });
    }, [selectedPanel, loadPanelConversation]),
  );

  // Watch for the selected panel's currentConversationId changes
  useEffect(() => {
    if (selectedPanel === undefined) return;
    // Listen on both session (window-scoped) and local (legacy) for changes
    const sessionKey = targetWindowId != null
      ? `w${targetWindowId}_${panelConversationKey(selectedPanel)}`
      : null;
    const localKey = panelConversationKey(selectedPanel);

    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      // Check session storage for window-scoped key
      if (areaName === 'session' && sessionKey && sessionKey in changes) {
        const newId = changes[sessionKey]?.newValue as string | null | undefined;
        if (!newId) {
          setConversation(null);
          return;
        }
        void getConversation(newId)
          .then(setConversation)
          .catch(() => {});
        return;
      }
      // Fallback: check local storage
      if (areaName === 'local' && localKey in changes) {
        const newId = changes[localKey]?.newValue as string | null | undefined;
        if (!newId) {
          setConversation(null);
          return;
        }
        void getConversation(newId)
          .then(setConversation)
          .catch(() => {});
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [selectedPanel, targetWindowId]);

  /**
   * Names a panel by where it sits, not by which storage slot it uses.
   *
   * Position and slot are independent now that panels can be reordered, so the
   * label has to come from the order — deriving it from the slot id would tell
   * the user "right panel" while they are looking at it on the left.
   */
  const getPanelSideLabel = (slot: number): string => {
    const position = visibleOrder.indexOf(slot);
    const count = visibleOrder.length;
    if (position < 0 || count <= 1) return t('options.chatDebug.panelRight');
    if (position === count - 1) return t('options.chatDebug.panelRight');
    if (position === 0) return t('options.chatDebug.panelLeft');
    return t('options.chatDebug.panelMiddle');
  };

  const timeline = useMemo(
    () => (conversation ? buildTimeline(conversation) : []),
    [conversation],
  );

  /** Aggregate token usage across all assistant messages in the conversation. */
  const conversationUsage = useMemo<TokenUsageStats | null>(() => {
    if (!conversation) return null;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let reasoning = 0;
    let hasAny = false;
    for (const msg of conversation.messages) {
      if (msg.role === 'assistant' && msg.usage) {
        hasAny = true;
        input += msg.usage.inputTokens;
        output += msg.usage.outputTokens;
        cacheRead += msg.usage.cacheReadTokens ?? 0;
        cacheWrite += msg.usage.cacheWriteTokens ?? 0;
        reasoning += msg.usage.reasoningTokens ?? 0;
      }
    }
    if (!hasAny) return null;
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
      ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
      ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    };
  }, [conversation]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-pulse text-muted-foreground">{t('common.loading')}</div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <SettingsHeader
        title={t('options.chatDebug.title')}
        description={t('options.chatDebug.description')}
        className="mb-0"
      />

      {/* Window switcher (only show when multiple windows have side panels) */}
      {activeWindows.length > 1 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-muted-foreground shrink-0">{t('options.chatDebug.windowSelect')}</span>
          <div className="flex gap-1">
            {activeWindows.map((wId, index) => (
              <Button
                key={wId}
                variant={targetWindowId === wId ? 'default' : 'outline'}
                size="sm"
                className="h-7 text-xs px-3"
                onClick={() => setTargetWindowId(wId)}
              >
                {t('options.chatDebug.windowLabel', { index: index + 1 })}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Panel switcher (only show when multiple panels visible) */}
      {visibleOrder.length > 1 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-muted-foreground shrink-0">{t('options.chatDebug.panelSelect')}</span>
          <div className="flex gap-1">
            {/*
              Rendered in `visibleOrder`, which is already left to right, so the
              buttons sit in the same arrangement as the panels they select.
              Reversing this to put the primary panel first inverts the control
              relative to the sidebar: the button labelled "left panel" ends up on
              the right, which is actively misleading now that panels can be
              reordered and the labels are the only cue.
            */}
            {visibleOrder.map((slot) => (
              <Button
                key={slot}
                variant={selectedPanel === slot ? 'default' : 'outline'}
                size="sm"
                className="h-7 text-xs px-3"
                onClick={() => setTrackedSlot(slot)}
              >
                {getPanelSideLabel(slot)}
              </Button>
            ))}
          </div>
        </div>
      )}

      {!conversation ? (
        <EmptyState />
      ) : (
        <>
          {/* Conversation meta */}
          <div className="rounded-lg border border-border bg-card p-3 space-y-1">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              <span className="truncate">{conversationTitle(conversation.title, t)}</span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{conversation.providerId} / {conversation.modelId}</span>
              <span>{new Date(conversation.createdAt).toLocaleString()}</span>
              <span>{conversation.messages.length} messages</span>
            </div>
            <p className="text-xs text-muted-foreground/70">{t('options.chatDebug.refreshHint')}</p>
          </div>

          {/* Token Usage Summary */}
          {conversationUsage && (
            <TokenUsageBadge
              usage={conversationUsage}
              label={t('options.chatDebug.conversationTotal')}
            />
          )}

          {/* Timeline */}
          <div className="space-y-2">
            {timeline.map((entry) => (
              <DebugCard key={entry.id} entry={entry} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-64 text-center space-y-3">
      <MessageSquare className="h-10 w-10 text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground max-w-xs">
        {t('options.chatDebug.noConversation')}
      </p>
    </div>
  );
}

// ─── Debug Card ─────────────────────────────────────────────────────────────────

const ENTRY_STYLES: Record<DebugEntry['type'], { icon: React.ElementType; label: string; borderClass: string }> = {
  'system-prompt': { icon: FileText, label: 'options.chatDebug.systemPrompt', borderClass: 'border-s-purple-500' },
  'user': { icon: User, label: 'options.chatDebug.userMessage', borderClass: 'border-s-blue-500' },
  'assistant-text': { icon: Bot, label: 'options.chatDebug.assistantMessage', borderClass: 'border-s-green-500' },
  'assistant-reasoning': { icon: Brain, label: 'options.chatDebug.reasoningPart', borderClass: 'border-s-amber-500' },
  'tool-call': { icon: Wrench, label: 'options.chatDebug.toolCall', borderClass: 'border-s-orange-500' },
};

function DebugCard({ entry }: { entry: DebugEntry }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const style = ENTRY_STYLES[entry.type];
  const Icon = style.icon;

  const isToolCall = entry.type === 'tool-call' && entry.toolPart;

  // Determine preview content (3-5 lines)
  const previewContent = useMemo(() => {
    if (isToolCall && entry.toolPart) {
      return `${toolPartName(entry.toolPart)} → ${entry.toolPart.state}`;
    }
    return entry.content ?? '';
  }, [entry, isToolCall]);

  const needsExpand = useMemo(() => {
    if (isToolCall) return true; // Tool calls always have more detail
    const lineCount = (previewContent.match(/\n/g) || []).length + 1;
    return lineCount > 4 || previewContent.length > 300;
  }, [previewContent, isToolCall]);

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card overflow-hidden border-s-4 transition-colors',
        style.borderClass,
      )}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-start hover:bg-muted/50 transition-colors"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground truncate">
          {t(style.label)}
          {isToolCall && entry.toolPart && (
            <span className="ms-1 font-mono text-muted-foreground">
              {toolPartName(entry.toolPart)}
            </span>
          )}
        </span>
        <span className="ms-auto flex items-center gap-1.5 shrink-0">
          <Clock className="h-3 w-3 text-muted-foreground/60" />
          <span className="text-[0.625rem] text-muted-foreground/70 tabular-nums">
            {formatTime(entry.timestamp)}
          </span>
          {needsExpand && (
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 text-muted-foreground transition-transform',
                expanded && 'rotate-180',
              )}
            />
          )}
        </span>
      </button>

      {/* Content */}
      <div className="px-3 pb-2">
        {isToolCall && entry.toolPart ? (
          <ToolCallContent part={entry.toolPart} expanded={expanded} />
        ) : (
          <TextContent content={previewContent} expanded={expanded} needsExpand={needsExpand} />
        )}
        {entry.usage && (
          <div className="mt-2">
            <TokenUsageBadge usage={entry.usage} />
          </div>
        )}
      </div>
    </div>
  );
}

function TextContent({
  content,
  expanded,
  needsExpand,
}: {
  content: string;
  expanded: boolean;
  needsExpand: boolean;
}) {
  if (!content) return null;

  return (
    <div className="relative">
      <pre
        className={cn(
          'text-xs font-mono whitespace-pre-wrap break-all text-foreground/80 leading-relaxed',
          !expanded && needsExpand && 'line-clamp-4',
        )}
      >
        {content}
      </pre>
      {!expanded && needsExpand && (
        <div className="absolute bottom-0 inset-x-0 h-6 bg-gradient-to-t from-card to-transparent pointer-events-none" />
      )}
    </div>
  );
}

function ToolCallContent({ part, expanded }: { part: ToolPart; expanded: boolean }) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      {/* Compact preview when collapsed */}
      {!expanded && (
        <div className="text-xs text-muted-foreground font-mono truncate">
          {part.state === 'output-error'
            ? `Error: ${part.errorText ?? t('options.chatDebug.noContent')}`
            : summarizeInput(part.input)}
        </div>
      )}

      {/* Expanded details */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden space-y-2"
          >
            {/* Input */}
            <div className="space-y-1">
              <div className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground/70">
                {t('options.chatDebug.input')}
              </div>
              <pre className="max-h-60 overflow-auto scrollbar-lumo rounded-md bg-background border border-border/60 p-2 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed">
                {part.input != null ? safeStringify(part.input) : t('options.chatDebug.noContent')}
              </pre>
            </div>

            {/* Output */}
            {(part.state === 'output-available' || part.state === 'output-error') && (
              <div className="space-y-1">
                <div className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground/70">
                  {t('options.chatDebug.output')}
                </div>
                {part.state === 'output-error' ? (
                  <div className="flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span className="break-words min-w-0">{part.errorText ?? t('options.chatDebug.noContent')}</span>
                  </div>
                ) : (
                  <pre className="max-h-60 overflow-auto scrollbar-lumo rounded-md bg-background border border-border/60 p-2 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed">
                    {part.output != null ? safeStringify(part.output) : t('options.chatDebug.noContent')}
                  </pre>
                )}
              </div>
            )}

            {/* State badge */}
            <div className="flex items-center gap-1.5">
              <span className="text-[0.625rem] text-muted-foreground/70">State:</span>
              <span className={cn(
                'text-[0.625rem] font-mono px-1.5 py-0.5 rounded',
                part.state === 'output-available' && 'bg-green-500/10 text-green-600 dark:text-green-400',
                part.state === 'output-error' && 'bg-destructive/10 text-destructive',
                part.state === 'input-available' && 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
                part.state === 'input-streaming' && 'bg-muted text-muted-foreground',
              )}>
                {part.state}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Token Usage Badge ──────────────────────────────────────────────────────

function TokenUsageBadge({ usage, label }: { usage: TokenUsageStats; label?: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasSteps = usage.steps && usage.steps.length > 1;

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 space-y-1">
      {/* Header row */}
      <button
        className="w-full flex items-center gap-2 text-start"
        onClick={() => hasSteps && setExpanded(!expanded)}
        disabled={!hasSteps}
      >
        {label && (
          <span className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground/70">
            {label}
          </span>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[0.625rem] font-mono tabular-nums text-muted-foreground">
          <span>
            <span className="text-muted-foreground/60">{t('options.chatDebug.inputTokens')}:</span>{' '}
            <span className="text-foreground/80">{usage.inputTokens.toLocaleString()}</span>
          </span>
          <span>
            <span className="text-muted-foreground/60">{t('options.chatDebug.outputTokens')}:</span>{' '}
            <span className="text-foreground/80">{usage.outputTokens.toLocaleString()}</span>
          </span>
          {(usage.cacheReadTokens ?? 0) > 0 && (
            <span>
              <span className="text-muted-foreground/60">{t('options.chatDebug.cacheRead')}:</span>{' '}
              <span className="text-green-600 dark:text-green-400">{usage.cacheReadTokens!.toLocaleString()}</span>
            </span>
          )}
          {(usage.cacheWriteTokens ?? 0) > 0 && (
            <span>
              <span className="text-muted-foreground/60">{t('options.chatDebug.cacheWrite')}:</span>{' '}
              <span className="text-amber-600 dark:text-amber-400">{usage.cacheWriteTokens!.toLocaleString()}</span>
            </span>
          )}
          {(usage.reasoningTokens ?? 0) > 0 && (
            <span>
              <span className="text-muted-foreground/60">{t('options.chatDebug.reasoningTokens')}:</span>{' '}
              <span className="text-purple-600 dark:text-purple-400">{usage.reasoningTokens!.toLocaleString()}</span>
            </span>
          )}
          <span>
            <span className="text-muted-foreground/60">{t('options.chatDebug.totalTokens')}:</span>{' '}
            <span className="text-foreground/80 font-medium">{usage.totalTokens.toLocaleString()}</span>
          </span>
        </div>
        {hasSteps && (
          <ChevronDown
            className={cn(
              'ms-auto h-3 w-3 text-muted-foreground/60 transition-transform shrink-0',
              expanded && 'rotate-180',
            )}
          />
        )}
      </button>

      {/* Per-step breakdown */}
      <AnimatePresence>
        {expanded && hasSteps && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="pt-1 space-y-0.5 border-t border-border/40">
              {usage.steps!.map((step) => (
                <div
                  key={step.step}
                  className="flex flex-wrap gap-x-3 gap-y-0.5 text-[0.6rem] font-mono tabular-nums text-muted-foreground/80"
                >
                  <span className="text-muted-foreground/50 w-12 shrink-0">
                    {t('options.chatDebug.stepLabel', { step: step.step + 1 })}
                  </span>
                  <StepMetric
                    icon={<ArrowUp className="size-2.5" aria-hidden="true" />}
                    label={t('options.chatDebug.inputTokens')}
                    value={step.inputTokens}
                  />
                  <StepMetric
                    icon={<ArrowDown className="size-2.5" aria-hidden="true" />}
                    label={t('options.chatDebug.outputTokens')}
                    value={step.outputTokens}
                  />
                  {(step.cacheReadTokens ?? 0) > 0 && (
                    <StepMetric
                      icon={<Zap className="size-2.5" aria-hidden="true" />}
                      label={t('options.chatDebug.cacheRead')}
                      value={step.cacheReadTokens!}
                      className="text-green-600 dark:text-green-400"
                    />
                  )}
                  {(step.cacheWriteTokens ?? 0) > 0 && (
                    <StepMetric
                      icon={<PenLine className="size-2.5" aria-hidden="true" />}
                      label={t('options.chatDebug.cacheWrite')}
                      value={step.cacheWriteTokens!}
                      className="text-amber-600 dark:text-amber-400"
                    />
                  )}
                  {(step.reasoningTokens ?? 0) > 0 && (
                    <StepMetric
                      icon={<Brain className="size-2.5" aria-hidden="true" />}
                      label={t('options.chatDebug.reasoningTokens')}
                      value={step.reasoningTokens!}
                      className="text-purple-600 dark:text-purple-400"
                    />
                  )}
                  <StepMetric
                    icon={<Sigma className="size-2.5" aria-hidden="true" />}
                    label={t('options.chatDebug.totalTokens')}
                    value={step.totalTokens}
                  />
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * One per-step metric in the token badge ledger.
 *
 * Glyphs are Lucide icons rather than `↑ ↓ ⚡ ✎ 🧠 Σ`: the text arrows depend on
 * whatever font fallback the platform picks and ⚡/🧠 render as colour emoji on
 * most systems, so the same row came out in five different weights and styles.
 * The metric name travels in `title` so the icon is not the only carrier of
 * meaning.
 */
function StepMetric({
  icon,
  label,
  value,
  className,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  className?: string;
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap"
      title={label}
    >
      <span className="shrink-0 text-muted-foreground/50">{icon}</span>
      <span className={className}>{value.toLocaleString()}</span>
    </span>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function summarizeInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input !== 'object') return String(input);
  const entries = Object.entries(input as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  if (entries.length === 0) return '{}';
  return entries
    .slice(0, 3)
    .map(([key, value]) => {
      const rendered =
        typeof value === 'string'
          ? value.length > 30 ? `"${value.slice(0, 30)}…"` : `"${value}"`
          : Array.isArray(value)
            ? `[${value.length}]`
            : typeof value === 'object'
              ? '{…}'
              : String(value);
      return `${key}: ${rendered}`;
    })
    .join(', ');
}
