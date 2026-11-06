import type { UIMessagePart, UIDataTypes, UITools } from 'ai';
import type { LanguagePreference } from '@/i18n/locales';
import type { ReasoningEffort } from '@/lib/reasoning-effort';
import type { TurnNotificationMode } from '@/lib/turn-notification';
import type { BusySendBehavior } from '@/lib/busy-send';

/**
 * Which wire protocol to talk to the provider with.
 *
 * The two OpenAI variants are deliberately separate because `@ai-sdk/openai` v4
 * maps them to different endpoints, and third-party gateways almost never
 * implement both:
 * - `openai-chat` → `POST {baseUrl}/chat/completions` (`openai.chat(id)`).
 *   The portable choice for DeepSeek / Moonshot / SiliconFlow / OneAPI / Ollama…
 * - `openai-responses` → `POST {baseUrl}/responses` (`openai(id)`).
 *   Only official OpenAI (or a gateway that truly proxies Responses) supports it.
 */
export type ProviderType = 'anthropic' | 'openai-chat' | 'openai-responses';

/**
 * Provider types as they may appear in previously persisted configs.
 * `openai-compatible` was ambiguous: it was documented as "any compatible
 * gateway" but `openai(modelId)` resolved to the Responses API, so those
 * configs are migrated to `openai-chat` on read (see `normalizeProviderType`).
 */
export type StoredProviderType = ProviderType | 'openai-compatible';

export interface ModelConfig {
  id: string;
  modelId: string;
  displayName: string;
  isVision: boolean;
  /**
   * Declared context window for this model, in tokens.
   *
   * Providers do not report this over the wire, so it is *configuration*: the
   * user declares it and the composer's context ring divides by it. Optional
   * on purpose — an absent value means "unknown", and the ring is hidden rather
   * than drawn against an invented window. See `lib/context-window.ts`.
   */
  contextWindow?: number;
  /**
   * How hard this model should think before answering.
   *
   * Per-model rather than per-provider because the available levels are a
   * property of the model, not of the endpoint: one API key serves both a
   * reasoning model and one that rejects the setting outright. Absent means
   * `'provider-default'` — the field is omitted from the request — so configs
   * written before this existed keep their exact behaviour. See
   * `lib/reasoning-effort.ts`.
   */
  reasoningEffort?: ReasoningEffort;
}

/**
 * Who is behind the endpoint, as opposed to which wire protocol it speaks.
 *
 * Orthogonal to {@link ProviderType}: OpenCode serves the same three protocols
 * from protocol-specific paths, but additionally requires its own request
 * headers (client identity + session) and exposes its model list at a path that
 * is *not* a sibling of the protocol URL. Modelling that as a vendor keeps the
 * protocol abstraction intact instead of adding a fourth pseudo-protocol that
 * would have to lie about which endpoint it calls.
 */
export type ProviderVendor = 'custom' | 'opencode';

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  /**
   * The endpoint's vendor, defaulting to `'custom'` when absent.
   *
   * Optional so configs persisted before this existed keep working; a missing
   * value *means* `'custom'`, the same shape `type` has for legacy values (see
   * `normalizeProvider`).
   */
  vendor?: ProviderVendor;
  baseUrl?: string;
  apiKey: string;
  models: ModelConfig[];
}

/**
 * Which key combination sends a chat message from the input box.
 * - `'enter'`: Enter (with no modifier) sends; any modifier+Enter (Shift,
 *   Ctrl/Cmd, Alt/Option) inserts a newline.
 * - `'meta-enter'`: any modifier+Enter sends — Ctrl/Alt/Shift on Windows,
 *   ⌘/⌥/⇧ on macOS (the name is a loose shorthand for "a modifier key");
 *   plain Enter inserts a newline.
 */
export type SendKey = 'enter' | 'meta-enter';

/**
 * Allowed font-size presets (in pixels). Applied to `<html>` to scale all
 * `rem`-based UI proportionally.
 */
export type FontSize = 12 | 13 | 14 | 15 | 16 | 17 | 18;

/**
 * A user-selectable colour theme.
 *
 * `'system'` is a *preference*, not a palette — it resolves to one of the
 * concrete themes at apply time based on `prefers-color-scheme`. Every other
 * member maps 1:1 to a token block in `assets/globals.css`.
 *
 * Adding a theme is a two-step change: extend this union, then register it in
 * `THEMES` (see `lib/theme.ts`) — TypeScript will flag every place that needs
 * updating, including the i18n label map.
 */
