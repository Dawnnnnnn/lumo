import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@/assets/globals.css';
import '@/i18n';
import { bootstrapPage } from '@/lib/page-bootstrap';
import { installExtensionRetry } from '@/lib/mcp/extension-retry';

/**
 * Approving an extension provider happens in that extension's own settings tab.
 * The options page shows the same provider cards the side panel does, so it has
 * to recover from a grant the same way: one shared, throttled retry instead of a
 * per-page copy. Without it, returning from the approval tab left the card on
 * "waiting for approval" until the user found the Reconnect button.
 */
installExtensionRetry();

// The options page used to only `import '@/i18n'`, which initialises i18next
// from the *browser* language and skips the stored preference. A user who chose
// 中文 in this page would therefore see it revert to English the next time they
// opened it. `bootstrapPage()` applies the persisted language (and theme, font)
// before the first frame, exactly as the side panel already does.
bootstrapPage().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
