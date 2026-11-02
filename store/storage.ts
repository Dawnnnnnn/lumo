import type {
  ProviderConfig,
  UISettings,
  SystemPromptSettings,
  OcrSettings,
} from '@/types';
import type { McpSettings } from '@/lib/mcp/types';
import type { McpProtocolEras } from '@/lib/mcp/protocol-era';
import type { McpOAuthCredentialMap } from '@/lib/mcp/oauth/types';
import type { CommandSettings } from '@/lib/slash-commands';
import type { MentionSettings } from '@/lib/mention-commands';
import { MAX_SLOT_ID, defaultOrder, type PanelLayout } from '@/lib/panel-order';
import {
  STORAGE_FIELDS,
  EXPORTABLE_KEYS,
  type StorageSchema,
  type StorageKey,
} from './storage-schema';

// ---------------------------------------------------------------------------
// Generic helpers driven by the schema registry
// ---------------------------------------------------------------------------

/** Read a single key from chrome.storage.local, applying defaults + normalize */
async function getField<K extends StorageKey>(key: K): Promise<StorageSchema[K]> {
  const field = STORAGE_FIELDS[key];
  const result = await chrome.storage.local.get(key);
  const raw = result[key] as StorageSchema[K] | undefined;
  if (raw === undefined) return field.defaultValue;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return field.normalize ? (field.normalize as any)(raw) : raw;
}

/** Write a single key to chrome.storage.local */
async function setField<K extends StorageKey>(
  key: K,
  value: StorageSchema[K],
): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

// ---------------------------------------------------------------------------
// Exported config type — automatically covers all exportable keys
// ---------------------------------------------------------------------------

/**
 * Portable configuration bundle for import/export.
 * At runtime, only keys with `exportable: true` in the registry are
 * actually written/read. The type is permissive (partial of full schema)
 * so that older config files with missing keys import cleanly.
 */
export type AppConfig = Partial<StorageSchema>;

/**
 * Key chat history used to live under, before it moved to IndexedDB.
 *
 * Not part of `StorageSchema`: nothing reads it any more. It only needs deleting.
 */
const LEGACY_CONVERSATIONS_KEY = 'conversations';

/**
 * Keys the split view layout used before it became an explicit panel order.
 *
 * `splitView_intendedPanelCount` held a count, from which position was derived
 * as `count-1-i`. Now that panels can be reordered, position is stored directly.
 */
const LEGACY_PANEL_COUNT_KEY = 'splitView_intendedPanelCount';
const LEGACY_VISIBLE_COUNT_KEY = 'splitView_visiblePanelCount';

/**
 * Delete the abandoned chat-history key.
 *
 * Old conversations are intentionally not migrated, but the key cannot simply be
 * ignored: a large enough value occupies the whole 10 MB `local` quota, and
 * `chrome.storage` enforces that budget across the *area*, not per key. That is
 * why the original bug broke unrelated writes too — saving a model selection
 * failed because chat history had eaten the entire allowance.
 *
 * Idempotent, so it is safe to call on every startup.
 */
export async function dropLegacyConversationsKey(): Promise<void> {
  await chrome.storage.local.remove(LEGACY_CONVERSATIONS_KEY);
}

/**
 * Convert a stored panel *count* into an explicit panel *order*.
 *
 * Split view used to derive each panel's position from its slot id, so a count
 * was enough to describe the layout. Reordering makes position independent of
 * slot, so the order is now stored outright.
 *
 * The count maps to `defaultOrder`, which reproduces exactly the arrangement the
 * old code rendered — slot 0 rightmost, descending leftward — so a user who
 * upgrades mid-session finds their panels where they left them.
 *
 * Idempotent, and skips writing if a layout already exists, so a downgrade
 * followed by an upgrade cannot overwrite a real order with a stale count.
 */
export async function migrateLegacyPanelCount(): Promise<void> {
  const stored = await chrome.storage.local.get([
    'splitViewLayout',
    LEGACY_PANEL_COUNT_KEY,
  ]);

  const count = stored[LEGACY_PANEL_COUNT_KEY];
  // Drop the old keys either way: leaving them behind invites a future reader
  // from reviving a layout the user has since changed.
  await chrome.storage.local.remove([LEGACY_PANEL_COUNT_KEY, LEGACY_VISIBLE_COUNT_KEY]);

  if (stored['splitViewLayout'] !== undefined) return;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return;

  await setField('splitViewLayout', { order: defaultOrder(Math.min(count, MAX_SLOT_ID + 1)) });
}

// ---------------------------------------------------------------------------
// Public API — preserves the exact same method signatures for compatibility
// ---------------------------------------------------------------------------

