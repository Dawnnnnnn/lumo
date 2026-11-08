import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@/assets/globals.css';
import '@/i18n';
import { bootstrapPage } from '@/lib/page-bootstrap';
import { initBuiltinMcpServers } from '@/lib/mcp';
import { installExtensionRetry } from '@/lib/mcp/extension-retry';

/**
 * Last-resort visibility for rejections nothing else caught.
 *
 * A quota failure on the send path used to surface only as
 * `Uncaught (in promise) Error: Resource::kQuotaBytes quota exceeded`, with no
 * indication of which operation had died. The individual call sites now handle
 * their own failures; this keeps anything still slipping through attributable.
 */
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Lumo] Unhandled promise rejection:', event.reason);
});

/**
 * Started before the first render and intentionally *not* awaited.
 *
 * External MCP servers are connected over the network with no timeout, so
 * awaiting this left the panel blank for as long as an unreachable server took
 * to fail. Tools are only needed once a message is sent, which is necessarily
 * after the UI is interactive; consumers read the registry through
 * `mcpRegistry.subscribe`, so servers appear as they connect.
 */
void initBuiltinMcpServers().catch((error) => {
  console.error('[Lumo] Failed to initialize MCP servers:', error);
});

/**
 * Approving an extension provider happens in that extension's own settings tab.
 * When the user returns to the panel, retry providers that are still waiting so
 * the tool list recovers without a manual Reconnect. Shared with the options
 * page so both notice a grant the same way — see `lib/mcp/extension-retry.ts`.
 */
installExtensionRetry();

// The legacy `conversations` key is dropped by the background script, which runs
// before any extension page — see `entrypoints/background.ts`.
bootstrapPage().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
