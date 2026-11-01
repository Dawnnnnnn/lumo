/**
 * MCP protocol-era detection.
 *
 * Since `2026-07-28` MCP has no `initialize` handshake: every request declares
 * the protocol version it speaks (`_meta` in the body, `MCP-Protocol-Version`
 * on HTTP). The spec's *Versioning and Compatibility → Backward Compatibility*
 * section defines how a client that also speaks the older handshake-based
 * revisions must interoperate:
 *
 *   - attempt a modern request first;
 *   - on `400 Bad Request` **inspect the body before falling back**;
 *   - a *recognized modern JSON-RPC error* (`-32020` HeaderMismatch,
 *     `-32021` MissingRequiredClientCapability, `-32022`
 *     UnsupportedProtocolVersion) identifies a **modern** server — retry with
 *     an advertised version instead of falling back;
 *   - an empty body or anything that is not a recognized modern error
 *     identifies a **legacy** server — fall back to `initialize` and stay on
 *     that revision.
 *
 * The same section stresses that the era is a property of the *server*, not of
 * an individual request: clients SHOULD cache it per origin and MAY persist it,
 * re-probing when the cached assumption later fails. This module therefore
 * contains pure classification plus the probe request itself; caching lives in
 * `protocol-era-store.ts`.
 *
 * Real-world case that motivated the module: `mcp.exa.ai` answers a modern
 * probe with `400` and `{"code":-32000,"message":"Bad Request: Unsupported
 * protocol version: …"}`. `-32000` is *not* a recognized modern error, so the
 * server is legacy by the spec's rule — even though its wording sounds modern.
 */

/** The two protocol eras the spec names. */
export type ProtocolEra = 'modern' | 'legacy';

/** Classification result; `unknown` means "not enough information" (never cached). */
export type EraVerdict = ProtocolEra | 'unknown';

/**
 * Version advertised by the era probe.
 *
 * Kept in sync with `LATEST_PROTOCOL_VERSION` of `@ai-sdk/mcp` (which does not
 * export it). It only has to be a *modern* version: any server that answers it
 * with a recognized modern error is classified as modern regardless.
 */
export const MODERN_PROBE_VERSION = '2026-07-28';

/** The method a modern server MUST implement, and the cheapest era probe. */
const DISCOVERY_METHOD = 'server/discover';

/** JSON-RPC id used by the probe; it is never part of a session. */
const PROBE_REQUEST_ID = 'lumo-era-probe';

/**
 * A legacy server can be slow to reject unknown traffic (`mcp.exa.ai` takes
 * ~3.6s to answer `400`), and giving up early would mean never learning the
 * era — every later connect would repay that delay.
 */
const PROBE_TIMEOUT_MS = 6000;

/**
 * Statuses that mean "this endpoint does not understand modern MCP traffic".
 *
 * Deliberately excludes `401`/`403`/`407` (authentication — the era is still
 * unknown), `408`/`429` (transient) and every `5xx` (server-side failure).
 * Falling back on those would cache a wrong era for a modern server.
 */
const LEGACY_STATUSES: ReadonlySet<number> = new Set([400, 404, 405, 406, 415, 501]);

/** JSON-RPC errors the 2026-07-28 revision reserves for modern handshakes. */
const MODERN_ERROR_CODES: readonly number[] = [-32020, -32021, -32022];

