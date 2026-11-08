/**
 * Localized display strings for the built-in MCP servers.
 *
 * `getInfo()` returns a hardcoded English `name`/`description` because it runs in
 * the background service worker, where no i18n instance and no user language
 * preference exist. The settings UI rendered those raw English strings directly,
 * so the `options.mcp.builtinServers.*` translations were dead keys — nothing
 * ever read them, and the server list stayed English under a Chinese UI.
 *
 * This maps a server id to its translation key. The ids are kebab-case
 * (`page-interact`) while the keys are camelCase (`pageInteract`), which is why
 * a lookup table is needed rather than a string transform: an implicit
 * convention here would silently fall back to English the first time an id and a
 * key disagreed, which is exactly the failure being fixed.
 */

import type { McpAuthFailureReason } from './oauth/types';

/** Built-in server id -> `options.mcp.builtinServers` key. */
const BUILTIN_LABEL_KEYS: Record<string, string> = {
  browser: 'browser',
  'page-interact': 'pageInteract',
  'network-monitor': 'networkMonitor',
  'devtools-advanced': 'devtoolsAdvanced',
  file: 'file',
};

/** Minimal shape needed to label a server; matches `McpServerInfo`. */
interface LabelableServer {
  id: string;
  name: string;
  description: string;
  builtin?: boolean;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Localized server name, falling back to the server's own English name.
 *
 * External servers are user-named and WebMCP is rendered by its own section, so
 * both fall through to `info.name` rather than resolving to a missing key.
 */
export function serverDisplayName(t: Translate, info: LabelableServer): string {
  const key = info.builtin ? BUILTIN_LABEL_KEYS[info.id] : undefined;
  if (!key) return info.name;
  return t(`options.mcp.builtinServers.${key}`, { defaultValue: info.name });
}

/** Localized server description, falling back to the server's own English copy. */
export function serverDisplayDescription(t: Translate, info: LabelableServer): string {
  const key = info.builtin ? BUILTIN_LABEL_KEYS[info.id] : undefined;
  if (!key) return info.description;
  return t(`options.mcp.builtinServers.${key}Desc`, { defaultValue: info.description });
}

/** Ids of the built-in servers that carry translations, for contract tests. */
export const LOCALIZED_BUILTIN_SERVER_IDS = Object.keys(BUILTIN_LABEL_KEYS);

/**
 * Authorization failure reason -> translation key.
 *
 * The card renders a sentence, never the SDK's own wording, so this map is what
 * keeps a localized panel from falling back to English. It is total over the
 * union on purpose: adding a reason without wording is a type error, and the
 * i18n contract test resolves every value through i18next so a typo cannot
 * silently render a raw key.
 */
export const AUTH_REASON_KEYS: Record<McpAuthFailureReason, string> = {
  'authorization-required': 'options.mcp.authReasonAuthorizationRequired',
  'insufficient-scope': 'options.mcp.authReasonInsufficientScope',
  'no-registration': 'options.mcp.authReasonNoRegistration',
  'identity-unavailable': 'options.mcp.authReasonIdentityMissing',
  busy: 'options.mcp.authReasonBusy',
  'authorization-server-error': 'options.mcp.authReasonServerFailed',
  temporary: 'options.mcp.authReasonTemporary',
  'extension-approval': 'options.mcp.authReasonExtensionApproval',
};
