/**
 * Declarative Storage Schema Registry
 *
 * All chrome.storage keys are declared here with metadata.
 * The `exportable` flag controls whether a key is included in config
 * import/export — new settings only need to be added to this registry
 * and they will automatically be covered by export/import.
 *
 * Adding a new setting:
 * 1. Define its type in `StorageSchema` interface
 * 2. Add a `StorageFieldDef` entry in `STORAGE_FIELDS`
 * 3. Done — export/import/watch types all derive from this file.
 *
 * ## What belongs here
 *
 * `chrome.storage.local` is capped at 10 MB (the `unlimitedStorage` permission
 * is deliberately not requested) and serialises a whole key on every write, so
 * this area is reserved for values that are **bounded in size** and need
 * `onChanged` to reach other extension contexts — settings, selections and
 * pointers.
 *
 * Data that grows with use must not live here. Chat history used to, under a
 * single `conversations` key, which exhausted the quota and made every
 * subsequent write throw `Resource::kQuotaBytes quota exceeded`. It now lives in
 * IndexedDB (`lib/conversation-store.ts`); `conversationsRevision` below is the
 * bounded counter that replaces it as the change-broadcast channel.
 */

import type {
  ProviderConfig,
  UISettings,
  SystemPromptSettings,
  OcrSettings,
} from '@/types';
import { DEFAULT_OCR_SETTINGS } from '@/types';
import type { McpSettings } from '@/lib/mcp/types';
import {
  normalizeProtocolEras,
  type McpProtocolEras,
} from '@/lib/mcp/protocol-era';
import {
  normalizeOAuthCredentials,
  type McpOAuthCredentialMap,
} from '@/lib/mcp/oauth/types';
import { DEFAULT_MCP_SETTINGS, normalizeMcpSettings } from '@/lib/mcp/settings';
import { normalizeProvider } from '@/lib/provider-type';
import { DEFAULT_SYSTEM_PROMPT_SETTINGS } from '@/lib/system-prompt';
import { DEFAULT_THEME, normalizeTheme } from '@/lib/theme-registry';
import { DEFAULT_FONT_SIZE, normalizeFontSize } from '@/lib/font-size-registry';
import { normalizePasteThreshold, DEFAULT_PASTE_THRESHOLD } from '@/lib/paste-threshold';
import { normalizeMaxSteps, DEFAULT_MAX_STEPS } from '@/lib/max-steps';
import {
  DEFAULT_COMPACTION_SETTINGS,
  normalizeCompactionSettings,
} from '@/lib/compaction';
import {
  DEFAULT_COMMAND_SETTINGS,
  normalizeCommandSettings,
  type CommandSettings,
} from '@/lib/slash-commands';
import {
  DEFAULT_MENTION_SETTINGS,
  normalizeMentionSettings,
  type MentionSettings,
} from '@/lib/mention-commands';
import {
  DEFAULT_PANEL_LAYOUT,
  normalizeOrder,
  type PanelLayout,
} from '@/lib/panel-order';
import {
  DEFAULT_TURN_NOTIFICATION,
  normalizeTurnNotification,
} from '@/lib/turn-notification';
import { normalizeLanguage } from '@/i18n/locales';
import { DEFAULT_BUSY_SEND, normalizeBusySend } from '@/lib/busy-send';

// ---------------------------------------------------------------------------
// 1. Schema: all possible storage keys and their value types
// ---------------------------------------------------------------------------

/**
 * The single source of truth for what lives in chrome.storage.local.
 * Every key used anywhere in the app MUST be listed here.
 *
 * Every value here is bounded — see the note at the top of this file.
 */
