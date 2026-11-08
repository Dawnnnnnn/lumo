import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpExtensionProviderConfig } from '@/lib/mcp/types';

interface FakeTransport {
  isClosed: boolean;
  onclose?: () => void;
  onDisconnect?: () => void;
  close: () => Promise<void>;
}

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  authorize: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  createClient: vi.fn(),
  transports: [] as FakeTransport[],
}));

vi.mock('@/lib/mcp/extension-probe', () => ({
  probeExtension: mocks.probe,
  authorizeExtension: mocks.authorize,
}));
vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: async ({ transport }: { transport: FakeTransport }) => {
    mocks.createClient();
    // Match @ai-sdk/mcp: the client owns `transport.onclose`.
    transport.onclose = () => {};
    return {
      initializeResult: {},
      listTools: mocks.listTools,
      callTool: mocks.callTool,
      close: async () => {},
    };
  },
}));
vi.mock('@/lib/mcp/transports/chrome-port', () => ({
  ChromePortTransport: {
    connect: () => {
      const transport: FakeTransport = {
        isClosed: false,
        onclose: undefined,
        onDisconnect: undefined,
        close: async () => {
          transport.isClosed = true;
        },
      };
      mocks.transports.push(transport);
      return transport;
    },
  },
}));

const { ExtensionMcpServer } = await import('@/lib/mcp/extension-server');

const EXT_A = 'a'.repeat(32);

const config: McpExtensionProviderConfig = { id: EXT_A, enabled: true };

function probeOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    response: {
      ok: true,
      service: { namespace: 'userscripts', name: 'Lumo Userscripts', version: '0.1.0' },
      status: { enabled: true, authorized: true, ready: true },
      ...overrides,
    },
  };
}

