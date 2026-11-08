import { mcpRegistry } from './registry';
import { ExtensionMcpServer } from './extension-server';
import type { McpSettings } from './types';

/** One server instance per configured extension, keyed by extension ID. */
const servers = new Map<string, ExtensionMcpServer>();

function registryId(extensionId: string): string {
  return `ext:${extensionId}`;
}

/**
 * Register every configured extension provider.
 *
 * Registration only; `mcpRegistry.connectAll()` opens the sessions. Called from
 * `initBuiltinMcpServers`, which runs once per trusted context (background,
 * side panel, options).
 */
export function initExtensionProviders(settings: McpSettings): void {
  for (const config of settings.extensionProviders) {
    if (servers.has(config.id)) continue;
    const server = new ExtensionMcpServer(config, () => mcpRegistry.notifyChange());
    servers.set(config.id, server);
    mcpRegistry.register(server);
  }
}

/**
 * Reconcile the registry with the latest settings.
 *
 * Only membership and the enabled flag trigger work. Toggling an unrelated MCP
 * preference (e.g. instruction injection) must not re-probe every provider.
 */
export function syncExtensionProviders(settings: McpSettings): void {
  const wanted = new Set(settings.extensionProviders.map((config) => config.id));

  for (const [id, server] of servers) {
    if (wanted.has(id)) continue;
    servers.delete(id);
    mcpRegistry.unregister(registryId(id));
  }

  for (const config of settings.extensionProviders) {
    const existing = servers.get(config.id);
    if (!existing) {
      const server = new ExtensionMcpServer(config, () => mcpRegistry.notifyChange());
      servers.set(config.id, server);
      mcpRegistry.register(server);
      if (config.enabled) void server.connect();
      continue;
    }

    const wasEnabled = existing.getInfo().enabled;
    existing.updateConfig(config);
    if (!config.enabled && wasEnabled) {
      void existing.disconnect();
    } else if (config.enabled && !wasEnabled) {
      void existing.connect();
    }
  }

  mcpRegistry.notifyChange();
}

/**
 * Retry every enabled provider that is not currently connected.
 *
 * Called when the side panel regains focus: approving the host happens in
 * another extension's tab, so the panel must notice on return without asking
 * the user to press Reconnect.
 */
export function retryExtensionProviders(): void {
  for (const server of servers.values()) {
    if (!server.getInfo().enabled) continue;
    const status = server.getStatus();
    // `authorizing` is an explicit request already in flight from the card's
    // button; racing it with a retry would double-probe the provider.
    if (status === 'connected' || status === 'connecting' || status === 'authorizing') continue;
    void server.connect();
  }
}

/** Re-probe one provider (the settings card's refresh action). */
export async function refreshExtensionProvider(extensionId: string): Promise<void> {
  const server = servers.get(extensionId);
  if (!server) return;
  await server.disconnect();
  await server.connect();
  mcpRegistry.notifyChange();
}

/** Current server instance for one extension, if configured. */
export function getExtensionProvider(extensionId: string): ExtensionMcpServer | undefined {
  return servers.get(extensionId);
}
