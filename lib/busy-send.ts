/**
 * What sending does while an assistant turn is still streaming.
 *
 * Two honest answers, and the difference is not cosmetic: one keeps the current
 * reply and slips the message into it, the other throws the reply away.
 *
 * Free of i18next and browser APIs on purpose — `store/storage-schema.ts`
 * imports it, and that module is on the background worker's startup path.
 */

/**
 * - `'steer'` (default) — the message waits for the agent loop's next step
 *   boundary (after the running step's tool calls come back) and is delivered
 *   there, continuing the same reply. Nothing already produced is lost.
 * - `'interrupt'` — the running turn is aborted and persisted as interrupted,
 *   then the message is sent immediately as a new turn.
 *
 * The default is the non-destructive one: a send that quietly discards a
 * half-written answer is a worse surprise than one that lands a step later.
 */
export type BusySendBehavior = 'steer' | 'interrupt';

export const DEFAULT_BUSY_SEND: BusySendBehavior = 'steer';

/** Every valid value, in display order, shared by the options dropdown. */
export const BUSY_SEND_BEHAVIORS: readonly BusySendBehavior[] = ['steer', 'interrupt'];

/**
 * Coerces a stored or imported value into a behaviour.
 *
 * Configs written before this setting existed, and hand-edited exports, must
 * land on `'steer'` rather than on the destructive mode.
 */
export function normalizeBusySend(raw: unknown): BusySendBehavior {
  return BUSY_SEND_BEHAVIORS.includes(raw as BusySendBehavior)
    ? (raw as BusySendBehavior)
    : DEFAULT_BUSY_SEND;
}
