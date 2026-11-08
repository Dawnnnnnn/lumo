import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Loader2, Plus, Server, Wifi, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { mcpRegistry, refreshExtensionProvider } from '@/lib/mcp';
import type { McpExtensionProviderConfig, McpHttpServerConfig } from '@/lib/mcp/types';
import { SettingsHeader } from './components/SettingsHeader';
import { ExtensionDialog } from './mcp/ExtensionDialog';
import { ExtensionProviderCard } from './mcp/ExtensionProviderCard';
import { ExternalServerCard } from './mcp/ExternalServerCard';
import { McpServerCard } from './mcp/McpServerCard';
import { ServerDialog } from './mcp/ServerDialog';
import { WebMcpSection } from './mcp/WebMcpSection';
import { createServerDraft, useExternalServers } from './mcp/useExternalServers';
import { useMcpPreferences } from './mcp/useMcpPreferences';
import { useMcpRegistry } from './mcp/useMcpRegistry';
import { useWebMcpSettings } from './mcp/useWebMcpSettings';

/**
 * MCP settings page.
 *
 * Composition only, mirroring `ModelSettings`: data lives in the `mcp/` hooks,
 * every card and dialog is its own component, and this file keeps just the two
 * "which draft is open" flags plus the shared expansion state. Adding a server or
 * an extension opens a dialog rather than pushing an inline form into the list,
 * so the list never reflows and the empty state keeps a single call to action.
 */