/** `-32601` is "method not found" — a server that has never heard of `server/discover`. */
const METHOD_NOT_FOUND = -32601;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ProbeOptions {
  /** Headers configured for this server (API keys, etc.). */
  headers?: Record<string, string>;
  /** Override for tests / runtimes with a request-local fetch. */
  fetch?: FetchLike;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** First JSON object embedded in `text` (a body may arrive with an SSE frame). */
function firstJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** JSON-RPC error code carried by a response body, if any. */
export function jsonRpcErrorCode(body: string): number | undefined {
  const message = firstJsonObject(body);
  const error = isRecord(message?.error) ? message.error : undefined;
  return typeof error?.code === 'number' ? error.code : undefined;
}

function isModernErrorCode(code: unknown): boolean {
  return typeof code === 'number' && MODERN_ERROR_CODES.includes(code);
}

/**
 * Classify an era-probe response.
 *
 * `modern` — the server answered, or rejected the request with a recognized
 * modern error (`-32020/-32021/-32022`). `legacy` — a 4xx/501 the spec tells us
 * to fall back on. `unknown` — anything that is not evidence about the era
 * (auth, rate limiting, server errors, malformed bodies).
 */
export function classifyDiscoveryResponse(status: number, body: string): EraVerdict {
  const code = jsonRpcErrorCode(body);
  const isModern = isModernErrorCode(code);

  if (status >= 200 && status < 300) {
    // Some deployments answer 200 with a JSON-RPC error object instead of a
    // proper HTTP status. Trust the payload over the status line.
    if (code === undefined || isModern) return 'modern';
    return code === METHOD_NOT_FOUND ? 'legacy' : 'unknown';
  }

  if (isModern) return 'modern';
  return LEGACY_STATUSES.has(status) ? 'legacy' : 'unknown';
}

/**
 * Classify a rejected MCP client request (`MCPClientError` from `@ai-sdk/mcp`,
 * which exposes the HTTP status and the raw body).
 */
export function classifyDiscoveryError(error: unknown): EraVerdict {
  if (!isRecord(error)) return 'unknown';

  // Application-level JSON-RPC error without an HTTP status.
  if (isModernErrorCode(error.code)) return 'modern';

  const status = error.statusCode;
  if (typeof status !== 'number') return 'unknown';

  const body = typeof error.responseBody === 'string' ? error.responseBody : '';
  return classifyDiscoveryResponse(status, body);
}

/**
 * Ask a server which era it speaks by making one modern request.
 *
 * This is the spec's algorithm, executed once per origin and then cached: the
 * answer never depends on the particular request, only on the server. Every
 * failure mode is mapped to a verdict, so a broken probe can neither throw nor
 * block a connection — `unknown` simply leaves the decision to the SDK's own
 * discovery, which probes again as part of connecting.
 */
export async function probeProtocolEra(
  url: string,
  options: ProbeOptions = {},
): Promise<EraVerdict> {
  const fetchFn = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchFn) return 'unknown';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS);

  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        ...options.headers,
        'content-type': 'application/json',
        // Streamable HTTP servers may answer a request with an SSE stream.
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MODERN_PROBE_VERSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: PROBE_REQUEST_ID, method: DISCOVERY_METHOD }),
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') ?? '';
    // A 200 SSE body is an open stream; reading it would hang until the probe
    // timeout. A 2xx answer to `server/discover` is proof of a modern server.
    if (response.ok && contentType.includes('text/event-stream')) {
      void response.body?.cancel().catch(() => {});
      return 'modern';
    }

    const body = await response.text().catch(() => '');
    return classifyDiscoveryResponse(response.status, body);
  } catch {
    // Network error, CORS/preflight rejection or timeout: no evidence.
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

// ─── Persisted era cache ────────────────────────────────────────────────────

export interface McpProtocolEraRecord {
  era: ProtocolEra;
  /** Last time the era was learned or re-confirmed, for bounded eviction. */
  updatedAt: number;
}

/** Origin → learned era. Bounded: one entry per distinct MCP endpoint origin. */
export type McpProtocolEras = Record<string, McpProtocolEraRecord>;

/** Upper bound on cached origins; far above any realistic server list. */
export const MAX_CACHED_ERAS = 64;

/**
 * Cache key for an endpoint.
 *
 * Keyed by **origin**, as the spec specifies for HTTP: era is a property of the
 * server, so two configurations pointing at the same origin share one verdict.
 */
export function eraCacheKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    // Not a parseable URL — it cannot connect anyway; keep the key stable.
    return url;
  }
}

function isProtocolEra(value: unknown): value is ProtocolEra {
  return value === 'modern' || value === 'legacy';
}

/** Drop unknown eras, repair timestamps and keep the cache bounded. */
export function normalizeProtocolEras(raw: unknown): McpProtocolEras {
  if (!isRecord(raw)) return {};

  const entries: Array<[string, McpProtocolEraRecord]> = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!key || !isRecord(value) || !isProtocolEra(value.era)) continue;
    const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
      ? value.updatedAt
      : 0;
    entries.push([key, { era: value.era, updatedAt }]);
  }

  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(entries.slice(0, MAX_CACHED_ERAS));
}

/**
 * Combine two caches, keeping the more recently confirmed verdict per origin.
 *
 * Every extension context keeps its own in-memory copy and they read/modify/
 * write the same storage key, so a plain spread could resurrect a verdict a
 * newer observation already replaced. `updatedAt` is the tie-breaker; the
 * result is normalised, which also re-applies the size bound.
 */
export function mergeProtocolEras(
  base: McpProtocolEras,
  incoming: McpProtocolEras,
): McpProtocolEras {
  const merged: McpProtocolEras = { ...base };
  for (const [key, record] of Object.entries(incoming)) {
    const current = merged[key];
    if (!current || current.updatedAt <= record.updatedAt) merged[key] = record;
  }
  return normalizeProtocolEras(merged);
}
