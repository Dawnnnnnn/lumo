/**
 * Combine several abort signals into one.
 *
 * Used by the tool gateway (caller cancellation + a per-call deadline) and by the
 * QuickJS bridge (`exec` cancellation + its own timeout). `AbortSignal.any` is
 * available in the extension's Chromium, but tests run on Node variants where it
 * may be absent, so the fallback stays.
 */
export function combineAbortSignals(
  signals: Array<AbortSignal | undefined>,
): AbortSignal | undefined {
  const list = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);

  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
