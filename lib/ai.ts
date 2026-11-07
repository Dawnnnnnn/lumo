import {
  streamText,
  generateText,
  readUIMessageStream,
  isStepCount,
  isToolUIPart,
  convertToModelMessages,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ProviderMetadata,
  type ToolSet,
  type UIMessage,
} from 'ai';
import type { ProviderConfig, ModelConfig, ChatMessage, ChatMessagePart, QueuedUserInput, TokenUsageStats, TokenUsageStep } from '@/types';
import { createProvider } from '@/lib/provider-runtime';
import {
  buildSummaryPrompt,
  exceedsBudget,
  serializeConversationForSummary,
} from '@/lib/compaction';
import type { CompactionEvent } from '@/lib/compaction';
import {
  compactifyImageData,
  estimateCharsToTokens,
  measureModelMessagesChars,
} from '@/lib/prompt-size';
import {
  compactWireMessages,
  type WireCompactionConfig,
} from '@/lib/wire-compaction';
import { normalizeProviderType, resolveBaseUrl, resolveProviderSessionId } from '@/lib/provider-type';
import {
  resolveReasoningEffort,
  type UnifiedReasoningEffort,
} from '@/lib/reasoning-effort';
import { toError } from '@/lib/provider-error';
import { repairToolCall } from '@/lib/tool-call-repair';
import { buildUserParts } from '@/lib/user-message';
import { mcpRegistry } from '@/lib/mcp';
import { buildProgrammaticToolSet } from '@/lib/shell/tool';
import { buildConversionToolSet } from '@/lib/tools/catalog';
import { DEFAULT_MAX_STEPS, stepAllowed } from '@/lib/max-steps';
import { projectImagesForNonVision, buildImageFallbackMessage, filterToolsByVision, isOcrAvailable } from '@/lib/image-projection';

/** Placeholder used when image payloads are stripped from the model prompt. */
const IMAGE_OMITTED = '[image data omitted for model context]';


/** Detect whether a tool result output carries image content. */
export function toolResultOutputHasImage(output: { type?: string; value?: unknown }): boolean {
  if (output.type === 'content') {
    return (output.value as Array<{ type?: string; mediaType?: string }>).some(
      (part) => part.type === 'file' && part.mediaType?.startsWith('image'),
    );
  }
  const raw = output.value;
  if (raw == null) return false;
  if (typeof raw === 'string') return raw.includes('data:image/');
  if (typeof raw === 'object') {
    const content = (raw as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content.some((part) => {
        const p = part as { type?: string; data?: unknown; text?: string };
        return (
          p.type === 'image' ||
          (typeof p.text === 'string' && p.text.includes('data:image/'))
        );
      });
    }
    return JSON.stringify(raw).includes('data:image/');
  }
  return false;
}

/**
 * Strip image payloads from a tool result output so the model prompt never
 * carries giant base64 blobs. Text content (e.g. a screenshot caption) is kept.
 */
export function sanitizeToolOutput<T extends { type?: string; value?: unknown }>(output: T): T {
  if (!toolResultOutputHasImage(output)) return output;

  if (output.type === 'content') {
    const textParts = (output.value as Array<{ type?: string; text?: string }>).filter(
      (part) => part.type === 'text' && typeof part.text === 'string',
    );
    if (textParts.length > 0) {
      return { ...output, value: textParts } as T;
    }
    return { ...output, type: 'text', value: IMAGE_OMITTED } as T;
  }

  if (output.type === 'json') {
    const value = output.value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const content = (value as { content?: Array<{ type?: string; text?: string }> }).content;
      if (Array.isArray(content)) {
        const textContent = content
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => compactifyImageData(part.text as string))
          .filter((text) => text.length > 0);
        return {
          ...output,
          value: {
            ...(value as object),
            content:
              textContent.length > 0
                ? textContent.map((text) => ({ type: 'text', text }))
                : [{ type: 'text', text: IMAGE_OMITTED }],
          },
        } as T;
      }
    }
    return { ...output, value: compactifyImageData(JSON.stringify(value)) } as T;
  }

  if (typeof output.value === 'string') {
    return { ...output, value: compactifyImageData(output.value) } as T;
  }
  return { ...output, value: IMAGE_OMITTED } as T;
}

/**
 * Apply `sanitizeToolOutput` to every tool result in a set of model messages.
 * Used both for replayed history and for each freshly executed step.
 */
export function sanitizeToolResultImages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool' || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result') return part;
      const output = sanitizeToolOutput(part.output);
      if (output === part.output) return part;
      changed = true;
      return { ...part, output } as (typeof message.content)[number];
    });
    return changed ? { ...message, content } : message;
  });
}

