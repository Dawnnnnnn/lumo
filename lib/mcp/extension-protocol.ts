/**
 * L0 contract between Lumo and an extension that provides MCP capabilities.
 *
 * Two messages, with a hard split between reading and acting:
 *
 *   `lumo:probe`     — read-only. Service metadata plus status. Safe to send as
 *                      often as we like: at startup, on every settings write, on
 *                      every focus retry, and as a catalog scan over extensions
 *                      the user has never added. A provider may not record,
 *                      prompt, or open anything in response.
 *   `lumo:authorize` — "the user asked to use you". Records the request and opens
 *                      the provider's own approval UI. Only ever sent from the
 *                      Authorize button, so it is the only call that can steal
 *                      the user's focus.
 *
 * Both answer with the same `ProbeResponse` shape, so one parser and one status
 * mapping cover them.
 *
 * Everything after a successful probe is standard MCP over a `chrome.runtime`
 * Port (`lumo:mcp`), implemented by `@ai-sdk/mcp` on this side.
 */

export const PROBE_CHANNEL = 'lumo:probe';
export const AUTHORIZE_CHANNEL = 'lumo:authorize';
export const PROBE_VERSION = 1;
export const MCP_PORT_NAME = 'lumo:mcp';

export interface ProbeRequest {
  channel: typeof PROBE_CHANNEL;
  version: number;
  id?: string;
  client?: { id: string; name: string; version: string };
}

export interface AuthorizeRequest {
  channel: typeof AUTHORIZE_CHANNEL;
  version: number;
  id?: string;
  /** Present so the provider's approval card can name the host. */
  client?: { id: string; name: string; version: string };
}

export interface ExtensionServiceInfo {
  namespace: string;
  name: string;
  version: string;
}

export interface ExtensionStatus {
  enabled: boolean;
  authorized: boolean;
  ready: boolean;
  /** Set when `ready` is false; the provider's own wording. */
  reason?: { code: string; message: string };
}

export interface ProbeResponse {
  ok: boolean;
  service?: ExtensionServiceInfo;
  status?: ExtensionStatus;
  error?: { code: string; message: string };
}

export function isProbeResponse(value: unknown): value is ProbeResponse {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as { ok?: unknown }).ok === 'boolean';
}

/** Chrome extension IDs are 32 characters drawn from `a`–`p`. */
export function isExtensionId(value: string): boolean {
  return /^[a-p]{32}$/.test(value);
}
