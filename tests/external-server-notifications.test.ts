import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpHttpServerConfig } from '@/lib/mcp/types';

interface TransportConfig {
  type: 'http' | 'sse';
  url: string;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

interface ClientInit {
  transport: TransportConfig;
  onUncaughtError?: (error: unknown) => void;
}

const mocks = vi.hoisted(() => ({
  createMCPClient: vi.fn(),
}));

vi.mock('@ai-sdk/mcp', () => ({ createMCPClient: mocks.createMCPClient }));

const { ExternalMcpServer } = await import('@/lib/mcp/external-server');

const config: McpHttpServerConfig = {
  id: 'ext-http',
  name: 'Desktop Commander',
  description: '',
  transport: 'http-stream',
  url: 'http://127.0.0.1:8080/mcp',
  enabled: true,
};

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

const NOTIFICATION =
  'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"ready"}}\n\n';
const TOOLS_RESULT =
  'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n';

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    listTools: async () => ({ tools: [] }),
    tools: async () => ({}),
    close: async () => {},
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  mocks.createMCPClient.mockReset();
});

describe('ExternalMcpServer notification handling', () => {
  it('routes every transport response through the SSE notification filter', async () => {
    let transport!: TransportConfig;
    mocks.createMCPClient.mockImplementation(async ({ transport: t }: ClientInit) => {
      transport = t;
      return fakeClient();
    });

    const server = new ExternalMcpServer(config);
    await server.connect();
    expect(server.getStatus()).toBe('connected');

    globalThis.fetch = vi.fn(
      async () =>
        new Response(encoder.encode(NOTIFICATION + TOOLS_RESULT), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ) as unknown as typeof fetch;

    const response = await transport.fetch(config.url);
    expect(await response.text()).toBe(TOOLS_RESULT);
  });

  it('keeps a successful connection clean when a notification raced the handshake', async () => {
    mocks.createMCPClient.mockImplementation(async ({ onUncaughtError }: ClientInit) => {
      // The SDK reports each notification through `onUncaughtError` while
      // `connect()` is still awaiting tools; the success path must win.
      onUncaughtError?.(new Error('Unsupported message type'));
      return fakeClient({
        listTools: async () => ({
          tools: [{ name: 'get_config', description: 'Config', inputSchema: { type: 'object' } }],
        }),
        tools: async () => ({ get_config: {} }),
      });
    });

    const server = new ExternalMcpServer(config);
    await server.connect();

    expect(server.getStatus()).toBe('connected');
    expect(server.getError()).toBeUndefined();
    expect(server.getTools().map((tool) => tool.name)).toEqual(['get_config']);
  });

  it('reports a genuine failure with an error status and no stale tools', async () => {
    mocks.createMCPClient.mockRejectedValue(new Error('initialize failed'));

    const server = new ExternalMcpServer(config);
    await server.connect();

    expect(server.getStatus()).toBe('error');
    expect(server.getError()).toBe('initialize failed');
    expect(server.getTools()).toEqual([]);
  });
});
