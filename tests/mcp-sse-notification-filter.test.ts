import { describe, expect, it } from 'vitest';
import {
  createSseNotificationFilterStream,
  isJsonRpcNotification,
  stripSseNotifications,
} from '@/lib/mcp/transports/sse-notification-filter';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sseResponse(chunks: string[], headers: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

function filterBlock(block: string): Promise<string> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(block));
      controller.close();
    },
  }).pipeThrough(createSseNotificationFilterStream());
  return readAll(stream);
}

const LOGGING_NOTIFICATION =
  'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","logger":"desktop-commander","data":"Server connected"}}\n\n';
const LIST_CHANGED_NOTIFICATION =
  'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n';
const TOOLS_RESULT =
  'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"get_config"}]}}\n\n';

describe('isJsonRpcNotification', () => {
  it('accepts a method without an id', () => {
    expect(isJsonRpcNotification({ jsonrpc: '2.0', method: 'notifications/message' })).toBe(true);
  });

  it('rejects a method with an id (server initiated request)', () => {
    expect(isJsonRpcNotification({ jsonrpc: '2.0', id: 7, method: 'ping' })).toBe(false);
  });

  it('rejects responses and non-objects', () => {
    expect(isJsonRpcNotification({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false);
    expect(isJsonRpcNotification(null)).toBe(false);
    expect(isJsonRpcNotification('notifications/message')).toBe(false);
  });
});

describe('SSE notification filter', () => {
  it('drops notifications that precede the response (desktop-commander shape)', async () => {
    const output = await filterBlock(
      LOGGING_NOTIFICATION + LIST_CHANGED_NOTIFICATION + TOOLS_RESULT,
    );
    expect(output).toBe(TOOLS_RESULT);
  });

  it('keeps the event framing of the response untouched', async () => {
    const output = await filterBlock(TOOLS_RESULT);
    expect(output).toBe(TOOLS_RESULT);
  });

  it('recognises a notification split across chunk boundaries', async () => {
    const body =
      LOGGING_NOTIFICATION +
      TOOLS_RESULT;
    const cut = LOGGING_NOTIFICATION.indexOf('"method"');
    const response = sseResponse([body.slice(0, cut), body.slice(cut)]);
    const output = await readAll(response.body!.pipeThrough(createSseNotificationFilterStream()));
    expect(output).toBe(TOOLS_RESULT);
  });

  it('handles CRLF event separators', async () => {
    const notification = LOGGING_NOTIFICATION.replace(/\n/g, '\r\n');
    const result = TOOLS_RESULT.replace(/\n/g, '\r\n');
    const output = await filterBlock(notification + result);
    expect(output).toBe(result);
  });

  it('keeps comments, non-JSON data and JSON-RPC responses', async () => {
    const body =
      ': keep-alive\n\n' +
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"nope"}}\n\n' +
      'data: not-json\n\n';
    expect(await filterBlock(body)).toBe(body);
  });

  it('drops a notification whose data spans multiple data: lines', async () => {
    const multiLine =
      'event: message\ndata: {"jsonrpc":"2.0",\ndata: "method":"notifications/progress"}\n\n';
    expect(await filterBlock(multiLine + TOOLS_RESULT)).toBe(TOOLS_RESULT);
  });

  it('forwards an unterminated trailing block', async () => {
    const trailing = TOOLS_RESULT.trimEnd();
    expect(await filterBlock(trailing)).toBe(trailing);
  });
});

describe('stripSseNotifications', () => {
  it('returns non-SSE responses unchanged', async () => {
    const json = new Response('{"ok":true}', {
      headers: { 'content-type': 'application/json' },
    });
    expect(stripSseNotifications(json)).toBe(json);

    const empty = new Response(null, { status: 204 });
    expect(stripSseNotifications(empty)).toBe(empty);
  });

  it('filters the body while preserving the SSE content type', async () => {
    const response = sseResponse([LOGGING_NOTIFICATION, TOOLS_RESULT], {
      'content-length': '9999',
      'content-encoding': 'gzip',
    });
    const filtered = stripSseNotifications(response);

    expect(filtered.headers.get('content-type')).toBe('text/event-stream');
    expect(filtered.headers.get('content-length')).toBeNull();
    expect(filtered.headers.get('content-encoding')).toBeNull();
    expect(await readAll(filtered.body!)).toBe(TOOLS_RESULT);
  });
});
