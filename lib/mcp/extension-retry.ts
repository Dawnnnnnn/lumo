import { retryExtensionProviders } from './extension-registry';

/**
 * Reconnect extension providers when a trusted page regains the user's attention.
 *
 * Approving Lumo happens in the provider's own settings tab. That makes "come
 * back to Lumo" the moment the grant becomes usable, so every page that lists
 * providers waits for exactly that signal instead of asking for a manual
 * Reconnect. Both the side panel and the options page install this; keeping it
 * in one place is what stops the two pages from drifting apart on the throttle
 * (which used to exist only in the side panel, leaving the options cards stuck
 * on "waiting for approval" after a successful grant).
 *
 * Retrying is cheap and — because `ExtensionMcpServer.connect()` probes with the
 * discovery intent — silent: it can never open a window or prompt the user. It
 * only discovers that a decision was already made.
 */

/**
 * Focus and visibility fire in bursts (window switches, tab switches, and the
 * pair of events a single return to the browser produces). Five seconds is short
 * enough that a returning user never waits, long enough that churn cannot turn
 * into a probe storm.
 */
export const EXTENSION_RETRY_THROTTLE_MS = 5_000;

/**
 * Attach the listeners. Returns a cleanup, which pages do not need — the page
 * *is* the lifetime — but tests do.
 */
export function installExtensionRetry(options: {
  /** Defaults to the registry's retry; injected by tests. */
  retry?: () => void;
  throttleMs?: number;
  /** Clock injection, for the throttle test. */
  now?: () => number;
} = {}): () => void {
  const { retry = retryExtensionProviders, throttleMs = EXTENSION_RETRY_THROTTLE_MS, now = Date.now } =
    options;

  // `undefined`, not 0: the first signal must always run, whatever the clock
  // happens to read (a page opened a moment after start would otherwise sit
  // inside the window before its first retry ever happened).
  let lastRun: number | undefined;
  const run = () => {
    const at = now();
    if (lastRun !== undefined && at - lastRun < throttleMs) return;
    lastRun = at;
    retry();
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') run();
  };

  window.addEventListener('focus', run);
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    window.removeEventListener('focus', run);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