export type Theme = 'light' | 'dark' | 'midnight' | 'system';

/**
 * The subset of {@link Theme} that names an actual palette. `'system'` is
 * excluded because it always resolves to one of these before being applied.
 */
export type ResolvedTheme = Exclude<Theme, 'system'>;

/**
 * Visibility options for message actions that can target a specific role.
 * - `'all'` — show on both user and assistant messages.
 * - `'assistant'` — show only on assistant messages.
 * - `'user'` — show only on user messages.
 * - `'hidden'` — never show.
 */
export type MessageActionVisibility = 'all' | 'assistant' | 'user' | 'hidden';

/**
 * Simple show/hide toggle for message actions that don't need role filtering.
 */
export type MessageActionToggle = 'show' | 'hidden';

/**
 * Per-action visibility settings for the message toolbar (actions below each message).
 */
export interface MessageToolbarSettings {
  copy: MessageActionVisibility;
  regenerate: MessageActionToggle;
  delete: MessageActionVisibility;
  usage: MessageActionToggle;
}

/**
 * A compaction reserve: either an absolute token count or a percentage of the
 * model's context window. A percentage adapts to every model automatically —
 * `20%` is 25.6K on a 128K window and 32K on a 160K one — which is why it is the
 * default. Absolute values are for pinning a fixed headroom.
 */
export type ReserveAmount =
  | { unit: 'tokens'; value: number }
  | { unit: 'percent'; value: number };

/**
 * Automatic context compaction settings.
 *
 * When the committed context crosses `contextWindow - reserve`, older history
 * is summarized into a single checkpoint so the next request fits.
 * `keepRecentTokens` is the budget of recent history left verbatim. See
 * `lib/compaction.ts`.
 */
export interface CompactionSettings {
  enabled: boolean;
  reserve: ReserveAmount;
  keepRecentTokens: number;
}

/**
 * A durable compaction boundary stored on a conversation.
 *
 * Everything before `firstKeptMessageId` is replaced by `summary` in the model
 * prompt; the original messages stay on disk so the transcript remains readable
 * and can be summarized again later. Mirrors pi's `CompactionEntry` shape.
 */
export interface ConversationCompaction {
  /** Structured checkpoint produced by the summarizer. */
  summary: string;
  /** First stored message kept verbatim — where the prompt projection starts. */
  firstKeptMessageId: string;
  /**
   * Message the transcript seam is rendered *after* — the chronological point
   * at which compaction ran (normally the newest message at that moment).
   *
   * Distinct from `firstKeptMessageId` on purpose: the prompt places the summary
   * before the kept range, but the UI marks where the compaction *happened*, the
   * same way pi appends its compaction message at its chronological position.
   */
  triggeredAtMessageId?: string;
  /** Committed context size before this checkpoint replaced the history. */
  tokensBefore: number;
  /** Committed context size after the checkpoint, when it could be measured. */
  tokensAfter?: number;
  createdAt: number;
  /** Usage of the LLM call that produced the summary. */
  usage?: TokenUsageStats;
}

/**
 * A transient, user-facing notice about a compaction that is not otherwise
 * visible: a manual action that had nothing to do, or an automatic between-step
 * fold that succeeded. Distinct from `ChatError`: nothing failed.
 */
export type CompactionNotice =
  | {
      kind: 'nothing-to-compact';
      /** The recent-token budget the conversation did not exceed. */
      keepRecentTokens: number;
    }
  | {
      /** A between-step compaction actually folded history away. */
      kind: 'compacted';
      tokensBefore: number;
      tokensAfter: number;
    };