/** Collect image content parts from the tool-result parts of a UI part list. */
export function extractImagesFromParts(parts: ChatMessagePart[]): Array<{ data: string; mimeType: string }> {
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const part of parts) {
    if (!isToolUIPart(part)) continue;
    const output = (part as { output?: unknown }).output;
    if (!output || typeof output !== 'object') continue;

    // AI SDK wraps tool outputs in one of several shapes depending on whether
    // `toModelOutput` exists on the tool and whether the raw result was a string:
    //
    // 1. Direct: { content: [{ type: 'image', data, mimeType }, ...] }
    //    (Legacy / direct assignment in unit tests)
    //
    // 2. JSON-wrapped (no toModelOutput): { type: 'json', value: { content: [...] } }
    //    SDK's `createToolModelOutput` wraps non-string results this way.
    //
    // 3. Content-wrapped (with toModelOutput that returns images):
    //    { type: 'content', value: [{ type: 'file', mediaType, data: { type: 'data', data } }, ...] }
    //    Our `mcpToModelOutput` produces this for image-bearing results.

    const typed = output as { type?: string; value?: unknown; content?: unknown };

    // Case 1: direct content array on output
    if (Array.isArray(typed.content)) {
      extractFromContentArray(typed.content, images);
      continue;
    }

    // Case 2: JSON-wrapped — unwrap .value and look for .content inside
    if (typed.type === 'json' && typed.value && typeof typed.value === 'object') {
      const inner = typed.value as { content?: unknown };
      if (Array.isArray(inner.content)) {
        extractFromContentArray(inner.content, images);
      }
      continue;
    }

    // Case 3: content-wrapped by toModelOutput — value is an array of parts
    if (typed.type === 'content' && Array.isArray(typed.value)) {
      for (const item of typed.value) {
        const p = item as { type?: string; mediaType?: string; data?: { type?: string; data?: string } };
        if (p.type === 'file' && p.mediaType?.startsWith('image/') && p.data?.type === 'data' && typeof p.data.data === 'string') {
          images.push({ data: p.data.data, mimeType: p.mediaType });
        }
      }
    }
  }
  return images;
}

/** Extract images from a raw content array (CallToolResult format). */
function extractFromContentArray(
  content: unknown[],
  images: Array<{ data: string; mimeType: string }>,
): void {
  for (const item of content) {
    const p = item as { type?: string; data?: unknown; mimeType?: unknown };
    if (p.type === 'image' && typeof p.data === 'string' && typeof p.mimeType === 'string') {
      images.push({ data: p.data, mimeType: p.mimeType });
    }
  }
}

/**
 * Build the synthetic user message that carries tool-produced images back to
 * the model. Only lives in the in-memory model prompt — it is never persisted
 * to the conversation or surfaced in the UI.
 */
export function buildImageUserMessage(images: Array<{ data: string; mimeType: string }>): ModelMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'The assistant used a browser tool that captured the following image(s). Use them for your response:',
      },
      ...images.map(({ data, mimeType }) => ({
        type: 'file' as const,
        mediaType: mimeType,
        data: { type: 'data' as const, data },
      })),
    ],
  };
}

/**
 * A resumable snapshot of an interrupted `chatStream` run.
 *
 * `modelMessages` bypasses `convertToModelMessages`, so it is only valid for the
 * exact conversation and provider/model that produced it — the wire shape of
 * tool calls differs per provider. `fingerprint` carries that identity so a
 * stale snapshot (e.g. the user switched models before retrying) is discarded
 * rather than sent to an incompatible endpoint.
 */
export interface ResumeState extends AgentLoopCheckpoint {
  fingerprint: string;
}

/**
 * Identity a `ResumeState` must match to be safely replayed.
 */
export function resumeFingerprint({
  conversationId,
  provider,
  model,
  messageCount,
  ocrAvailable = false,
  programmaticTools = false,
  compaction,
}: {
  conversationId: string;
  provider: ProviderConfig;
  model: ModelConfig;
  /** Guards against replaying onto a conversation that has since grown. */
  messageCount: number;
  /**
   * Whether OCR is available (enabled + configured). Part of the identity for
   * the same reason vision is: it decides whether image-producing tools such as
   * `page_screenshot` are in the tool set, so a checkpoint taken with OCR on
   * must not be resumed after it is turned off (and vice versa).
   */
  ocrAvailable?: boolean;
  /**
   * Whether the turn was started in programmatic mode. It replaces the whole
   * advertised tool list, so a checkpoint taken under one mode must not be
   * resumed under the other.
   */
  programmaticTools?: boolean;
  /**
   * Durable compaction boundary, if one exists. A checkpoint's `modelMessages`
   * were shaped by whether a summary was prepended and where the transcript was
   * cut, so a boundary change must invalidate the snapshot even when the stored
   * message count is unchanged.
   */
  compaction?: { firstKeptMessageId: string; createdAt: number };
}): string {
  return [
    conversationId,
    provider.id,
    normalizeProviderType(provider.type),
    // The *resolved* URL, so a vendor whose URL is derived (OpenCode) is still
    // distinguishable from one left on its SDK default.
    resolveBaseUrl(provider) ?? '',
    model.modelId,
    // Part of the identity for the same reason `modelId` is: the effort changes
    // the request a checkpoint would be replayed into, and on Anthropic it even
    // decides whether thinking blocks are present at all — so a snapshot taken
    // under one level must not be resumed under another.
    resolveReasoningEffort(model.reasoningEffort) ?? '',
    // Vision capability changes how images are projected into the prompt, so a
    // checkpoint taken under a vision model must not be resumed under a non-vision
    // one (which would carry raw image data the model cannot parse).
    model.isVision ? 'v1' : 'v0',
    // OCR availability changes which tools are exposed, so a checkpoint taken
    // under one OCR state must not be replayed under another.
    ocrAvailable ? 'ocr1' : 'ocr0',
    // Same reasoning: the mode decides the entire tool surface.
    programmaticTools ? 'shell1' : 'shell0',
    messageCount,
    compaction ? `c:${compaction.firstKeptMessageId}:${compaction.createdAt}` : 'c:none',
  ].join('\u0000');
}

