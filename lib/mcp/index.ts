export * from './types';
export * from './registry';
export { BrowserMcpServer } from './browser-server';
export { PageInteractMcpServer } from './page-interact-server';
export { NetworkMonitorMcpServer } from './network-monitor-server';
export { DevToolsAdvancedMcpServer } from './devtools-advanced-server';
export { FileMcpServer } from './file-server';
export { ExternalMcpServer } from './external-server';
export { WebMcpServer } from './webmcp-server';
export { ExtensionMcpServer } from './extension-server';
export { refreshExtensionProvider, retryExtensionProviders } from './extension-registry';
export { MCP_PORT_NAME, PROBE_CHANNEL, PROBE_VERSION } from './extension-protocol';
export { fileStorage } from './file-storage';
export {
  baseName,
  directoryKind,
  isSystemPath,
  normalizeDirPath,
  normalizeFilePath,
  parentDirPath,
  SYSTEM_DIR_PREFIXES,
} from './file-storage';
export type {
  DirectoryKind,
  DirectoryListing,
  DirectoryRecord,
  FileMetadata,
  RestoreDirectoryEntry,
  RestoreFileEntry,
  RestoreFilesResult,
  StoredFile,
} from './file-storage';
export { inferMimeType, getPreviewCategory, getLanguageFromMime, isLikelyTextContent } from './file-storage';
export { registerMcpCollectors } from './collectors';
export {
  networkLog,
  consoleLog,
  attachedTabs,
  type NetworkRequestRecord,
  type ConsoleMessageRecord,
} from './session-store';
export { WEBMCP_SESSION_KEY } from './webmcp-messages';

import { mcpRegistry } from './registry';
import { BrowserMcpServer } from './browser-server';
import { PageInteractMcpServer } from './page-interact-server';
import { NetworkMonitorMcpServer } from './network-monitor-server';
import { DevToolsAdvancedMcpServer } from './devtools-advanced-server';
import { FileMcpServer } from './file-server';
import { ExternalMcpServer } from './external-server';
import { WebMcpServer } from './webmcp-server';
import { storage } from '@/store/storage';
import { initExtensionProviders, syncExtensionProviders } from './extension-registry';
import { normalizeMcpSettings } from './settings';
import { deleteCredentials, normalizeOAuthCredentials } from './oauth';
import type { McpHttpServerConfig, McpExternalServerConfig } from './types';

/**
 * Initialize all built-in MCP servers and connect them.
 * Safe to call multiple times - will skip if servers are already registered.
 *
 * Every trusted context (background, side panel, options) needs its own
 * registry: tools execute in whichever context runs the chat, so the tool
 * definitions must exist there. Only the shared *state* is centralised, via
 * `session-store`; the event listeners that produce it are registered once in
 * the background by `registerMcpCollectors`.
 */
export async function initBuiltinMcpServers(): Promise<void> {
  if (mcpRegistry.getAllServers().length > 0) return;

  mcpRegistry.register(new BrowserMcpServer());
  mcpRegistry.register(new PageInteractMcpServer());
  mcpRegistry.register(new NetworkMonitorMcpServer());
  mcpRegistry.register(new DevToolsAdvancedMcpServer());
  mcpRegistry.register(new FileMcpServer());

  // Register WebMCP server (reads tab states from session storage)
  // It's always registered but only provides tools when webmcpEnabled is on
  const settings = await storage.getMcpSettings();
  if (settings.webmcpEnabled) {
    const webmcpServer = new WebMcpServer(() => mcpRegistry.notifyChange());
    mcpRegistry.register(webmcpServer);
  }

  // Load and register external MCP servers from storage
  await initExternalMcpServers();

  // Register installed extension providers. They are connected by the same
  // `connectAll()` pass as every other source; the provider probe happens in
  // `ExtensionMcpServer.connect()`.
  initExtensionProviders(settings);

  await mcpRegistry.connectAll();

  // Start listening for cross-context storage changes to keep registry in sync
  setupMcpStorageSync();
}

/**
 * Load external MCP server configurations from storage and register them.
 */
async function initExternalMcpServers(): Promise<void> {
  try {
    const settings = await storage.getMcpSettings();
    for (const serverConfig of settings.servers) {
      if (serverConfig.transport === 'webmcp') continue; // WebMCP handled separately
      registerExternalServer(serverConfig);
    }
  } catch (err) {
    console.error('Failed to load external MCP servers:', err);
  }
}

/**
 * Register a single external MCP server in the registry.
 * Does not connect it - call mcpRegistry.connectAll() or server.connect() after.
 */
export function registerExternalServer(config: McpHttpServerConfig): ExternalMcpServer {
  // Unregister existing server with same ID if present
  const existing = mcpRegistry.getServer(config.id);
  if (existing) {
    mcpRegistry.unregister(config.id);
  }

  const server = new ExternalMcpServer(config, () => mcpRegistry.notifyChange());
  mcpRegistry.register(server);
  return server;
}