export interface UISettings {
  /** `auto` follows the browser UI language; otherwise a shipped BCP-47 tag. */
  language: LanguagePreference;
  theme: Theme;
  /** Global UI font size in pixels. Default is 14. */
  fontSize: FontSize;
  /** Maximum number of side-by-side chat panels (1–3). Default is 1. */
  maxSplitPanels: 1 | 2 | 3;
  /** Which key combination sends a chat message. Default is Enter. */
  sendKey: SendKey;
  /**
   * What a send does while a turn is still streaming: interject at the next tool
   * step, or interrupt the reply and send right away. See `lib/busy-send.ts`.
   */
  busySend: BusySendBehavior;
  /**
   * Character count at which a paste into the composer becomes a text
   * attachment instead of inline text. `0` disables it, `1` attaches every
   * paste. See `lib/paste-threshold.ts`.
   */
  pasteThreshold: number;
  /**
   * Maximum number of tool-loop steps one assistant turn may run. `0` means no
   * cap (the default); a cap is at least 10. See `lib/max-steps.ts`.
   */
  maxSteps: number;
  /**
   * Collapse a reasoning (chain-of-thought) block once it stops streaming,
   * instead of leaving it expanded for the lifetime of the message.
   * Off preserves the historical behaviour: live reasoning stays open after it
   * finishes. See `components/ai-elements/reasoning.tsx`.
   */
  autoCollapseReasoning: boolean;
  /** Per-action visibility for the message toolbar. */
  messageToolbar: MessageToolbarSettings;
  /** Automatic context compaction. See `lib/compaction.ts`. */
  compaction: CompactionSettings;
  /**
   * Whether to show a desktop notification when a reply finishes.
   * Default is `'never'`. See `lib/turn-notification.ts`.
   */
  turnNotification: TurnNotificationMode;
}

// Slash-command settings live in `lib/slash-commands.ts` and are re-exported
// here so storage, the options page and the composer share one import path.
export type {
  BuiltinCommandAction,
  CommandSettings,
  UserCommand,
  ResolvedCommand,
} from '@/lib/slash-commands';

// Mention settings re-exported for the same reason.
export type { MentionSettings } from '@/lib/mention-commands';

// Turn-completion notification mode, shared by storage, options and the stream.
export type { TurnNotificationMode } from '@/lib/turn-notification';

// Busy-send behaviour, shared by storage, options and the streaming hook.
export type { BusySendBehavior } from '@/lib/busy-send';

// OCR settings re-exported so storage, options and the AI layer share one path.
export type { OcrSettings } from '@/lib/ocr-types';
export { DEFAULT_OCR_SETTINGS, DEFAULT_OCR_PROMPT } from '@/lib/ocr-types';

/**
 * A text attachment dragged from external sources (web pages, etc.).
 * Can be plain text, HTML, or a file reference. Sent as a separate text content part.
 */
export interface TextAttachment {
  id: string;
  /**
   * The semantic kind of attachment:
   * - 'text': plain text or HTML content (default if omitted for backwards compat)
   * - 'file-ref': a reference to a file stored in the extension's file system
   * - 'page-context': the identity (tabId/title/url) of the page a quick action
   *   was fired from. See `lib/page-context.ts`.
   */
  kind?: 'text' | 'file-ref' | 'page-context';
  /** The content type: 'text/plain' or 'text/html' */
  mediaType: 'text/plain' | 'text/html';
  /** The actual text/html content, or `[filename: name]` for file-ref kind */
  content: string;
  /**
   * Optional text to send to the model instead of `content`. Lets an
   * attachment keep a clean, human-readable `content` for the UI card while
   * shipping a richer (markers, tool hints) payload to the model at
   * serialisation time. See `lib/attachment-serialization.ts`.
   */
  modelText?: string;
  /** A short preview label (first N chars, or the file name for file-ref) */
  preview: string;
  /** Optional display label override (e.g. "File" for file references) */
  label?: string;
}

/** User-authored system instructions prepended to every conversation. */
export interface SystemPromptSettings {
  /** Whether to send `prompt` at all. */
  enabled: boolean;
  /** Raw system prompt text. Sent verbatim, no templating. */
  prompt: string;
  /** When true, prepend `CurrentTime: <local time>` to the resolved prompt. */
  injectCurrentTime?: boolean;
}

/**
 * A message part, aligned with the AI SDK `UIMessage` part union.
 * Covers text, reasoning, static tool calls (`tool-${name}`) and dynamic tool
 * calls (`dynamic-tool`), so text output and tool invocations can be rendered
 * interleaved in their original order.
 */
export type ChatMessagePart = UIMessagePart<UIDataTypes, UITools>;

/**
 * Token usage statistics for a single assistant turn.
 *
 * Each field aggregates across all agent-loop steps that comprised the turn.
 * `steps` optionally holds per-step breakdowns for the debug view.
 */
export interface TokenUsageStats {
  /** Total input (prompt) tokens sent to the model. */
  inputTokens: number;
  /** Total output (completion) tokens received from the model. */
  outputTokens: number;
  /** Total tokens (input + output). */
  totalTokens: number;
  /** Input tokens served from the provider's prompt cache. */
  cacheReadTokens?: number;
  /** Input tokens written into the provider's prompt cache. */
  cacheWriteTokens?: number;
  /** Output tokens used for reasoning (thinking). */
  reasoningTokens?: number;
  /** Per-step breakdown (one entry per agent-loop iteration). */
  steps?: TokenUsageStep[];
}