// ---------------------------------------------------------------------------
// Context compaction
// ---------------------------------------------------------------------------

/**
 * Automatic compaction configuration for a single `chatStream` run.
 *
 * `priorSummary` / `summaryMessageCount` describe a durable checkpoint that is
 * already part of `messages` (produced by `projectConversation`), so an
 * in-loop compaction merges new history into it instead of re-summarizing it.
 */
export interface ChatCompactionOptions {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  /** Durable summary already prepended to `messages`, when one exists. */
  priorSummary?: string;
  /** Leading UI messages occupied by the injected summary (0 or 1). */
  summaryMessageCount?: number;
}

/**
 * A between-step request to compact the *stored* transcript.
 *
 * The loop knows the prompt is over budget but only the store owns the
 * conversation and its persistence. Returning a projection lets the loop
 * rebuild its prefix while keeping the current turn's wire tail untouched.
 */
export interface StepCompactionRequest {
  /** Step that just completed (0-based). */
  step: number;
  /** Estimated prompt size the next request would send. */
  tokensBefore: number;
}

export interface StepCompactionResult {
  /**
   * The new UI projection: checkpoint first, then kept stored messages. The
   * loop converts it with the same tool set it used for the turn's first
   * request, so tool-call replay stays consistent.
   */
  uiMessages: UIMessage[];
  /** Checkpoint summary when the projection starts with one. */
  priorSummary?: string;
}

export interface GenerateCompactionSummaryOptions {
  provider: ProviderConfig;
  model: ModelConfig;
  messages: ChatMessage[];
  previousSummary?: string;
  customInstructions?: string;
  /** Used to derive a distinct routing session for vendors that require one. */
  conversationId?: string;
  signal?: AbortSignal;
}

/** Map an AI SDK usage record onto lumo's normalized token stats. */
function toTokenUsageStats(usage: LanguageModelUsage | undefined): TokenUsageStats | undefined {
  if (!usage) return undefined;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  if (input + output === 0) return undefined;
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: usage.totalTokens ?? input + output,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  };
}

/**
 * Summarize a slice of stored messages with the conversation's own model.
 *
 * Used by the pre-send (durable) path. The call is deliberately tool-free: the
 * summarizer must only produce a checkpoint, never act on the page.
 *
 * Vendors such as OpenCode *require* a session header and reject the request
 * outright without one. The summary therefore gets its own session, derived
 * from the conversation but salted so it never collides with the live chat's
 * session — the summary is a different request than the conversation it
 * describes, and sharing the session would tie its routing and prompt-cache
 * affinity to prompts it will never repeat. Mirrors pi's distinct routing id
 * for one-off summaries, while staying routable on OpenCode.
 */
export async function generateCompactionSummary({
  provider,
  model,
  messages,
  previousSummary,
  customInstructions,
  conversationId,
  signal,
}: GenerateCompactionSummaryOptions): Promise<{ text: string; usage?: TokenUsageStats }> {
  const sessionId = await resolveProviderSessionId(
    provider,
    conversationId ? `${conversationId}:compaction` : undefined,
  );
  const { model: aiModel, providerOptions, reasoning } = createProvider(provider, model, { sessionId });
  const { system, prompt } = buildSummaryPrompt(
    serializeConversationForSummary(messages),
    previousSummary,
    customInstructions,
  );
  const result = await generateText({
    model: aiModel,
    system,
    prompt,
    abortSignal: signal,
    ...(providerOptions ? { providerOptions } : {}),
    ...(reasoning ? { reasoning } : {}),
  });
  const text = result.text.trim();
  if (result.finishReason === 'length') {
    throw new Error('Summarization hit the token cap and the checkpoint would be incomplete');
  }
  if (!text) throw new Error('Summarization returned an empty response');
  return { text, usage: toTokenUsageStats(result.usage) };
}

/**
 * Why an assistant turn stopped producing steps.
 *
 * The distinction exists because only one of these is the model deciding it is
 * done. The others leave work unfinished, and a caller that cannot tell them
 * apart has to treat a truncated turn as a complete one — which is exactly the
 * failure this type was added to remove: the loop used to fall out of its step
 * cap through the same `return` as a natural finish, so a turn cut off mid-task
 * was saved, rendered and reported as if the model had answered.
 */
export type StopReason =
  /** The model answered without calling tools — its own natural end. */
  | 'finished'
  /** The configured step cap ran out while tool calls were still pending. */
  | 'step-limit'
  /** A provider or stream error ended the run. */
  | 'error'
  /** The user hit stop, or the panel was torn down mid-stream. */
  | 'aborted';