export interface StorageSchema {
  providers: ProviderConfig[];
  uiSettings: UISettings;
  currentConversationId: string | null;
  selectedModel: { providerId: string; modelId: string } | null;
  mcpSettings: McpSettings;
  /**
   * Learned MCP protocol era per endpoint origin (`lib/mcp/protocol-era.ts`).
   *
   * A runtime verdict, not a preference: the 2026-07-28 revision says the era
   * is a property of the server, so clients should cache it per origin and may
   * persist it. Persisting keeps every context (side panel, options, background)
   * from re-deriving it with a rejected request on every connect.
   */
  mcpProtocolEras: McpProtocolEras;
  /**
   * OAuth credentials per external MCP server (`lib/mcp/oauth/`).
   *
   * Runtime secrets, never configuration: a bearer token must not travel in an
   * exported bundle, and it is meaningless on another machine. Kept separate
   * from `mcpSettings` for exactly that reason.
   */
  mcpOAuthCredentials: McpOAuthCredentialMap;
  systemPrompt: SystemPromptSettings;
  /** OCR image-to-text settings for non-vision models. */
  ocrSettings: OcrSettings;
  /** Slash commands the composer recognises. See `lib/slash-commands.ts`. */
  commandSettings: CommandSettings;
  /** @ mention settings. See `lib/mention-commands.ts`. */
  mentionSettings: MentionSettings;
  /**
   * Bumped after every write to the conversation database.
   *
   * IndexedDB has no cross-context change event, so this counter is the signal
   * other contexts (a second side panel, the options page) watch to know they
   * should re-read. Only the counter crosses `chrome.storage`, never the data.
   */
  conversationsRevision: number;
  /**
   * Split view layout: which panels are open and, left to right, where they sit.
   *
   * The order *is* the layout — it carries both the panel count and each panel's
   * position, so there is no separate count to fall out of sync with it. Only the
   * user's intent is stored; how many panels actually fit is recomputed from the
   * side panel's width on every render, and a width-driven collapse deliberately
   * leaves this untouched so the layout returns when the window widens again.
   */
  splitViewLayout: PanelLayout;
  /**
   * The panels actually on screen right now, left to right.
   *
   * Distinct from `splitViewLayout` because the side panel may be too narrow to
   * fit everything the user asked for. Published by the side panel purely so
   * other contexts (the options page's chat debug view) can name a panel by the
   * position the user sees; nothing reads it back to drive layout.
   */
  splitViewVisible: PanelLayout;
}

// ---------------------------------------------------------------------------
// 2. Derived utility types (auto-generated from StorageSchema)
// ---------------------------------------------------------------------------

/** Union of all valid storage key strings */
export type StorageKey = keyof StorageSchema;

// ---------------------------------------------------------------------------
// 3. Field definition & registry
// ---------------------------------------------------------------------------

export interface StorageFieldDef<K extends StorageKey> {
  /** The chrome.storage.local key name */
  key: K;
  /** Default value when nothing is stored */
  defaultValue: StorageSchema[K];
  /**
   * Whether this field should be included in config export/import.
   * Set to `false` for runtime/ephemeral data (e.g. conversations).
   */
  exportable: boolean;
  /**
   * Optional migration/normalization function applied on read AND on import.
   * Use this for backwards-compat transforms (e.g. provider type migration).
   */
  normalize?: (raw: StorageSchema[K]) => StorageSchema[K];
}

// ---------------------------------------------------------------------------
// 4. The registry — THE place to add new settings
// ---------------------------------------------------------------------------

const DEFAULT_UI_SETTINGS: UISettings = {
  language: 'auto',
  theme: DEFAULT_THEME,
  fontSize: DEFAULT_FONT_SIZE,
  maxSplitPanels: 1,
  sendKey: 'enter',
  busySend: DEFAULT_BUSY_SEND,
  pasteThreshold: DEFAULT_PASTE_THRESHOLD,
  maxSteps: DEFAULT_MAX_STEPS,
  autoCollapseReasoning: true,
  messageToolbar: {
    copy: 'all',
    regenerate: 'show',
    delete: 'all',
    usage: 'show',
  },
  compaction: DEFAULT_COMPACTION_SETTINGS,
  programmaticTools: false,
  turnNotification: DEFAULT_TURN_NOTIFICATION,
};

/**
 * Central registry of all storage fields.
 *
 * To add a new setting:
 * 1. Add the key + type to `StorageSchema`
 * 2. Add a field entry below with `exportable: true`
 * 3. That's it — export/import picks it up automatically.
 */
