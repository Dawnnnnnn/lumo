import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpHttpServerConfig } from '@/lib/mcp/types';

interface TransportConfig {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

interface ClientInit {
  transport: TransportConfig;
  protocolVersionDiscovery?: boolean;
  onUncaughtError?: (error: unknown) => void;
}

const mocks = vi.hoisted(() => ({
  createMCPClient: vi.fn(),
  resolveEra: vi.fn(),
  rememberEra: vi.fn(),
  forgetEra: vi.fn(),
}));

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: mocks.createMCPClient,
  auth: vi.fn(),
  UnauthorizedError: class UnauthorizedError extends Error {},
  MCPClientOAuthError: Object.assign(class MCPClientOAuthError extends Error {}, {
    isInstance: () => false,
  }),
}));
vi.mock('@/lib/mcp/protocol-era-store', () => ({
  resolveEra: mocks.resolveEra,
  rememberEra: mocks.rememberEra,
  forgetEra: mocks.forgetEra,
}));

const { ExternalMcpServer } = await import('@/lib/mcp/external-server');

const config: McpHttpServerConfig = {
  id: 'ext-exa',
  name: 'Exa',
  description: '',
  transport: 'http-stream',
  url: 'https://mcp.exa.ai/mcp',
  enabled: true,
};

/** The rejection a legacy server returns to the SDK's modern probe. */
const LEGACY_PROBE_ERROR = {
  name: 'AI_MCPClientError',
  message: 'MCP HTTP Transport Error: POSTing to endpoint (HTTP 400): Unsupported protocol version',
  statusCode: 400,
  responseBody:
    '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Unsupported protocol version: 2026-07-28"},"id":null}',
};

/** The rejection a modern server returns when a legacy client sends `initialize`. */
const MODERN_VERSION_ERROR = {
  name: 'AI_MCPClientError',
  message: 'Unsupported protocol version',
  statusCode: 400,
  code: -32022,
  responseBody:
    '{"jsonrpc":"2.0","id":1,"error":{"code":-32022,"message":"Unsupported protocol version","data":{"supported":["2026-07-28"]}}}',
};

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    initializeResult: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      serverInfo: { name: 'exa-search-server', version: '3.5.0' },
    },
    listTools: async () => ({ tools: [{ name: 'web_search_exa', inputSchema: { type: 'object' } }] }),
    tools: async () => ({ web_search_exa: {} }),
    close: async () => {},
    ...overrides,
  };
}

