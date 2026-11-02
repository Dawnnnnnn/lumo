// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { McpSettings as McpSettingsRecord, McpServerState } from '@/lib/mcp/types';

/**
 * Wire-level cover for the MCP page: the list never reflows while adding, the
 * dialog is the only place a form exists, and a save reaches both storage and the
 * registry. The dialog internals are covered in `mcp-settings-dialog.test.tsx`;
 * here the concern is composition — that the page wires the two together.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let settings: McpSettingsRecord;
const setMcpSettings = vi.fn(async (next: McpSettingsRecord) => {
  settings = next;
});
const registerExternalServer = vi.fn((config: { id: string }) => ({
  connect: vi.fn(async () => {}),
  // The page now answers an authorization challenge right after a save, so the
  // fake needs the whole small surface that path touches.
  getStatus: () => 'disconnected',
  authorize: vi.fn(),
  getConfig: () => config,
}));
const states: McpServerState[] = [];
const listeners = new Set<() => void>();

vi.mock('@/store/storage', () => ({
  storage: {
    getMcpSettings: async () => structuredClone(settings),
    setMcpSettings: (next: McpSettingsRecord) => setMcpSettings(next),
  },
}));

vi.mock('@/lib/mcp', () => ({
  mcpRegistry: {
    getAllServers: () => [],
    getAllStates: () => states,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notifyChange: () => listeners.forEach((listener) => listener()),
    getServer: () => undefined,
  },
  initBuiltinMcpServers: async () => {},
  registerExternalServer: (config: { id: string }) => registerExternalServer(config),
  unregisterExternalServer: () => {},
  ExternalMcpServer: class {},
  refreshExtensionProvider: async () => {},
  WEBMCP_SESSION_KEY: 'webmcpTabs',
}));

const { McpSettings } = await import('@/entrypoints/options/McpSettings');

beforeEach(() => {
  vi.clearAllMocks();
  settings = {
    servers: [],
    extensionProviders: [],
    webmcpEnabled: false,
    disabledBuiltins: [],
  } as McpSettingsRecord;
  vi.stubGlobal('chrome', {
    runtime: { id: 'a'.repeat(32) },
    storage: {
      session: { get: async () => ({}) },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  });
});

afterEach(cleanup);

const ADD_SERVER = 'options.mcp.addServer';
const ADD_EXTENSION = 'options.mcp.extensions.add';

describe('McpSettings composition', () => {
  it('keeps the list in place and opens a dialog for the new server', async () => {
    render(<McpSettings />);

    await screen.findByText('options.mcp.noExternalServers');
    // The empty state stays put: the form no longer occupies list space.
    fireEvent.click(screen.getByRole('button', { name: ADD_SERVER }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: ADD_SERVER })).toBeTruthy();
    expect(screen.getByText('options.mcp.noExternalServers')).toBeTruthy();
  });

  it('persists a server submitted through the dialog and closes it', async () => {
    render(<McpSettings />);
    await screen.findByText('options.mcp.noExternalServers');

    fireEvent.click(screen.getByRole('button', { name: ADD_SERVER }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('options.mcp.serverName', { exact: false }), {
      target: { value: 'Docs' },
    });
    fireEvent.change(within(dialog).getByLabelText('options.mcp.serverUrl', { exact: false }), {
      target: { value: 'https://example.com/mcp' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: ADD_SERVER }));

    await waitFor(() => expect(registerExternalServer).toHaveBeenCalledTimes(1));
    expect(setMcpSettings).toHaveBeenCalledTimes(1);
    expect(settings.servers).toHaveLength(1);
    expect(settings.servers[0]).toMatchObject({
      name: 'Docs',
      url: 'https://example.com/mcp',
      enabled: true,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens the extension dialog from the section header', async () => {
    render(<McpSettings />);
    await screen.findByText('options.mcp.extensions.empty');

    fireEvent.click(screen.getByRole('button', { name: ADD_EXTENSION }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('options.mcp.extensions.idLabel', { exact: false })).toBeTruthy();
  });

  it('persists a valid extension id', async () => {
    render(<McpSettings />);
    await screen.findByText('options.mcp.extensions.empty');

    fireEvent.click(screen.getByRole('button', { name: ADD_EXTENSION }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('options.mcp.extensions.idLabel', { exact: false }), {
      target: { value: 'b'.repeat(32) },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: ADD_EXTENSION }));

    await waitFor(() => expect(setMcpSettings).toHaveBeenCalledTimes(1));
    expect(settings.extensionProviders).toEqual([{ id: 'b'.repeat(32), enabled: true }]);
  });
});