export const STORAGE_FIELDS: { [K in StorageKey]: StorageFieldDef<K> } = {
  providers: {
    key: 'providers',
    defaultValue: [],
    exportable: true,
    normalize: (raw) => raw.map(normalizeProvider),
  },
  uiSettings: {
    key: 'uiSettings',
    defaultValue: DEFAULT_UI_SETTINGS,
    exportable: true,
    normalize: (raw) => ({
      ...raw,
      // A stale config may carry a language this build no longer ships (or the
      // pre-registry `'zh'`). Normalise it here so neither the picker nor
      // i18next ever sees an unloadable bundle name.
      language: normalizeLanguage(raw.language),
      // Guards configs exported by a build that knows a theme this one does not
      // (and pre-field configs). An unrecognised value would otherwise reach
      // `data-theme`, match no token block, and silently leave light tokens.
      theme: normalizeTheme(raw.theme),
      fontSize: normalizeFontSize(raw.fontSize),
      maxSplitPanels: raw.maxSplitPanels ?? 1,
      sendKey: raw.sendKey ?? 'enter',
      // A config written before this setting existed must land on the
      // non-destructive mode, not on one that discards a half-written reply.
      busySend: normalizeBusySend(raw.busySend),
      // A config written before this setting existed, or one carrying a value a
      // hand-edited export made non-numeric, must land on the default rather
      // than on `0` — which would read as "never attach a paste".
      pasteThreshold: normalizePasteThreshold(raw.pasteThreshold),
      // Same reasoning, opposite default: a config that predates this setting
      // must land on "no cap" rather than on `0`-as-a-count, which would allow
      // zero steps and make every turn produce nothing.
      maxSteps: normalizeMaxSteps(raw.maxSteps),
      // An existing install's `uiSettings` predates this field entirely, and a
      // hand-edited export may carry a non-boolean. Only an explicit `false`
      // means the expand-and-stay-open behaviour; everything else defaults to
      // the shipped auto-collapse-on setting.
      autoCollapseReasoning: raw.autoCollapseReasoning !== false,
      // Configs written before compaction existed, or with a nonsensical token
      // budget, land on the shipped defaults rather than on `0` — which would
      // make the checkpoint fire on every message.
      compaction: normalizeCompactionSettings(raw.compaction),
      // Experimental shell mode. Only an explicit `true` enables it; an older
      // config (or a hand-edited one) stays on the stable tool-per-capability
      // behaviour.
      programmaticTools: raw.programmaticTools === true,
      // A config that predates this setting must land on `'never'`, never on a
      // mode the user did not choose.
      turnNotification: normalizeTurnNotification(raw.turnNotification),
    }),
  },
  systemPrompt: {
    key: 'systemPrompt',
    defaultValue: DEFAULT_SYSTEM_PROMPT_SETTINGS,
    exportable: true,
    // Explicit allowlist: configs written before the fields existed, and
    // hand-edited exports carrying unknown keys, are trimmed to the shape the
    // prompt composer actually reads.
    normalize: (raw) => ({
      enabled: raw.enabled ?? true,
      prompt: raw.prompt ?? DEFAULT_SYSTEM_PROMPT_SETTINGS.prompt,
      injectCurrentTime: raw.injectCurrentTime ?? true,
    }),
  },
  commandSettings: {
    key: 'commandSettings',
    defaultValue: DEFAULT_COMMAND_SETTINGS,
    exportable: true,
    // Imports and hand-edited configs are the common source of invalid names,
    // missing ids and colliding enabled triggers — all repaired here so the
    // options page and the composer never see a half-broken record.
    normalize: (raw) => normalizeCommandSettings(raw),
  },
  mentionSettings: {
    key: 'mentionSettings',
    defaultValue: DEFAULT_MENTION_SETTINGS,
    exportable: true,
    normalize: (raw) => normalizeMentionSettings(raw),
  },
  mcpSettings: {
    key: 'mcpSettings',
    defaultValue: DEFAULT_MCP_SETTINGS,
    exportable: true,
    normalize: (raw) => normalizeMcpSettings(raw),
  },
  mcpProtocolEras: {
    key: 'mcpProtocolEras',
    defaultValue: {},
    // Runtime state, not configuration: an imported bundle must not claim a
    // server speaks an era it was never observed to speak.
    exportable: false,
    normalize: (raw) => normalizeProtocolEras(raw),
  },
  mcpOAuthCredentials: {
    key: 'mcpOAuthCredentials',
    defaultValue: {},
    // Secrets. Excluded from export/import by contract, not by convention.
    exportable: false,
    normalize: (raw) => normalizeOAuthCredentials(raw),
  },
  ocrSettings: {
    key: 'ocrSettings',
    defaultValue: DEFAULT_OCR_SETTINGS,
    exportable: true,
  },
  selectedModel: {
    key: 'selectedModel',
    defaultValue: null,
    exportable: true,
  },
  conversationsRevision: {
    key: 'conversationsRevision',
    defaultValue: 0,
    exportable: false,
  },
  currentConversationId: {
    key: 'currentConversationId',
    defaultValue: null,
    exportable: false,
  },
  splitViewLayout: {
    key: 'splitViewLayout',
    defaultValue: DEFAULT_PANEL_LAYOUT,
    // Not exportable: the layout describes one window's arrangement, and a
    // config imported onto a machine with a narrower side panel would restore
    // panels that cannot fit.
    exportable: false,
    // Repairs an order written by a build that allows more panels than this one,
    // or a partial write. A malformed order would surface as duplicate React
    // keys or a panel rendered at a position that does not exist.
    normalize: (raw) => ({ order: normalizeOrder(raw?.order) }),
  },
  splitViewVisible: {
    key: 'splitViewVisible',
    defaultValue: DEFAULT_PANEL_LAYOUT,
    exportable: false,
    normalize: (raw) => ({ order: normalizeOrder(raw?.order) }),
  },
};

// ---------------------------------------------------------------------------
// 5. Helpers derived from registry
// ---------------------------------------------------------------------------

/** All keys that have `exportable: true` */
export const EXPORTABLE_KEYS: StorageKey[] = (
  Object.keys(STORAGE_FIELDS) as StorageKey[]
).filter((k) => STORAGE_FIELDS[k].exportable);