export interface ChatStreamOptions {
  provider: ProviderConfig;
  model: ModelConfig;
  /** Whether the model supports vision (image inputs). */
  isVision?: boolean;
  /**
   * Conversation history as UI messages. Converted to the model prompt inside
   * `chatStream` so the exact same tool set drives both the conversion and the
   * request (see `enableTools`).
   */
  messages: UIMessage[];
  /** Optional system instructions prepended to the prompt. */
  system?: string;
  /**
   * Called on every stream update with the full, ordered part list of the
   * assistant message. Text and tool parts arrive interleaved in the order the
   * model produced them.
   */
  onUpdate: (parts: ChatMessagePart[]) => void;
  onFinish: (parts: ChatMessagePart[], stoppedReason: StopReason, usage?: TokenUsageStats) => void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
  /** Whether to include MCP tools in this request */
  enableTools?: boolean;
  /** Conversation ID for the current stream (passed to tools for file association) */
  conversationId?: string;
  /**
   * Cap on tool-loop steps for this turn. `0` (the default) means no cap. Read
   * from the user's UI settings per turn, so changing it takes effect on the
   * next message rather than on the next reload. See `lib/max-steps.ts`.
   */
  maxSteps?: number;
  /**
   * Experimental shell mode: expose `file_read`, `file_write`, `file_edit` and
   * `sh`, with every MCP server reachable through the `mcp` shell command.
   */
  programmaticTools?: boolean;
  /**
   * Resume an interrupted run from its last completed step instead of replaying
   * the whole conversation. Ignored when the fingerprint does not match.
   */
  resume?: ResumeState;
  /** Emits a resume checkpoint after every completed step. */
  onStepComplete?: (checkpoint: AgentLoopCheckpoint) => void;
  /** Called after each step with the cumulative token usage so far. */
  onUsage?: (usage: TokenUsageStats, processedPartCount: number) => void;
  /**
   * Automatic compaction between tool steps. When omitted (or disabled) the
   * loop keeps whatever prompt it was given, which is the historical behaviour.
   */
  compaction?: ChatCompactionOptions;
  /**
   * Raised while the loop folds history into a summary between steps. Lets the
   * UI show the call instead of appearing to stall mid-tool-loop.
   */
  onCompaction?: (event: CompactionEvent) => void;
  /**
   * Take the user messages composed while this run was streaming.
   *
   * Called at every step boundary the loop is going to continue past — after
   * the step's tool results are folded into the prompt, before the next model
   * request — so a message lands exactly where the user meant it: after the
   * tools it was reacting to. Whatever is returned is delivered immediately.
   *
   * Nothing is pulled once the model has stopped calling tools (the turn is
   * over) or the step cap is reached: the turn owner sends the queue as its own
   * turn in the first case, and keeps it for one in the second.
   */
  pullQueuedInput?: () => QueuedUserInput[];
  /**
   * Called once per delivered message, after it was appended to the prompt and
   * before the segments are advanced.
   *
   * This is the durability hook: everything streamed so far belongs to an
   * assistant message that is now closed, and the caller is the only place that
   * can write that to the transcript. Awaiting it keeps storage ahead of the
   * next request.
   */
  onInputInjected?: (input: QueuedUserInput) => Promise<void> | void;
  /**
   * Durable between-step compaction. When provided, the store folds the stored
   * transcript and hands back the projection; the loop keeps the current turn's
   * wire messages as a tail. Resumed runs pass nothing: their prompt is a
   * snapshot, not a projection that can be rebuilt.
   */
  onCompactBeforeStep?: (request: StepCompactionRequest) => Promise<StepCompactionResult | null>;
}

