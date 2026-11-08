/**
 * Execution budget for one WebMCP tool call.
 *
 * A page tool is arbitrary code in the page's own world: it can drive a long UI
 * flow (upload, export, a model call) that takes far longer than a browser
 * action. A fixed timeout therefore either kills legitimate work or leaves a
 * hung tool holding the port open, and neither is something the caller can
 * influence.
 *
 * The budget is read from the arguments the model already sends:
 *
 * - a page tool that declares its own `timeout` / `timeoutMs` gets that number
 *   (its own limit and our budget cannot disagree);
 * - a page tool that declares neither gets an optional `timeoutMs` added to its
 *   schema by the WebMCP server and stripped again before forwarding, so the
 *   page never sees a parameter it did not define;
 * - otherwise {@link WEBMCP_DEFAULT_TIMEOUT_MS}.
 *
 * The ceiling exists so a malformed or hostile argument cannot pin a listener
 * for hours; it is deliberately far above any real page tool.
 */

/** Default budget when neither the page nor the caller names one. */
export const WEBMCP_DEFAULT_TIMEOUT_MS = 25_000;

/** Shortest budget worth honouring: below this even a trivial tool cannot reply. */
export const WEBMCP_MIN_TIMEOUT_MS = 1_000;

/** Hard ceiling, so an argument cannot keep a listener alive indefinitely. */
export const WEBMCP_MAX_TIMEOUT_MS = 10 * 60_000;

/** Field this bridge adds to a page tool's schema when the page declares none. */
export const WEBMCP_TIMEOUT_FIELD = 'timeoutMs';

/** Fields a page tool may declare; either one is read as the budget. */
const PAGE_TIMEOUT_FIELDS = [WEBMCP_TIMEOUT_FIELD, 'timeout'] as const;

/** Clamp any number into a usable budget. */
export function clampWebMcpTimeoutMs(value: number): number {
  return Math.min(Math.max(Math.trunc(value), WEBMCP_MIN_TIMEOUT_MS), WEBMCP_MAX_TIMEOUT_MS);
}

/**
 * Budget for a call, read from its arguments.
 *
 * A non-numeric or non-positive value reads as "not given" rather than as
 * "zero", because a schema with `timeout: 0` conventionally means "no limit"
 * and a string from a sloppy page must not become `NaN` in `setTimeout`.
 */
export function resolveWebMcpTimeoutMs(args: unknown): number {
  if (!args || typeof args !== 'object') return WEBMCP_DEFAULT_TIMEOUT_MS;
  const record = args as Record<string, unknown>;
  for (const field of PAGE_TIMEOUT_FIELDS) {
    const raw = record[field];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue;
    return clampWebMcpTimeoutMs(raw);
  }
  return WEBMCP_DEFAULT_TIMEOUT_MS;
}
