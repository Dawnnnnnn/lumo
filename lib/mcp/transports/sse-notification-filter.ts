/**
 * Drops server → client MCP notifications from SSE response bodies.
 *
 * MCP allows a server to push JSON-RPC notifications on the same stream as a
 * response (`notifications/message` logging, `notifications/tools/list_changed`,
 * `notifications/progress`, …). `@ai-sdk/mcp` treats every message that has a
 * `method` but no `id` as a fatal protocol error:
 *
 *   if ("method" in message) {
 *     if ("id" in message) this.onRequestMessage(message);
 *     else this.onError(new MCPClientError({ message: "Unsupported message type" }));
 *     return;
 *   }
 *
 * The result is the nagging "Unsupported message type" error (once per
 * notification) while tools keep working. Filtering at the `fetch` layer keeps
 * using only the public transport config, so it applies to `initialize`,
 * `tools/list`, `tools/call` and the legacy SSE transport alike.
 *
 * Responses, errors and non-JSON events are forwarded byte-for-byte.
 */

/** SSE dispatches an event when a blank line is reached; lines end with CRLF, CR or LF. */
const EVENT_SEPARATOR = /\r\n\r\n|\n\n|\r\r/;

/** A JSON-RPC notification: a named method without an id. */
export function isJsonRpcNotification(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const record = message as Record<string, unknown>;
  return typeof record.method === 'string' && !('id' in record);
}

/** Concatenates the `data:` lines of an SSE event, or returns null when it has none. */
function extractDataPayload(block: string): string | null {
  const lines = block.split(/\r\n|\n|\r/);
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length > 0 ? data.join('\n') : null;
}

function isNotificationEvent(block: string): boolean {
  const payload = extractDataPayload(block)?.trim();
  if (!payload || (!payload.startsWith('{') && !payload.startsWith('['))) return false;
  try {
    const message: unknown = JSON.parse(payload);
    if (Array.isArray(message)) return message.every(isJsonRpcNotification);
    return isJsonRpcNotification(message);
  } catch {
    // Malformed JSON is not ours to drop; let the SDK surface it.
    return false;
  }
}

/** Streaming transform that removes notification events and passes everything else through. */
export function createSseNotificationFilterStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let match = EVENT_SEPARATOR.exec(buffer);
      while (match) {
        const end = match.index + match[0].length;
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end);
        if (!isNotificationEvent(block)) controller.enqueue(encoder.encode(block));
        match = EVENT_SEPARATOR.exec(buffer);
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      // An unterminated trailing event is still a real event for the SDK.
      if (buffer.length > 0 && !isNotificationEvent(buffer)) {
        controller.enqueue(encoder.encode(buffer));
      }
    },
  });
}

/**
 * Returns `response` unchanged unless it is an SSE body, in which case the body
 * is piped through the notification filter. Framing headers are dropped because
 * the filtered body has a different length than the original.
 */
export function stripSseNotifications(response: Response): Response {
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.body || !contentType.includes('text/event-stream')) return response;

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');

  return new Response(response.body.pipeThrough(createSseNotificationFilterStream()), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