export function McpSettings() {
  const { t } = useTranslation();
  const { states, loading } = useMcpRegistry();
  const { configs, addServer, removeServer, toggleServer } = useExternalServers();
  const webmcp = useWebMcpSettings();
  const mcpPrefs = useMcpPreferences();

  const [serverDraft, setServerDraft] = useState<McpHttpServerConfig | null>(null);
  const [extensionDraft, setExtensionDraft] = useState<{ id: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());

  const builtinStates = states.filter((s) => s.info.builtin && s.info.id !== 'webmcp');
  const externalStates = states.filter(
    (s) => !s.info.builtin && s.info.transport !== 'extension',
  );
  const extensionConfigs: McpExtensionProviderConfig[] = mcpPrefs.settings?.extensionProviders ?? [];
  const extensionEntries = extensionConfigs.map((config) => ({
    config,
    state: states.find((s) => s.info.id === `ext:${config.id}`),
  }));

  const copyExtensionId = async () => {
    try {
      await navigator.clipboard.writeText(chrome.runtime.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the ID stays selectable.
    }
  };

  const addExtension = async (id: string) => {
    const current = mcpPrefs.settings;
    if (!current) return;
    await mcpPrefs.update({
      extensionProviders: [...current.extensionProviders, { id, enabled: true }],
    });
  };

  const removeExtension = async (id: string) => {
    const current = mcpPrefs.settings;
    if (!current) return;
    await mcpPrefs.update({
      extensionProviders: current.extensionProviders.filter((provider) => provider.id !== id),
    });
  };

  const toggleExtension = async (id: string, enabled: boolean) => {
    const current = mcpPrefs.settings;
    if (!current) return;
    await mcpPrefs.update({
      extensionProviders: current.extensionProviders.map((provider) =>
        provider.id === id ? { ...provider, enabled } : provider,
      ),
    });
  };

  const toggleExpanded = (id: string) => {
    setExpandedServers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleReconnect = async (serverId: string) => {
    const server = mcpRegistry.getServer(serverId);
    if (!server) return;
    await server.disconnect();
    mcpRegistry.notifyChange();
    void server.connect();
  };

  /**
   * Answer a `401` challenge from the registry's instance.
   *
   * Deliberately a capability call (`authorize?.()`) rather than `instanceof
   * ExternalMcpServer`: a class identity check silently does nothing if the
   * registry and this page ever hold different copies of the module, and the
   * symptom would be a button that ignores clicks. Built-in, WebMCP and
   * extension servers simply do not implement it.
   */
  const handleAuthorize = (serverId: string) => {
    void mcpRegistry.getServer(serverId)?.authorize?.();
  };

  /** Revoke the grant: drop stored credentials and fall back to "sign in". */
  const handleSignOut = (serverId: string) => {
    void mcpRegistry.getServer(serverId)?.signOut?.();
  };

  const webmcpTabCount = webmcp.tabStates.filter((tab) => tab.tools.length > 0).length;
  const countedStates = states.filter((s) => s.info.id !== 'webmcp');
  const totalServers = countedStates.length + webmcpTabCount;

  return (
    <div className="max-w-2xl">
      <SettingsHeader
        title={t('options.mcp.title')}
        description={t('options.mcp.description')}
      />

      {/* Summary Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="border border-border rounded-lg p-3 bg-card">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Server className="h-4 w-4" />
            <span>{t('options.mcp.servers')}</span>
          </div>
          <p className="text-2xl font-semibold mt-1">{totalServers}</p>
        </div>
        <div className="border border-border rounded-lg p-3 bg-card">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Wrench className="h-4 w-4" />
            <span>{t('options.mcp.tools')}</span>
          </div>
          <p className="text-2xl font-semibold mt-1">
            {states.reduce((sum, s) => sum + s.tools.length, 0)}
          </p>
        </div>
        <div className="border border-border rounded-lg p-3 bg-card">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Wifi className="h-4 w-4" />
            <span>{t('options.mcp.status')}</span>
          </div>
          <p className="text-2xl font-semibold mt-1">
            {countedStates.filter((s) => s.status === 'connected').length + webmcpTabCount}/
            {totalServers}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin me-2" />
          <span>{t('common.loading')}</span>
        </div>
      ) : (
        <>
          <section className="mb-8">
            <h3 className="text-sm font-medium text-muted-foreground mb-3">
              {t('options.mcp.builtinSection')}
            </h3>
            <div className="space-y-2">
              {builtinStates.map((serverState) => (
                <McpServerCard
                  key={serverState.info.id}
                  state={serverState}
                  expanded={expandedServers.has(serverState.info.id)}
                  onToggle={() => toggleExpanded(serverState.info.id)}
                />
              ))}
            </div>
          </section>

          <section className="mb-8">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-muted-foreground">
                {t('options.mcp.externalSection')}
              </h3>
              <Button variant="outline" size="sm" onClick={() => setServerDraft(createServerDraft())}>
                <Plus className="h-3.5 w-3.5 me-1" />
                {t('options.mcp.addServer')}
              </Button>
            </div>

            {externalStates.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center border border-dashed border-border rounded-lg">
                {t('options.mcp.noExternalServers')}
              </p>
            ) : (
              <div className="space-y-2">
                {externalStates.map((serverState) => (
                  <ExternalServerCard
                    key={serverState.info.id}
                    state={serverState}
                    config={configs.find((c) => c.id === serverState.info.id)}
                    expanded={expandedServers.has(serverState.info.id)}
                    onToggle={() => toggleExpanded(serverState.info.id)}
                    onReconnect={() => void handleReconnect(serverState.info.id)}
                    onAuthorize={() => handleAuthorize(serverState.info.id)}
                    onSignOut={() => handleSignOut(serverState.info.id)}
                    onDelete={() => void removeServer(serverState.info.id)}
                    onToggleEnabled={(enabled) => void toggleServer(serverState.info.id, enabled)}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="mb-8">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-muted-foreground">
                {t('options.mcp.extensions.title')}
              </h3>
              <Button variant="outline" size="sm" onClick={() => setExtensionDraft({ id: '' })}>
                <Plus className="h-3.5 w-3.5 me-1" />
                {t('options.mcp.extensions.add')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              {t('options.mcp.extensions.description')}
            </p>

            {/* The host's own id, one copy away: it is what the provider has to
                allowlist before the probe can succeed. */}
            <div className="mb-3 flex items-center gap-1.5 text-2xs text-muted-foreground">
              <span>{t('options.mcp.extensions.thisExtension')}</span>
              <code className="max-w-[22ch] truncate rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono">
                {chrome.runtime.id}
              </code>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => void copyExtensionId()}
                aria-label={t('options.mcp.extensions.copyId')}
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </Button>
            </div>

            {extensionEntries.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground border border-dashed border-border rounded-lg">
                {t('options.mcp.extensions.empty')}
              </p>
            ) : (
              <div className="space-y-2">
                {extensionEntries.map(({ config, state }) => (
                  <ExtensionProviderCard
                    key={config.id}
                    config={config}
                    state={state}
                    expanded={expandedServers.has(`ext:${config.id}`)}
                    onToggle={() => toggleExpanded(`ext:${config.id}`)}
                    onToggleEnabled={(enabled) => void toggleExtension(config.id, enabled)}
                    onRefresh={() => void refreshExtensionProvider(config.id)}
                    // Registry ids are namespaced; the raw extension id is only
                    // for `refreshExtensionProvider`, which keys by provider.
                    onAuthorize={() => handleAuthorize(`ext:${config.id}`)}
                    onRemove={() => void removeExtension(config.id)}
                  />
                ))}
              </div>
            )}
          </section>

          <WebMcpSection
            enabled={webmcp.enabled}
            tabStates={webmcp.tabStates}
            loading={webmcp.loading}
            onToggleEnabled={webmcp.toggleEnabled}
          />
        </>
      )}

      <ServerDialog
        draft={serverDraft}
        onSave={async (config) => {
          // `registerExternalServer` notifies the registry, so the new card and
          // its connecting state arrive through the subscription — no refetch,
          // and therefore no page-level loading flash.
          await addServer(config);
        }}
        onClose={() => setServerDraft(null)}
      />

      <ExtensionDialog
        draft={extensionDraft}
        configured={extensionConfigs.map((config) => config.id)}
        onSave={async (id) => {
          await addExtension(id);
        }}
        onClose={() => setExtensionDraft(null)}
      />
    </div>
  );
}
