import {
  isToolUIPart,
  getToolName,
  type UIMessage,
  type UIMessagePart,
  type UIDataTypes,
  type UITools,
} from 'ai';
import type { ChatMessage, ChatMessagePart } from '@/types';

/** A tool part, either a static `tool-${name}` part or a `dynamic-tool` part. */
export type ToolPart = Extract<ChatMessagePart, { toolCallId: string }>;

/**
 * Read a stored message as parts.
 *
 * Conversations persisted before the parts model only have flat `content` /
 * `images`, so they are upgraded on read. This keeps old chat history readable
 * without a destructive storage migration.
 */
export function normalizeMessage(message: ChatMessage): ChatMessagePart[] {
  // When a variant is active, show its parts instead of the message's own.
  if (
    message.variants &&
    message.activeVariantIndex !== undefined &&
    message.activeVariantIndex < message.variants.length
  ) {
    return message.variants[message.activeVariantIndex]!.parts;
  }

  if (message.parts && message.parts.length > 0) return message.parts;

  const parts: ChatMessagePart[] = [];

  for (const image of message.images ?? []) {
    parts.push({
      type: 'file',
      mediaType: inferMediaTypeFromDataUrl(image),
      url: image,
    });
  }

  if (message.content) {
    parts.push({ type: 'text', text: message.content, state: 'done' });
  }

  return parts;
}

/** Infer the media type from a data URL, defaulting to `image/png`. */
function inferMediaTypeFromDataUrl(url: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(url);
  return match?.[1] ?? 'image/png';
}

/** Concatenate all text parts — used for copy-to-clipboard and titles. */
export function extractText(parts: ChatMessagePart[]): string {
  return parts
    .filter((part): part is Extract<ChatMessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/** Whether a message has anything worth rendering. */
export function hasRenderableParts(parts: readonly ChatMessagePart[]): boolean {
  return parts.some(
    (part) =>
      (part.type === 'text' && part.text.length > 0) ||
      (part.type === 'reasoning' && part.text.length > 0) ||
      part.type === 'file' ||
      isToolUIPart(part),
  );
}

/**
 * Convert stored messages into AI SDK `UIMessage`s so `convertToModelMessages`
 * can rebuild the full model prompt — including prior tool calls and results,
 * which is what lets the model reason over earlier tool output.
 */
export function toUIMessages(messages: ChatMessage[]): UIMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    parts: normalizeMessage(message) as UIMessagePart<UIDataTypes, UITools>[],
  }));
}

/** Stable React key for a part, preferring tool call ids over positional index. */
export function partKey(part: ChatMessagePart, index: number): string {
  if (isToolUIPart(part)) return `${part.type}-${part.toolCallId}`;
  return `${part.type}-${index}`;
}

/** Display name for a tool part, works for both static and dynamic tools. */
export function toolPartName(part: ToolPart): string {
  return getToolName(part);
}