/** Token usage for a single agent-loop step. */
export interface TokenUsageStep {
  /** Zero-based step index. */
  step: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /**
   * Ordered message parts. This is the source of truth for rendering.
   *
   * Legacy conversations persisted before parts existed only carry `content` /
   * `images`; use `normalizeMessage()` from `@/lib/message-parts` to read a
   * message so those are lazily upgraded into parts.
   */
  parts?: ChatMessagePart[];
  /** @deprecated Legacy flat text. Kept only so old stored conversations still render. */
  content?: string;
  /** @deprecated Legacy base64 images. Superseded by `file` parts. */
  images?: string[];
  /**
   * Metadata for text/HTML attachments dragged from external sources.
   * Used by the UI to render attachments as distinct cards rather than inline text.
   * The actual content is also stored in `parts` as text parts for sending to the model.
   */
  textAttachments?: TextAttachment[];
  /**
   * Set on an assistant turn that never reached its natural end — the user hit
   * stop, or the panel was torn down (side panel closed, split panel removed)
   * while the reply was still streaming.
   *
   * Such a turn is persisted deliberately, because losing a half-written answer
   * is worse than showing a truncated one. The flag exists so the UI can say so:
   * without it a truncated reply is indistinguishable from a complete one, and
   * the user cannot tell whether the model actually finished its thought.
   */
  interrupted?: boolean;
  /**
   * Why an `interrupted` turn stopped, when it was not the user's doing.
   *
   * Absent means the ordinary case the flag was introduced for: the user hit
   * stop, or the panel was torn down. `'step-limit'` is the one cause the user
   * did not choose per-turn but *did* configure, so it gets its own notice —
   * telling them the reply was cut by their own step cap is actionable, whereas
   * the generic "interrupted" label would send them looking for a failure that
   * never happened. See `lib/max-steps.ts`.
   */
  stopReason?: 'step-limit';
  /**
   * Token usage statistics for this assistant turn. Only present on assistant
   * messages that completed at least one model call.
   */
  usage?: TokenUsageStats;
  timestamp: number;
  /**
   * Alternative generation variants for this assistant message.
   *
   * When the user regenerates a response, the current reply is archived into
   * this array and a fresh request is made. The latest generation is always the
   * message's own `parts`; older attempts live here in chronological order.
   *
   * Only meaningful on the last assistant message in the conversation — switching
   * variants replaces the conversational context for subsequent turns.
   */
  variants?: ChatMessageVariant[];
  /**
   * Which variant is currently active. `undefined` or equal to the total
   * variant count means the latest (current `parts`). A number < variants.length
   * means one of the archived versions is being shown.
   */
  activeVariantIndex?: number;
}

/**
 * A user message composed while a turn was still streaming.
 *
 * It is not part of the conversation yet: it waits in the panel's queue until
 * the agent loop reaches a step boundary (the end of a step's tool calls), at
 * which point it is delivered as an ordinary user message — the transcript
 * records the current assistant segment, then this message, then the
 * continuation. If the turn finishes before a boundary arrives, it is sent as
 * its own turn instead.
 *
 * Kept out of `Conversation` on purpose: a queue belongs to one live turn in
 * one panel, not to the stored history.
 */
export interface QueuedUserInput {
  id: string;
  text: string;
  /** Data URLs, same shape the composer collects. */
  images: string[];
  textAttachments: TextAttachment[];
  /** When the user composed it — the delivered message keeps this timestamp. */
  timestamp: number;
}

/**
 * A single archived generation variant — a snapshot of what an assistant turn
 * produced before the user chose to regenerate.
 */
export interface ChatMessageVariant {
  id: string;
  parts: ChatMessagePart[];
  timestamp: number;
  interrupted?: boolean;
  stopReason?: 'step-limit';
  usage?: TokenUsageStats;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  modelId: string;
  providerId: string;
  createdAt: number;
  updatedAt: number;
  /**
   * The resolved system prompt snapshot for this conversation.
   * Generated once when the conversation starts; reused on subsequent messages
   * so that time-injected prompts stay stable and provider caching works.
   */
  systemPrompt?: string;
  /**
   * Durable compaction checkpoint, once the conversation has been summarized.
   * Absent until the first compaction. See `lib/compaction.ts`.
   */
  compaction?: ConversationCompaction;
}
