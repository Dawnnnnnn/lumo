/**
 * Persistence for MCP OAuth credentials.
 *
 * Every trusted context (side panel, options page, background) runs its own MCP
 * registry, so three processes can hold a client for the same server. Tokens
 * therefore live in `chrome.storage.local` and every mutation is a
 * read-modify-write against that shared area rather than against a startup
 * snapshot: writing a stale snapshot back would delete a token another context
 * just received.
 *
 * The in-memory map is the fallback for runtimes without `chrome.storage`
 * (unit tests), and the authoritative copy when a storage write fails — a
 * failed write must not lose the tokens that were just issued.
 */

import { storage } from '@/store/storage';
import {
  normalizeOAuthCredentials,
  ownsServerUrl,
  type McpOAuthCredentialMap,
  type McpOAuthCredentials,
} from './types';

/** Mirror of the last known map, so a storage outage degrades to memory. */
let memory: McpOAuthCredentialMap = {};

async function readAll(): Promise<McpOAuthCredentialMap> {
  try {
    return normalizeOAuthCredentials(await storage.getMcpOAuthCredentials());
  } catch {
    return memory;
  }
}

async function writeAll(next: McpOAuthCredentialMap): Promise<McpOAuthCredentialMap> {
  // Normalise before caching so memory and storage can never disagree on shape.
  const normalized = normalizeOAuthCredentials(next);
  memory = normalized;
  try {
    await storage.setMcpOAuthCredentials(normalized);
  } catch {
    // Keep the in-memory copy: the flow continues, only persistence is lost.
  }
  return normalized;
}

/** Credentials for one server, if it was ever authorized. */
export async function loadCredentials(
  serverId: string,
): Promise<McpOAuthCredentials | undefined> {
  return (await readAll())[serverId];
}

/**
 * Credentials for one server, but only if they were issued for `serverUrl`.
 *
 * Callers that are about to send a token must use this, not `loadCredentials`:
 * a server whose URL was edited must look unauthorized, not inherit a token that
 * belongs to a different endpoint.
 */
export async function loadCredentialsFor(
  serverId: string,
  serverUrl: string,
): Promise<McpOAuthCredentials | undefined> {
  const stored = (await readAll())[serverId];
  return ownsServerUrl(stored, serverUrl) ? stored : undefined;
}

/**
 * Merge a patch into a server's record, stamping `updatedAt`.
 *
 * Callers never need to remove a field here (`invalidateCredentials` →
 * `clearCredentials` owns that), so a plain merge keeps the call sites small.
 */
export async function patchCredentials(
  serverId: string,
  patch: Partial<McpOAuthCredentials>,
): Promise<McpOAuthCredentials | undefined> {
  const all = await readAll();
  const merged: McpOAuthCredentials = {
    ...(all[serverId] ?? { updatedAt: 0 }),
    ...patch,
    updatedAt: Date.now(),
  };
  const written = await writeAll({ ...all, [serverId]: merged });
  return written[serverId];
}

/**
 * Remove part of a record, per the `OAuthClientProvider.invalidateCredentials`
 * contract.
 *
 * `verifier` only drops the single-use PKCE material, `tokens` keeps the
 * registration, `client` also drops the authorization-server pin, and `all`
 * resets the record. An empty record is left in place; `normalizeOAuthCredentials`
 * discards it on the next read, which is what makes "start over" cheap.
 */
export async function clearCredentials(
  serverId: string,
  scope: 'all' | 'client' | 'tokens' | 'verifier',
): Promise<McpOAuthCredentials | undefined> {
  const all = await readAll();
  const current = all[serverId];
  if (!current) return undefined;

  const next: McpOAuthCredentials = { ...current, updatedAt: Date.now() };
  if (scope === 'all' || scope === 'tokens') delete next.tokens;
  if (scope === 'all' || scope === 'verifier') {
    delete next.codeVerifier;
    delete next.state;
  }
  if (scope === 'all' || scope === 'client') {
    // The client registration belongs to the authorization server that issued
    // it, so dropping the client also drops the pin that binds the two.
    delete next.clientInformation;
    delete next.clientInformationIsDynamic;
    delete next.authorizationServer;
  }

  const written = await writeAll({ ...all, [serverId]: next });
  return written[serverId];
}

/** Forget a server entirely (used when it is removed from settings). */
export async function deleteCredentials(serverId: string): Promise<void> {
  const all = await readAll();
  if (!(serverId in all)) return;
  const { [serverId]: _dropped, ...rest } = all;
  await writeAll(rest);
}

/** Test seam: drop the in-process mirror so storage is read again. */
export function __resetOAuthCredentialCache(): void {
  memory = {};
}