export async function chatStream({
  provider,
  model,
  messages,
  system,
  onUpdate,
  onFinish,
  onError,
  signal,
  enableTools = true,
  isVision = true,
  conversationId,
  maxSteps = DEFAULT_MAX_STEPS,
  programmaticTools = false,
  resume,
  onStepComplete,
  onUsage,
  compaction,
  onCompaction,
  onCompactBeforeStep,
  pullQueuedInput,
  onInputInjected,
}: ChatStreamOptions) {
  // Seed with the resumed parts so an abort or a second failure still reports
  // everything streamed across attempts, not just the current one.
  let latestParts: ChatMessagePart[] = resume ? [...resume.parts] : [];
  // `readUIMessageStream` reports errors via its `onError` callback and then
  // closes the stream normally, so guard the terminal callbacks to make sure
  // exactly one of onFinish/onError runs (otherwise the message is saved twice).
  let settled = false;

  const finishOnce = (parts: ChatMessagePart[], stoppedReason: StopReason, usage?: TokenUsageStats) => {
    if (settled) return;
    settled = true;
    onFinish(parts, stoppedReason, usage);
  };

  const failOnce = (error: unknown) => {
    if (settled) return;
    settled = true;
    onError(toError(error));
  };

  try {
    // A session id the vendor can route on must be derived before the model is
    // built, because it rides the transport headers rather than the body.
    const sessionId = await resolveProviderSessionId(provider, conversationId);
    const { model: aiModel, providerOptions, reasoning } = createProvider(provider, model, {
      sessionId,
    });

    // Gather tools from all connected MCP servers (with stream-specific context).
    // A non-vision model still gets image-producing tools (e.g. page_screenshot)
    // when OCR is enabled: the loop OCRs their output before it reaches the model.
    const allTools: ToolSet = enableTools
      ? filterToolsByVision(
          mcpRegistry.getAllAITools({ conversationId }),
          isVision || (await isOcrAvailable()),
        )
      : {};

    // Programmatic mode replaces the flat tool list with four tools.
    const programmatic = programmaticTools && enableTools;
    const tools: ToolSet = programmatic
      ? buildProgrammaticToolSet(allTools, { ...(conversationId ? { conversationId } : {}) })
      : allTools;

    // History conversion is a different dependency: it needs every tool's
    // declaration so a call written under one mode (or by a server that is now
    // disconnected) still converts instead of collapsing to "tool no longer
    // available". Descriptors carry no executor, so this neither loads the shell
    // runtime nor advertises a tool to the model.
    const conversionTools: ToolSet = buildConversionToolSet();
    const trimmedSystem = system?.trim();

    // Resuming replays the checkpoint verbatim: it is already a model prompt
    // with sanitized tool results, so re-deriving it from history would both
    // waste work and lose the synthetic image messages the loop injected.
    let modelMessages = resume
      ? resume.modelMessages
      : sanitizeToolResultImages(
          await convertToModelMessages(messages, {
            tools: conversionTools,
            // A tool call left dangling by an aborted stream would otherwise throw.
            ignoreIncompleteToolCalls: true,
          }),
        );

    // For non-vision models, project images to text (OCR or placeholder).
    if (!isVision && !resume) {
      modelMessages = await projectImagesForNonVision(modelMessages, signal);
    }

    const { parts, stoppedReason, usage } = await runAgentLoop({
      model: aiModel,
      providerOptions,
      reasoning,
      tools,
      system: trimmedSystem,
      messages: modelMessages,
      initialParts: resume?.parts,
      maxSteps,
      conversionTools,
      isVision,
      signal,
      compaction:
        compaction?.enabled && (model.contextWindow ?? 0) > 0
          ? {
              contextWindow: model.contextWindow!,
              reserveTokens: compaction.reserveTokens,
              keepRecentTokens: compaction.keepRecentTokens,
              ...(compaction.priorSummary ? { priorSummary: compaction.priorSummary } : {}),
              summaryMessageCount: compaction.summaryMessageCount ?? 0,
            }
          : undefined,
      onUpdate: (updatedParts) => {
        latestParts = updatedParts;
        onUpdate(updatedParts);
      },
      onError: failOnce,
      onStepComplete,
      onUsage,
      onCompaction,
      pullQueuedInput,
      onInputInjected,
      // A resume prompt is a one-off snapshot, not a projection that can be
      // rebuilt from the stored transcript, so durable folding is disabled and
      // the in-memory fold takes over.
      ...(resume ? {} : { onCompactBeforeStep }),
    });
    latestParts = parts;

    finishOnce(latestParts, stoppedReason, usage);
  } catch (error) {
    if (isAbort(error)) {
      // Keep whatever was streamed before the user hit stop.
      finishOnce(latestParts, 'aborted');
      return;
    }
    failOnce(error);
  }
}

export interface RunAgentLoopOptions {
  model: LanguageModel;
  providerOptions?: ProviderMetadata;
  /**
   * Unified reasoning level for every step of this run. Omitted from the request
   * when absent, which is what a model left on the provider default resolves to,
   * and also what a level only its own provider can spell resolves to — that one
   * travels in `providerOptions` instead.
   */
  reasoning?: UnifiedReasoningEffort;
  tools?: ToolSet;
  system?: string;
  messages: ModelMessage[];
  signal?: AbortSignal;
  /** Whether the model supports vision. Controls image re-injection. */
  isVision?: boolean;
  /** Parts already streamed by earlier steps, when resuming a failed run. */
  initialParts?: ChatMessagePart[];
  /** Cap on iterations. `0` (the default) means no cap. See `lib/max-steps.ts`. */
  maxSteps?: number;
  /**
   * Tool declarations used only to convert stored history (never advertised to
   * the model). Defaults to the full descriptor catalogue; programmatic mode
   * advertises four tools but still needs every declaration to replay old
   * results during compaction.
   */
  conversionTools?: ToolSet;
  /**
   * Called on every stream update with the ordered parts of the segment being
   * streamed. A delivered user message closes a segment, so earlier segments
   * are already in the transcript and are not included.
   */
  onUpdate?: (parts: ChatMessagePart[]) => void;
  /** Called when a model stream reports an error. */
  onError?: (error: unknown) => void;
  /**
   * Called once per fully completed step with the exact prompt the *next* step
   * would run with. This is the resume checkpoint: it is emitted after tool
   * results and tool-produced images have been folded into the prompt, so
   * replaying it reproduces the loop state without re-running the step.
   */
  onStepComplete?: (checkpoint: AgentLoopCheckpoint) => void;
  /**
   * Called after each step with the cumulative token usage so far and the
   * number of parts of the *current segment* the anchored prompt now covers.
   * The count is what lets the caller add only the parts streamed *after* the
   * anchor without ever double-counting the step's own output.
   */
  onUsage?: (usage: TokenUsageStats, processedPartCount: number) => void;
  /** Between-step compaction configuration. Absent leaves the prompt untouched. */
  compaction?: WireCompactionConfig;
  /** Raised while a between-step compaction runs. */
  onCompaction?: (event: CompactionEvent) => void;
  /**
   * Take the user messages composed while this run was streaming. Called at
   * every step boundary the loop continues past — after the step's tool results
   * are in the prompt, before the next request. See `ChatStreamOptions`.
   */
  pullQueuedInput?: () => QueuedUserInput[];
  /** Called once per delivered message, after it joined the prompt. */
  onInputInjected?: (input: QueuedUserInput) => Promise<void> | void;
  /**
   * Durable between-step compaction. The loop asks the caller to fold the
   * stored transcript and hand back the new projection; the current turn's wire
   * messages are preserved as a tail. Absent (or on a resumed run) the loop
   * falls back to the in-memory fold.
   */
  onCompactBeforeStep?: (request: StepCompactionRequest) => Promise<StepCompactionResult | null>;
}

