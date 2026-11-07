/**
 * Timer-safe wall-clock sentinel.
 *
 * Browsers clamp a `setTimeout` delay above 2^31-1 ms to 1 ms. Passing
 * `Infinity` (or a value one millisecond over the limit) to just-bash's deadline
 * race would therefore abort every script immediately. A value just under the
 * ceiling means "no practical limit" while keeping every timer in the loop
 * constructible: ~23 days.
 */
export const MAX_TIMER_DELAY_MS = 2_000_000_000;

/** Effectively no timeout, used when the caller does not request one. */
export const NO_TIMEOUT_MS = MAX_TIMER_DELAY_MS;