// Storage helpers using chrome.storage.local
export const storage = {
  // ----- Providers -----
  async getProviders(): Promise<ProviderConfig[]> {
    return getField('providers');
  },
  async setProviders(providers: ProviderConfig[]): Promise<void> {
    await setField('providers', providers);
  },

  // ----- UI Settings -----
  async getUISettings(): Promise<UISettings> {
    return getField('uiSettings');
  },
  async setUISettings(settings: UISettings): Promise<void> {
    await setField('uiSettings', settings);
  },

  // ----- Conversation change broadcast -----

  /**
   * Announce that the conversation database changed.
   *
   * Conversations live in IndexedDB, which has no cross-context change event, so
   * a bounded counter in `chrome.storage` carries the signal instead (see
   * `storage-schema.ts`). Read-modify-write is fine here: the value is only ever
   * compared for inequality, so a racing bump that lands on the same number
   * still delivers a change event to every other context.
   */
  async bumpConversationsRevision(): Promise<void> {
    const current = await getField('conversationsRevision');
    await setField('conversationsRevision', current + 1);
  },

  // ----- Current Conversation ID -----
  async getCurrentConversationId(): Promise<string | null> {
    return getField('currentConversationId');
  },
  async setCurrentConversationId(id: string | null): Promise<void> {
    await setField('currentConversationId', id);
  },

  // ----- Selected Model -----
  async getSelectedModel(): Promise<{ providerId: string; modelId: string } | null> {
    return getField('selectedModel');
  },
  async setSelectedModel(
    model: { providerId: string; modelId: string } | null,
  ): Promise<void> {
    await setField('selectedModel', model);
  },

  // ----- Split view layout -----

  /**
   * The panels the user has open, left to right.
   *
   * Normalised on read, so callers can trust the order contains no duplicates
   * and no slot outside the allocatable range.
   */
  async getSplitViewLayout(): Promise<PanelLayout> {
    return getField('splitViewLayout');
  },
  async setSplitViewLayout(layout: PanelLayout): Promise<void> {
    await setField('splitViewLayout', layout);
  },

  /** The panels currently on screen, for other contexts to name them by position. */
  async getSplitViewVisible(): Promise<PanelLayout> {
    return getField('splitViewVisible');
  },
  async setSplitViewVisible(layout: PanelLayout): Promise<void> {
    await setField('splitViewVisible', layout);
  },

  // ----- MCP Settings -----
  async getMcpSettings(): Promise<McpSettings> {
    return getField('mcpSettings');
  },
  async setMcpSettings(settings: McpSettings): Promise<void> {
    const field = STORAGE_FIELDS.mcpSettings;
    await setField('mcpSettings', field.normalize ? field.normalize(settings) : settings);
  },

  /** Learned MCP protocol era per origin. Runtime state, not exported config. */
  async getMcpProtocolEras(): Promise<McpProtocolEras> {
    return getField('mcpProtocolEras');
  },
  async setMcpProtocolEras(eras: McpProtocolEras): Promise<void> {
    await setField('mcpProtocolEras', eras);
  },

  /** OAuth credentials for external MCP servers. Secrets, never exported. */
  async getMcpOAuthCredentials(): Promise<McpOAuthCredentialMap> {
    return getField('mcpOAuthCredentials');
  },
  async setMcpOAuthCredentials(credentials: McpOAuthCredentialMap): Promise<void> {
    await setField('mcpOAuthCredentials', credentials);
  },

  // ----- OCR Settings -----
  async getOcrSettings(): Promise<OcrSettings> {
    return getField('ocrSettings');
  },
  async setOcrSettings(settings: OcrSettings): Promise<void> {
    await setField('ocrSettings', settings);
  },

  // ----- System Prompt -----
  async getSystemPrompt(): Promise<SystemPromptSettings> {
    return getField('systemPrompt');
  },
  async setSystemPrompt(settings: SystemPromptSettings): Promise<void> {
    await setField('systemPrompt', settings);
  },

  // ----- Slash Commands -----
  async getCommandSettings(): Promise<CommandSettings> {
    return getField('commandSettings');
  },
  async setCommandSettings(settings: CommandSettings): Promise<void> {
    await setField('commandSettings', settings);
  },

  // ----- Mentions -----
  async getMentionSettings(): Promise<MentionSettings> {
    return getField('mentionSettings');
  },
  async setMentionSettings(settings: MentionSettings): Promise<void> {
    await setField('mentionSettings', settings);
  },

  // ----- Export / Import (driven by registry) -----

  /**
   * Export all settings marked `exportable: true` in the schema registry.
   * New settings added to the registry are automatically included.
   */
  async exportConfig(): Promise<AppConfig> {
    const keys = EXPORTABLE_KEYS;
    const result = await chrome.storage.local.get(keys);
    const config: AppConfig = {};

    for (const key of keys) {
      const field = STORAGE_FIELDS[key];
      const raw = result[key];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const value = raw === undefined ? field.defaultValue : (field.normalize ? (field.normalize as any)(raw) : raw);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any)[key] = value;
    }

    return config;
  },

  /**
   * Import settings from a config bundle.
   * Only keys present in the bundle AND marked `exportable` are written.
   * Normalize functions are applied automatically.
   */
  async importConfig(config: AppConfig): Promise<void> {
    const writes: Record<string, unknown> = {};

    for (const key of EXPORTABLE_KEYS) {
      const value = (config as Record<string, unknown>)[key];
      if (value === undefined) continue;

      const field = STORAGE_FIELDS[key];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      writes[key] = field.normalize ? (field.normalize as any)(value) : value;
    }

    // Batch write for atomicity
    if (Object.keys(writes).length > 0) {
      await chrome.storage.local.set(writes);
    }
  },
};