/** Outcome of a `runAgentLoop` run: what it produced, and why it stopped. */
export interface AgentLoopResult {
  /** Parts of the last segment only; earlier segments were delivered as messages. */
  parts: ChatMessagePart[];
  /** Never `'aborted'` — an abort unwinds as a thrown error, not a return. */
  stoppedReason: Exclude<StopReason, 'aborted'>;
  /** Cumulative token usage across all steps in this run. */
  usage: TokenUsageStats;
}

/** Snapshot of the agent loop between two steps. */
export interface AgentLoopCheckpoint {
  /** Full model prompt as of the end of the completed step. */
  modelMessages: ModelMessage[];
  /**
   * Parts of the segment that is still open. Segments closed by a delivered
   * user message are already stored, so replaying them would duplicate them.
   */
  parts: ChatMessagePart[];
}

/**
 * Run the tool agent loop step by step.
 *
 * A single `streamText` call (with `stopWhen: isStepCount(1)`) drives one model
 * round-trip; the loop below owns continuation so it can:
 * 1. strip image payloads out of tool results fed back to the model, and
 * 2. re-inject them as a synthetic user message — the only way Chat-Completions
 *    models can "see" tool-produced images. The same uniform path also works
 *    for Anthropic and OpenAI Responses.
 *
 * Owning continuation also means owning the step cap, which is why the outcome
 * is returned rather than just the parts: hitting the cap leaves tool calls
 * pending, and the caller has to be able to say so.
 */
