/**
 * The user half of the conversation: one constructor for the message the
 * composer produced.
 *
 * Both send paths build the same shape — the ordinary send in
 * `store/useChatStream` and a message delivered mid-turn by the agent loop — so
 * they share one definition here. Divergence between the two would be invisible
 * in the UI (both render through the same bubble) and only show up as a prompt
 * the model reads differently, which is the worst place to discover it.
 */

import { serializeAttachmentForModel } from '@/lib/attachment-serialization';
import type { ChatMessage, ChatMessagePart, QueuedUserInput } from '@/types';

/** Media type of a data URL, defaulting to PNG for bare base64 payloads. */
function mediaTypeOf(dataUrl: string): string {
  return /^data:([^;,]+)[;,]/.exec(dataUrl)?.[1] ?? 'image/png';
}

/**
 * Ordered parts for a user message: images, then attachment payloads, then the
 * typed text — the order the model should read them in.
 */
export function buildUserParts({
  text,
  images,
  textAttachments,
}: Pick<QueuedUserInput, 'text' | 'images' | 'textAttachments'>): ChatMessagePart[] {
  return [
    ...images.map((image) => ({
      type: 'file' as const,
      mediaType: mediaTypeOf(image),
      url: image,
    })),
    ...textAttachments.map((attachment) => ({
      type: 'text' as const,
      text: serializeAttachmentForModel(attachment),
      state: 'done' as const,
    })),
    ...(text ? [{ type: 'text' as const, text, state: 'done' as const }] : []),
  ];
}

/** The stored `ChatMessage` for a user message, with its attachment metadata. */
export function buildUserMessage(content: QueuedUserInput): ChatMessage {
  return {
    id: content.id,
    role: 'user',
    parts: buildUserParts(content),
    ...(content.textAttachments.length > 0
      ? { textAttachments: content.textAttachments }
      : {}),
    timestamp: content.timestamp,
  };
}