/**
 * Unregister an external MCP server and remove the credentials it was using.
 *
 * Tokens are per server id; leaving them behind would resurrect a session for a
 * server the user just deleted, and would keep a secret in storage forever.
 */
export function unregisterExternalServer(id: string): void {
  void deleteCredentials(id);
  mcpRegistry.unregister(id);
}

/**
 * Listen for `chrome.storage.onChanged` and keep the local registry in sync, so
 * a change made in one context (e.g. the options page) reaches the others (e.g.
 * the side panel) without a reload.
 *
 * Handles:
 * - Toggling `enabled` on/off for external servers
 * - Adding new external servers
 * - Removing external servers
 * - Toggling WebMCP on/off
 * - OAuth credentials arriving from another context's consent flow
 */
function setupMcpStorageSync(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!changes.mcpSettings) return;

    const newSettings = changes.mcpSettings.newValue as
      | Parameters<typeof normalizeMcpSettings>[0]
      | undefined;

    if (!newSettings) return;

    const settings = normalizeMcpSettings(newSettings);
    syncExternalServers(settings.servers);
    syncWebMcpServer(settings.webmcpEnabled);
    syncExtensionProviders(settings);
  });

  // OAuth credentials are written by whichever context ran the consent flow;
  // every other context holds a server instance stuck in `unauthorized`. Tokens
  // landing is the signal to retry there, so the side panel connects without a
  // reload after the options page authorizes.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const credentials = changes.mcpOAuthCredentials;
    if (!credentials) return;
    void reconnectAuthorizedServers(credentials.newValue);
  });
}

/**
 * Retry servers whose credentials were just refreshed elsewhere.
 *
 * Only servers that are stuck (unauthorized/error) are retried: a connected
 * server already has a live session, and one that is connecting may be the very
 * flow that wrote the token — reconnecting it would close its own client.
 */
async function reconnectAuthorizedServers(rawCredentials: unknown): Promise<void> {
  const credentials = normalizeOAuthCredentials(rawCredentials);
  for (const server of mcpRegistry.getAllServers()) {
    const info = server.getInfo();
    // Only servers with an OAuth grant can be waiting for credentials; built-in
    // and extension providers answer `info.transport`.
    if (info.builtin || info.transport === 'webmcp' || info.transport === 'extension') continue;
    if (!info.enabled) continue;
    if (server.getStatus() !== 'unauthorized' && server.getStatus() !== 'error') continue;
    if (!credentials[info.id]?.tokens?.access_token) continue;
    void server.connect();
  }
}

/**
 * Reconcile the local registry's external servers with the latest storage state.
 */
async function syncExternalServers(
  latestConfigs: McpExternalServerConfig[],
): Promise<void> {
  // Filter out WebMCP configs - they are handled separately
  const httpConfigs = latestConfigs.filter(
    (c): c is McpHttpServerConfig => c.transport !== 'webmcp',
  );

  const latestById = new Map(httpConfigs.map((c) => [c.id, c]));

  // 1. Handle servers that currently exist in the registry
  for (const server of mcpRegistry.getAllServers()) {
    const info = server.getInfo();
    // Skip built-in servers and extension providers: the former are not in
    // `mcpSettings.servers`, and the latter are reconciled by
    // `syncExtensionProviders`.
    if (info.builtin || info.transport === 'extension') continue;

    const latestConfig = latestById.get(info.id);

    if (!latestConfig) {
      // Server was removed in settings → unregister locally and forget the
      // credentials the user granted it.
      mcpRegistry.unregister(info.id);
      void deleteCredentials(info.id);
      continue;
    }

    // Server still exists — check if enabled state changed
    if (typeof (server as { updateConfig?: unknown }).updateConfig === 'function') {
      const currentEnabled = info.enabled;
      const newEnabled = latestConfig.enabled;

      if (currentEnabled !== newEnabled) {
        (server as unknown as { updateConfig(config: McpHttpServerConfig): void }).updateConfig(
          latestConfig,
        );

        if (newEnabled) {
          // Was disabled, now enabled → connect
          server.connect();
        } else {
          // Was enabled, now disabled → disconnect
          server.disconnect();
        }
      }
    }
  }

  // 2. Handle newly added servers (exist in settings but not in registry)
  for (const config of httpConfigs) {
    if (!mcpRegistry.getServer(config.id)) {
      const server = registerExternalServer(config);
      if (config.enabled) {
        server.connect();
      }
    }
  }

  mcpRegistry.notifyChange();
}

/**
 * Synchronize the WebMCP server registration based on the webmcpEnabled setting.
 */
function syncWebMcpServer(enabled: boolean): void {
  const existing = mcpRegistry.getServer('webmcp');

  if (enabled && !existing) {
    // WebMCP was just enabled - register and connect the server
    const webmcpServer = new WebMcpServer(() => mcpRegistry.notifyChange());
    mcpRegistry.register(webmcpServer);
    webmcpServer.connect();
    mcpRegistry.notifyChange();
  } else if (!enabled && existing) {
    // WebMCP was just disabled - unregister the server
    mcpRegistry.unregister('webmcp');
    mcpRegistry.notifyChange();
  }
}
