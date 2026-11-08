/**
 * WebMCP Content Script - ISOLATED world
 *
 * This content script acts as a bridge between the MAIN world (where
 * document.modelContext lives) and the extension's background service worker.
 *
 * Architecture:
 * - Background injects the polyfill + monitor into MAIN world
 * - MAIN world script communicates tool changes via window.postMessage
 * - This ISOLATED world script relays messages to/from the background
 *
 * Orphaning is the dominant failure mode here, not tool execution. A content
 * script outlives the extension that injected it: reloading, updating or
 * disabling the extension leaves this listener attached to a live page with a
 * dead `chrome.runtime`. `disableWebMcp` only unregisters *future* injections,
 * so every already-open tab keeps an orphaned bridge until it navigates.
 * Everything below is written on the assumption that `chrome.*` can stop
 * working at any moment, mid-session, with the page still running.
 *
 * Why `defineUnlistedScript` and not `defineContentScript`:
 *
 * WXT picks an entrypoint's type from its *file name*. A content script has to
 * be `content.ts` or `*.content.ts`; this file matches neither, so WXT builds it
 * as an unlisted script and calls `main()` with **no arguments**. Declaring it
 * as a content script therefore hands you a `ctx` that is always `undefined` —
 * a crash on startup, on every page. Using the honest wrapper also drops the
 * `matches` / `runAt` / `registration` keys that used to sit here, which WXT
 * ignored entirely for this entrypoint: the real registration is hand-written in
 * `webmcp-manager.ts`, and having them here implied otherwise.
 *
 * The cost is that there is no `ContentScriptContext`, so invalidation has to be
 * detected rather than subscribed to — see `isOrphaned`.
 */
import { isWebMcpContentMessage } from '@/lib/mcp/webmcp-messages';
import {
  WEBMCP_DEFAULT_TIMEOUT_MS,
  clampWebMcpTimeoutMs,
} from '@/lib/mcp/webmcp-timeout';