export async function runAgentLoop({
  model,
  providerOptions,
  reasoning,
  tools = {},
  system,
  messages,
  signal,
  isVision = true,
  initialParts,
  maxSteps = DEFAULT_MAX_STEPS,
  conversionTools = buildConversionToolSet(),
  onUpdate,
  onError,
  onStepComplete,
  onUsage,
  compaction,
  onCompaction,
  onCompactBeforeStep,
  pullQueuedInput,
  onInputInjected,
}: RunAgentLoopOptions): Promise<AgentLoopResult> {
  const hasTools = Object.keys(tools).length > 0;
  const trimmedSystem = system?.trim();
  let modelMessages = sanitizeToolResultImages(messages);
  // First wire message produced by this turn. Everything from here on is the
  // live tail and must survive a projection rebuild; everything before it is
  // the stored prompt the durable callback may replace.
  let turnTailStart = modelMessages.length;
  // A resumed prompt is a snapshot, not a projection: there is no stored
  // boundary to rebuild from. Retries keep the in-memory fold. Disabled for the
  // rest of the run once an in-memory fold has replaced the whole prompt, since
  // the live tail is no longer a separable suffix.
  let durableCompaction = initialParts ? undefined : onCompactBeforeStep;
  // Tracks the summary that supersedes any injected checkpoint as the loop folds
  // more history away, so a second compaction merges instead of restarting.
  let priorSummary = compaction?.priorSummary;
  let summaryMessageCount = compaction?.summaryMessageCount ?? 0;
  // Seeding with the parts already streamed lets a resumed run keep appending
  // instead of restarting the part list, so the UI never loses earlier steps.
  let latestParts: ChatMessagePart[] = initialParts ? [...initialParts] : [];
  // Index in `latestParts` where the *current* assistant segment begins. A
  // delivered user message closes the segment: the parts before it are already
  // in the transcript, so everything reported from here on (stream updates,
  // usage anchors, checkpoints, the final result) is relative to this index.
  // `latestParts` itself stays cumulative because the wire prompt is: a resume
  // snapshot has to be able to replay the whole run.
  let segmentStart = 0;
  /** Parts of the segment still being streamed. */
  const segmentParts = (): ChatMessagePart[] => latestParts.slice(segmentStart);

  // Cumulative token usage across all steps.
  const usageSteps: TokenUsageStep[] = [];
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalReasoning = 0;

  /** Build a cumulative usage snapshot from the running totals. */
  const buildUsage = (): TokenUsageStats => ({
    inputTokens: totalInput,
    outputTokens: totalOutput,
    totalTokens: totalInput + totalOutput,
    ...(totalCacheRead > 0 ? { cacheReadTokens: totalCacheRead } : {}),
    ...(totalCacheWrite > 0 ? { cacheWriteTokens: totalCacheWrite } : {}),
    ...(totalReasoning > 0 ? { reasoningTokens: totalReasoning } : {}),
    steps: [...usageSteps],
  });

  for (let step = 0; stepAllowed(step, maxSteps); step++) {
    // `readUIMessageStream` reports stream errors via `onError` and then closes
    // normally, so flag it and stop instead of spending another model request.
    let errored = false;
    const handleError = (error: unknown) => {
      errored = true;
      onError?.(error);
    };

    const promptMessageCount = modelMessages.length;
    const result = streamText({
      model,
      messages: modelMessages,
      abortSignal: signal,
      ...(trimmedSystem ? { system: trimmedSystem } : {}),
      ...(providerOptions ? { providerOptions } : {}),
      // Spread, so a default-configured model leaves the key off the call object
      // entirely. The SDK ignores an explicit `undefined` too, but keeping it
      // absent is what makes "provider default" verifiable from the request.
      ...(reasoning ? { reasoning } : {}),
      // A single step per iteration — this loop drives continuation so it can
      // strip/inject images between steps.
      //
      // `repairToolCall` recovers arguments a gateway mangled in transit (see
      // `lib/tool-call-repair.ts`). Without it the SDK turns such a call into a
      // `tool-error`, which spends one of this loop's steps on a call the model
      // meant correctly.
      ...(hasTools ? { tools, stopWhen: isStepCount(1), repairToolCall } : {}),
    });

    // `textStream` would drop every tool/reasoning chunk, so consume the full
    // stream as UI message chunks and let the SDK assemble the ordered parts.
    const uiStream = readUIMessageStream<UIMessage>({
      stream: result.toUIMessageStream({
        sendReasoning: true,
        // Defaults to masking errors as "An error occurred." to avoid leaking
        // server details; here the model call is the user's own, so show it.
        // Providers may emit non-`Error` frames, so unwrap rather than
        // stringify — `String(frame)` would collapse to "[object Object]".
        onError: (error) => toError(error).message,
      }),
      onError: handleError,
    });

    // Accumulate this step's parts onto everything streamed before it.
    const stepStartIndex = latestParts.length;
    for await (const uiMessage of uiStream) {
      const stepParts = uiMessage.parts as ChatMessagePart[];
      latestParts = [...latestParts.slice(0, stepStartIndex), ...stepParts];
      onUpdate?.(segmentParts());
    }

    if (errored) return { parts: segmentParts(), stoppedReason: 'error', usage: buildUsage() };

    // Collect token usage for this step.
    const stepUsage = await result.usage;
    const stepCacheRead = stepUsage.inputTokenDetails?.cacheReadTokens ?? 0;
    const stepCacheWrite = stepUsage.inputTokenDetails?.cacheWriteTokens ?? 0;
    const stepReasoningTokens = stepUsage.outputTokenDetails?.reasoningTokens ?? 0;
    const stepInputTokens = stepUsage.inputTokens ?? 0;
    const stepOutputTokens = stepUsage.outputTokens ?? 0;

    totalInput += stepInputTokens;
    totalOutput += stepOutputTokens;
    totalCacheRead += stepCacheRead;
    totalCacheWrite += stepCacheWrite;
    totalReasoning += stepReasoningTokens;

    usageSteps.push({
      step,
      inputTokens: stepInputTokens,
      outputTokens: stepOutputTokens,
      totalTokens: stepInputTokens + stepOutputTokens,
      ...(stepCacheRead > 0 ? { cacheReadTokens: stepCacheRead } : {}),
      ...(stepCacheWrite > 0 ? { cacheWriteTokens: stepCacheWrite } : {}),
      ...(stepReasoningTokens > 0 ? { reasoningTokens: stepReasoningTokens } : {}),
    });

    // The anchor is expressed in the *segment's* part space, because that is
    // what the UI holds while a message is streaming.
    onUsage?.(buildUsage(), latestParts.length - segmentStart);

    const responseMeta = await result.response;
    const stepMessages = responseMeta.messages;

    // Feed the step's assistant + tool messages back, minus image payloads.
    modelMessages = [...modelMessages, ...sanitizeToolResultImages(stepMessages)];

    // Re-inject tool-produced images as a synthetic user message.
    const images = extractImagesFromParts(latestParts.slice(stepStartIndex));
    if (images.length > 0) {
      if (isVision) {
        modelMessages.push(buildImageUserMessage(images));
      } else {
        // Non-vision model: OCR or placeholder for tool-produced images.
        const fallback = await buildImageFallbackMessage(images, signal);
        modelMessages.push(fallback);
      }
    }

    // `isLoopFinished()` semantics: keep looping while the model still issues
    // tool calls.
    const hasPendingToolCalls = stepMessages.some(
      (message) =>
        message.role === 'assistant' &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === 'tool-call'),
    );
    if (!hasPendingToolCalls) return { parts: segmentParts(), stoppedReason: 'finished', usage: buildUsage() };

    // Steered delivery. A message the user composed while this step was running
    // is handed to the model exactly here: after the step's tool results (and
    // tool-produced images) are in the prompt, before the next request. The
    // step that follows continues the same turn instead of starting a new one,
    // which is what makes it feel like the user cut in rather than queued up.
    //
    // Only when the loop is actually going to continue: injecting on the last
    // allowed step would record a message that nothing answers.
    if (stepAllowed(step + 1, maxSteps)) {
      const queued = pullQueuedInput?.() ?? [];
      for (const input of queued) {
        modelMessages = [
          ...modelMessages,
          ...(await convertQueuedInput(input, tools)),
        ];
        // Persist the segment that just closed *before* the next request, and
        // before compaction rebuilds anything from the transcript.
        await onInputInjected?.(input);
        // The injected message is part of the stored transcript from now on, so
        // the live tail is no longer a clean suffix of it: a durable rebuild
        // would append the stored copy and the tail copy. Fall back to the
        // in-memory fold, which rewrites the whole prompt and cannot duplicate
        // — same reason a fold disables the durable path further down.
        durableCompaction = undefined;
        segmentStart = latestParts.length;
      }
    }

    // Between-step compaction. Checked after tool results and tool-produced
    // images are folded in, before the next assistant response — the point at
    // which the prompt is at its largest. `anchorTokens` is the exact prompt
    // size of the step just run (it already includes system prompt and tool
    // schemas), so only the messages appended since need estimating.
    if (compaction) {
      let foldedDurably = false;
      if (durableCompaction) {
        const appendedChars = measureModelMessagesChars(
          modelMessages.slice(promptMessageCount),
        );
        const estimatedTokens =
          stepInputTokens + stepOutputTokens + estimateCharsToTokens(appendedChars);
        if (exceedsBudget(estimatedTokens, compaction.contextWindow, compaction.reserveTokens)) {
          const result = await durableCompaction({ step, tokensBefore: estimatedTokens });
          if (result) {
            // Rebuild the stored prefix from the durable projection and keep the
            // live tail (this turn's tool calls/results and injected images).
            const tail = modelMessages.slice(turnTailStart);
            const converted = sanitizeToolResultImages(
              await convertToModelMessages(result.uiMessages, {
                tools: conversionTools ?? tools,
                ignoreIncompleteToolCalls: true,
              }),
            );
            const prefix = isVision
              ? converted
              : await projectImagesForNonVision(converted, signal);
            modelMessages = [...prefix, ...tail];
            turnTailStart = prefix.length;
            priorSummary = result.priorSummary;
            summaryMessageCount = result.priorSummary ? 1 : 0;
            foldedDurably = true;
          }
        }
      }

      // Fall back to the in-memory fold when there is no durable owner, or when
      // the durable one found nothing old enough to summarize.
      if (!foldedDurably) {
        const compacted = await compactWireMessages({
          messages: modelMessages,
          model,
          providerOptions,
          reasoning,
          signal,
          config: { ...compaction, priorSummary, summaryMessageCount },
          anchorTokens: stepInputTokens + stepOutputTokens,
          appendedChars: measureModelMessagesChars(
            modelMessages.slice(promptMessageCount),
          ),
          ...(onCompaction ? { onEvent: onCompaction } : {}),
        });
        if (compacted) {
          modelMessages = compacted.messages;
          priorSummary = compacted.summary;
          summaryMessageCount = 1;
          turnTailStart = 0;
          // The in-memory fold rewrote the whole prompt (prefix *and* tail).
          // A later durable rebuild would append a second copy of the tail.
          durableCompaction = undefined;
        }
      }
    }

    // Checkpoint *after* image injection and any compaction, so the snapshot is
    // byte-for-byte the prompt the next iteration is about to send. Emitted only
    // when the loop continues, which makes "a checkpoint exists" mean "work
    // remains". The parts are the live segment's: earlier segments are already
    // stored, so replaying them would duplicate them in the transcript.
    onStepComplete?.({
      modelMessages: [...modelMessages],
      parts: segmentParts(),
    });
  }

  // Falling out of the loop means the cap ran out with tool calls still pending.
  // Every other way to leave it returns from inside, so this cannot be reached
  // by a turn the model actually finished.
  return { parts: segmentParts(), stoppedReason: 'step-limit', usage: buildUsage() };
}

/**
 * Convert one queued user message into wire messages.
 *
 * It goes through the same `convertToModelMessages` path the first user turn
 * took — with the same tool set — so an image attachment becomes exactly the
 * file part it would have been had the message been sent normally.
 */
async function convertQueuedInput(
  input: QueuedUserInput,
  tools: ToolSet,
): Promise<ModelMessage[]> {
  const message: UIMessage = {
    id: input.id,
    role: 'user',
    parts: buildUserParts(input) as UIMessage['parts'],
  };
  return convertToModelMessages([message], { tools, ignoreIncompleteToolCalls: true });
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}
