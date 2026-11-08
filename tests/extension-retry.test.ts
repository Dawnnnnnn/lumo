// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installExtensionRetry, EXTENSION_RETRY_THROTTLE_MS } from '@/lib/mcp/extension-retry';

/**
 * Both trusted pages retry extension providers when the user comes back — that
 * is how a grant made in the provider's own settings tab becomes a connection
 * without a manual Reconnect. This pins the two properties that keep it from
 * being harmful: it listens to both signals the browser actually produces, and
 * it cannot burst.
 */

const cleanups: (() => void)[] = [];

function install(options: Parameters<typeof installExtensionRetry>[0] = {}) {
  const cleanup = installExtensionRetry(options);
  cleanups.push(cleanup);
  return { retry: options.retry ?? vi.fn(), cleanup };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

describe('installExtensionRetry', () => {
  it('retries when the window regains focus', () => {
    const retry = vi.fn();
    install({ retry });

    window.dispatchEvent(new Event('focus'));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('retries when the document becomes visible again', () => {
    const retry = vi.fn();
    install({ retry });

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('swallows the burst a single return to the browser produces', () => {
    let clock = 1_000;
    const retry = vi.fn();
    install({ retry, now: () => clock });

    window.dispatchEvent(new Event('focus'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(retry).toHaveBeenCalledTimes(1);

    // Past the throttle it runs again, so the retry is not a one-shot.
    clock += EXTENSION_RETRY_THROTTLE_MS + 1;
    window.dispatchEvent(new Event('focus'));
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('does not retry while the page is hidden', () => {
    const retry = vi.fn();
    install({ retry });

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(retry).not.toHaveBeenCalled();
  });

  it('detaches both listeners on cleanup', () => {
    const retry = vi.fn();
    const { cleanup } = install({ retry });

    cleanup();
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));

    expect(retry).not.toHaveBeenCalled();
  });
});