export default defineUnlistedScript(() => {
  // `enableWebMcp` both registers the script *and* injects it into open tabs,
  // so the same file lands in one document twice on the enabling pass. Two
  // bridges relay every message twice and, worse, both answer the same
  // `sendResponse` — Chrome closes the port after the first, turning a
  // successful tool call into "message port closed".
  const guard = window as typeof window & { __lumoWebmcpBridgeReady?: boolean };
  if (guard.__lumoWebmcpBridgeReady) return;
  guard.__lumoWebmcpBridgeReady = true;

  /**
   * Whether this script has been orphaned.
   *
   * `chrome.runtime.id` reads `undefined` once the extension that injected us is
   * gone, while the rest of `chrome.runtime` stays superficially present. This is
   * exactly the check WXT's own `ContentScriptContext.isInvalid` performs; we do
   * it inline because an unlisted script is handed no context.
   */
  const isOrphaned = (): boolean => {
    try {
      return chrome.runtime?.id == null;
    } catch {
      // Touching `chrome.runtime` can itself throw once the context is gone.
      return true;
    }
  };

  /**
   * Relay to the background, surviving an invalidated context.
   *
   * `chrome.runtime.sendMessage` throws *synchronously* when the context is
   * gone; it does not return a rejected promise. A bare `.catch()` therefore
   * never runs and the error escapes the `message` listener as an uncaught
   * "Extension context invalidated." — one per page event, forever.
   */
  const relay = (message: unknown): void => {
    if (isOrphaned()) {
      // Nothing left to relay to, and nothing will bring it back. Shut down so
      // a page that keeps posting stops driving dead API calls.
      detach();
      return;
    }
    try {
      void chrome.runtime.sendMessage(message)?.catch(() => {
        // Background asleep or no listener registered yet. Tool reports are
        // re-sent on the next change, so dropping one is harmless.
      });
    } catch {
      // Context died between the check above and the call.
      detach();
    }
  };

  const onPageMessage = (event: MessageEvent) => {
    if (event.source !== window) return;
    // The MAIN world is the page's own world: anything on the page can post
    // a `webmcp:`-prefixed message. Validate the shape before relaying.
    if (!isWebMcpContentMessage(event.data)) return;
    relay(event.data);
  };

  const onBackgroundMessage = (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    if (!message || typeof message !== 'object') return false;
    const type = (message as { type?: unknown }).type;
    if (typeof type !== 'string' || !type.startsWith('webmcp:')) return false;

    if (type === 'webmcp:shutdown') {
      // Feature switched off. Detach now rather than waiting to be orphaned
      // by a reload; the MAIN world stops reporting once it sees bridge-gone.
      sendResponse({ ok: true });
      detach();
      return false;
    }

    if (type === 'webmcp:request-tools') {
      // Forward to MAIN world
      window.postMessage(
        { type: 'webmcp:request-tools', source: 'lumo-extension' },
        '*',
      );
      sendResponse({ ok: true });
      return false;
    }

    if (type === 'webmcp:execute-tool') {
      const { executionId, toolName, args, timeoutMs } = message as {
        executionId: string;
        toolName: string;
        args: string;
        timeoutMs?: number;
      };

      // The MAIN world may never answer — the page can navigate, or the tool
      // can hang. The budget comes from the caller (defaulted and clamped in
      // `webmcp-timeout.ts`), so a long-running page tool is not cut at a
      // number the page itself never asked for.
      const budgetMs =
        typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
          ? clampWebMcpTimeoutMs(timeoutMs)
          : WEBMCP_DEFAULT_TIMEOUT_MS;
      let settled = false;
      const finish = (response: unknown) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', handler);
        clearTimeout(timer);
        try {
          sendResponse(response);
        } catch {
          // Port already closed (background restarted mid-call).
        }
      };

      const handler = (event: MessageEvent) => {
        if (event.source !== window) return;
        if (!event.data || typeof event.data !== 'object') return;
        if (event.data.type !== 'webmcp:execute-result') return;
        if (event.data.executionId !== executionId) return;

        finish({
          success: event.data.success,
          result: event.data.result,
          error: event.data.error,
        });
      };

      const timer = setTimeout(() => {
        finish({
          success: false,
          error: `WebMCP page script did not respond within ${budgetMs}ms`,
        });
      }, budgetMs);

      window.addEventListener('message', handler);

      // Forward to MAIN world
      window.postMessage(
        {
          type: 'webmcp:execute-tool',
          source: 'lumo-extension',
          executionId,
          toolName,
          args,
        },
        '*',
      );

      // Return true to indicate async response
      return true;
    }

    return false;
  };

  /**
   * Stop doing work entirely, rather than merely swallowing errors.
   *
   * Also clears the handshake flag so a freshly injected bridge can take over
   * this document, and tells the MAIN world to stop reporting — an orphaned
   * page that keeps posting is what turned one extension reload into an
   * uncaught error on every SPA route change.
   */
  let detached = false;
  function detach(): void {
    if (detached) return;
    detached = true;
    window.removeEventListener('message', onPageMessage);
    guard.__lumoWebmcpBridgeReady = false;
    try {
      chrome.runtime.onMessage.removeListener(onBackgroundMessage);
    } catch {
      // Context already gone; the listener died with it.
    }
    window.postMessage(
      { type: 'webmcp:bridge-gone', source: 'lumo-extension' },
      '*',
    );
  }

  window.addEventListener('message', onPageMessage);
  try {
    chrome.runtime.onMessage.addListener(onBackgroundMessage);
  } catch {
    // Injected into an already-dead context. Nothing to bridge.
    detach();
    return;
  }

  // Notify that bridge is ready
  window.postMessage(
    { type: 'webmcp:bridge-ready', source: 'lumo-extension' },
    '*',
  );
});