function lastInit(): ClientInit {
  const calls = mocks.createMCPClient.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error('createMCPClient was never called');
  return last[0] as ClientInit;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('ExternalMcpServer protocol era', () => {
  it('sends a known-legacy server straight to the initialize handshake', async () => {
    mocks.resolveEra.mockResolvedValue('legacy');
    mocks.createMCPClient.mockResolvedValue(fakeClient());

    const server = new ExternalMcpServer(config);
    await server.connect();

    // Discovery is the one thing a legacy server rejects, so it is not attempted.
    expect(lastInit().protocolVersionDiscovery).toBe(false);
    expect(server.getStatus()).toBe('connected');
    expect(server.getError()).toBeUndefined();
    // The negotiated revision is what the UI reports, not what we asked for.
    expect(server.getInfo().protocolVersion).toBe('2025-11-25');
  });

  it('leaves the decision to the SDK when the era is unknown', async () => {
    mocks.resolveEra.mockResolvedValue(undefined);
    mocks.createMCPClient.mockResolvedValue(fakeClient());

    const server = new ExternalMcpServer(config);
    await server.connect();

    expect(lastInit().protocolVersionDiscovery).toBe(true);
    expect(server.getStatus()).toBe('connected');
  });

  it('does not resolve an era for the deprecated HTTP+SSE transport', async () => {
    mocks.createMCPClient.mockResolvedValue(fakeClient());

    const server = new ExternalMcpServer({ ...config, transport: 'sse', url: 'https://old.test/sse' });
    await server.connect();

    expect(mocks.resolveEra).not.toHaveBeenCalled();
    expect(lastInit().protocolVersionDiscovery).toBe(true);
    expect(server.getStatus()).toBe('connected');
  });

  it('learns the era from a probe the SDK reports as an uncaught error, without failing', async () => {
    mocks.resolveEra.mockResolvedValue(undefined);
    mocks.createMCPClient.mockImplementation(async (init: ClientInit) => {
      // The transport emits the rejection while `createMCPClient()` is still in
      // flight; the SDK then falls back to `initialize` and connects.
      init.onUncaughtError?.(LEGACY_PROBE_ERROR);
      return fakeClient();
    });

    const server = new ExternalMcpServer(config);
    await server.connect();

    expect(mocks.rememberEra).toHaveBeenCalledWith(config.url, 'legacy');
    // The server is connected — the 400 must not be reported as a failure.
    expect(server.getStatus()).toBe('connected');
    expect(server.getError()).toBeUndefined();
  });

  it('never lets a late transport event overwrite a settled connection', async () => {
    mocks.resolveEra.mockResolvedValue(undefined);
    mocks.createMCPClient.mockResolvedValue(fakeClient());

    const server = new ExternalMcpServer(config);
    await server.connect();

    const { onUncaughtError } = lastInit();
    // An SSE reconnection failure, a dropped session, or a replayed probe
    // rejection can all arrive after the handshake finished.
    onUncaughtError?.(LEGACY_PROBE_ERROR);
    onUncaughtError?.(new Error('GET SSE failed: 502'));

    expect(server.getStatus()).toBe('connected');
    expect(server.getError()).toBeUndefined();
    expect(server.getTools()).toHaveLength(1);
    // A settled connection is not a moment to learn a verdict from.
    expect(mocks.rememberEra).not.toHaveBeenCalled();
  });

  it('still reports a genuine handshake failure', async () => {
    mocks.resolveEra.mockResolvedValue(undefined);
    mocks.createMCPClient.mockRejectedValue(new Error('initialize failed'));

    const server = new ExternalMcpServer(config);
    await server.connect();

    expect(server.getStatus()).toBe('error');
    expect(server.getError()).toBe('initialize failed');
    expect(server.getTools()).toEqual([]);
    expect(server.getInfo().protocolVersion).toBeUndefined();
  });

  it('re-probes when a cached legacy verdict stops working', async () => {
    mocks.resolveEra.mockResolvedValue('legacy');
    mocks.createMCPClient
      .mockRejectedValueOnce(MODERN_VERSION_ERROR)
      .mockResolvedValueOnce(fakeClient({ initializeResult: { protocolVersion: '2026-07-28', capabilities: {}, serverInfo: { name: 'upgraded', version: '1.0.0' } } }));

    const server = new ExternalMcpServer(config);
    await server.connect();

    // The server was upgraded to a modern revision and no longer accepts
    // `initialize`: the stale verdict is dropped and discovery is re-enabled.
    expect(mocks.forgetEra).toHaveBeenCalledWith(config.url);
    expect(mocks.createMCPClient).toHaveBeenCalledTimes(2);
    expect(mocks.createMCPClient.mock.calls[0]?.[0]).toMatchObject({ protocolVersionDiscovery: false });
    expect(mocks.createMCPClient.mock.calls[1]?.[0]).toMatchObject({ protocolVersionDiscovery: true });
    expect(server.getStatus()).toBe('connected');
    expect(server.getInfo().protocolVersion).toBe('2026-07-28');
  });

  it('passes configured headers to the era probe', async () => {
    mocks.resolveEra.mockResolvedValue(undefined);
    mocks.createMCPClient.mockResolvedValue(fakeClient());

    const server = new ExternalMcpServer({ ...config, headers: { 'x-api-key': 'secret' } });
    await server.connect();

    const resolveInit = mocks.resolveEra.mock.calls[0]?.[1] as { headers?: Record<string, string> };
    expect(resolveInit.headers).toEqual({ 'x-api-key': 'secret' });
  });
});