beforeEach(() => {
  mocks.transports.length = 0;
  mocks.createClient.mockClear();
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'b'.repeat(32),
      getManifest: () => ({ version: '0.1.0' }),
      connect: () => ({}),
    },
  });
  mocks.probe.mockResolvedValue(probeOk());
  mocks.authorize.mockResolvedValue(probeOk());
  mocks.listTools.mockResolvedValue({
    tools: [
      {
        name: 'list',
        description: 'List scripts',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get',
        description: 'Get a script',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  });
  mocks.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ExtensionMcpServer', () => {
  it('namespaces tools under the provider service', async () => {
    const server = new ExtensionMcpServer(config);
    await server.connect();

    expect(server.getStatus()).toBe('connected');
    expect(server.getTools().map((tool) => tool.name)).toEqual([
      'userscripts_list',
      'userscripts_get',
    ]);
    expect(Object.keys(server.getAITools())).toEqual(['userscripts_list', 'userscripts_get']);
    expect(server.getInfo().transport).toBe('extension');
  });

  it('reconnects when the port closes under a live session', async () => {
    const server = new ExtensionMcpServer(config);
    await server.connect();
    expect(mocks.createClient).toHaveBeenCalledTimes(1);

    // The provider's service worker went idle: the physical port is closed, but
    // the server still holds the previous client and tool list.
    mocks.transports[0]!.isClosed = true;

    const aiTool = server.getAITools().userscripts_list as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };
    await aiTool.execute({}, { toolCallId: '1', messages: [] });

    expect(mocks.createClient).toHaveBeenCalledTimes(2);
    expect(server.getStatus()).toBe('connected');
    expect(mocks.callTool).toHaveBeenCalledWith({ name: 'list', arguments: {} });
  });

  it('routes tool calls to the provider local name', async () => {
    const server = new ExtensionMcpServer(config);
    await server.connect();

    const aiTool = server.getAITools().userscripts_list as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };
    const result = await aiTool.execute({}, { toolCallId: '1', messages: [] });

    expect(mocks.callTool).toHaveBeenCalledWith({ name: 'list', arguments: {} });
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('connects with the read-only probe, and never with the authorize message', async () => {
    const server = new ExtensionMcpServer(config);
    await server.connect();

    // `lumo:probe` is what keeps startup / settings writes / focus retries from
    // opening the provider's own settings tab.
    expect(mocks.probe).toHaveBeenCalledWith(EXT_A);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it('waits for approval instead of failing when the provider says no', async () => {
    mocks.probe.mockResolvedValue(
      probeOk({ status: { enabled: true, authorized: false, ready: true } }),
    );
    const server = new ExtensionMcpServer(config);
    await server.connect();

    // Not `error`: nothing is broken, a person has to decide.
    expect(server.getStatus()).toBe('unauthorized');
    expect(server.getAuthError()).toEqual({ reason: 'extension-approval' });
    expect(server.getError()).toBeUndefined();
    expect(server.getInfo().name).toBe('Lumo Userscripts');
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('drops the cached tool surface when the grant is gone', async () => {
    const server = new ExtensionMcpServer(config);
    await server.connect();
    expect(server.getTools()).toHaveLength(2);

    // The provider revokes access while the cached session is still alive.
    mocks.probe.mockResolvedValue(
      probeOk({ status: { enabled: true, authorized: false, ready: true } }),
    );
    mocks.transports[0]!.isClosed = true;
    await server.connect();

    expect(server.getStatus()).toBe('unauthorized');
    expect(server.getTools()).toEqual([]);
    expect(server.getAITools()).toEqual({});
  });

  it('distinguishes a pending request from a refusal in the reason it carries', async () => {
    mocks.probe.mockResolvedValue(
      probeOk({
        status: { enabled: true, authorized: false, ready: true, pendingApproval: true },
      }),
    );
    const server = new ExtensionMcpServer(config);
    await server.connect();

    expect(server.getStatus()).toBe('unauthorized');
    expect(server.getAuthError()).toEqual({ reason: 'extension-approval' });
  });

  it('uses the authorize message in `authorize`, then connects once approved', async () => {
    // The probe is refused; `authorize` is the user's explicit request, and the
    // provider answers it after the approval it triggered.
    mocks.probe.mockResolvedValue(
      probeOk({ status: { enabled: true, authorized: false, ready: true } }),
    );

    const server = new ExtensionMcpServer(config);
    await server.connect();
    expect(server.getStatus()).toBe('unauthorized');

    await server.authorize();

    expect(mocks.authorize).toHaveBeenCalledWith(EXT_A);
    expect(server.getStatus()).toBe('connected');
    expect(server.getAuthError()).toBeUndefined();
  });

  it('stays waiting after `authorize` while the user has not approved yet', async () => {
    mocks.authorize.mockResolvedValue(
      probeOk({ status: { enabled: true, authorized: false, ready: true } }),
    );

    const server = new ExtensionMcpServer(config);
    await server.authorize();

    expect(server.getStatus()).toBe('unauthorized');
    // The grant is picked up by the retry-on-focus, not by this call.
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('reports a provider that does not speak the authorize message yet', async () => {
    // An older provider has no `lumo:authorize` listener: the send rejects.
    mocks.authorize.mockResolvedValue({
      ok: false,
      unreachable: true,
      error: 'Could not establish connection. Receiving end does not exist.',
    });

    const server = new ExtensionMcpServer(config);
    await server.authorize();

    expect(server.getStatus()).toBe('error');
    expect(server.getError()).toContain('no approval endpoint');
  });

  it('asks for approval when the provider\'s agent switch is off', async () => {
    // Off is not broken: `approvePendingRequest` enables it and allowlists the
    // host in one click, so the card offers that click instead of an error.
    mocks.probe.mockResolvedValue(
      probeOk({ status: { enabled: false, authorized: true, ready: true } }),
    );
    const server = new ExtensionMcpServer(config);
    await server.connect();

    expect(server.getStatus()).toBe('unauthorized');
    expect(server.getAuthError()).toEqual({ reason: 'extension-approval' });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('reports an unreachable extension', async () => {
    mocks.probe.mockResolvedValue({ ok: false, error: 'nope', unreachable: true });
    const server = new ExtensionMcpServer(config);
    await server.connect();

    expect(server.getStatus()).toBe('error');
    expect(server.getError()).toContain('not installed');
  });
});
