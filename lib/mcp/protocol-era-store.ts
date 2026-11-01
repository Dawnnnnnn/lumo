import { storage } from '@/store/storage';
import {
  eraCacheKey,
  mergeProtocolEras,
  normalizeProtocolEras,
  probeProtocolEra,
  type McpProtocolEras,
  type ProbeOptions,
  type ProtocolEra,
} from './protocol-era';

/**
 * Per-origin cache of the MCP protocol era.
 *
 * The spec asks clients to cache the era per origin for the lifetime of the
 * process and allows persisting it across restarts, because the era is a
 * property of the server: re-deriving it costs one rejected request every
 * connect (3.6s against `mcp.exa.ai`, plus a scary 400 in the log).
 *
 * Storage is `chrome.storage.local` (via the schema registry) so every context
 * — side panel, options page, background — shares one verdict. The in-memory
 * map is authoritative within a context and absorbs environments without
 * `chrome.storage` (unit tests): if a storage read fails, the cache simply
 * degrades to per-process memory instead of failing the connection.
 *
 * Every mutation is a read-modify-write against storage rather than against a
 * startup snapshot. The key is shared by all contexts, so writing a stale
 * snapshot back would silently drop a verdict another context just learned.
 */

let cache: McpProtocolEras | null = null;

/** Read the persisted map; a runtime without `chrome.storage` reports "empty". */
async function readPersisted(): Promise<McpProtocolEras> {
  try {
    return normalizeProtocolEras(await storage.getMcpProtocolEras());
  } catch {
    return {};
  }
}

/**
 * Re-read storage and fold it into the in-memory map.
 *
 * Storage wins only for origins this process has not observed more recently
 * (see `mergeProtocolEras`), so a probe result learned here is not undone by a
 * slower writer elsewhere.
 */
async function refreshCache(): Promise<McpProtocolEras> {
  cache = mergeProtocolEras(await readPersisted(), cache ?? {});
  return cache;
}

async function writeCache(next: McpProtocolEras): Promise<void> {
  cache = next;
  try {
    await storage.setMcpProtocolEras(next);
  } catch {
    // Keep the in-memory verdict; persistence is an optimisation, not a need.
  }
}

/** The era learned for this endpoint's origin, if any. */
export async function loadEra(url: string): Promise<ProtocolEra | undefined> {
  const key = eraCacheKey(url);
  const cached = cache?.[key];
  if (cached) return cached.era;

  // Miss: another context may have learned this origin since this one started.
  return (await refreshCache())[key]?.era;
}

/** Record a verdict so the next connect skips the probe. */
export async function rememberEra(url: string, era: ProtocolEra): Promise<void> {
  const eras = await refreshCache();
  await writeCache(
    normalizeProtocolEras({
      ...eras,
      [eraCacheKey(url)]: { era, updatedAt: Date.now() },
    }),
  );
}

/** Drop a stale verdict; the next connect probes again. */
export async function forgetEra(url: string): Promise<void> {
  const eras = await refreshCache();
  const key = eraCacheKey(url);
  if (!(key in eras)) return;

  const { [key]: _dropped, ...rest } = eras;
  await writeCache(rest);
}

/**
 * Era for this endpoint, probing only when nothing is cached.
 *
 * Returns `undefined` when the era is unknown (probe had no usable evidence),
 * which callers treat as "let the SDK's own discovery decide".
 */
export async function resolveEra(
  url: string,
  options: ProbeOptions = {},
): Promise<ProtocolEra | undefined> {
  const known = await loadEra(url);
  if (known) return known;

  const verdict = await probeProtocolEra(url, options);
  if (verdict === 'unknown') return undefined;

  await rememberEra(url, verdict);
  return verdict;
}

/** Test seam: forget the in-process state so storage is read again. */
export function __resetProtocolEraCache(): void {
  cache = null;
}
