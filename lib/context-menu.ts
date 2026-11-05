/**
 * Context Menu Registration & Handling
 *
 * Builds the right-click menu from the {@link QUICK_ACTIONS} registry. Each
 * right-click context (page / selection / image) gets one top-level "Lumo" entry
 * with the scope's actions as a submenu, so the user's context menu never gains
 * more than one item per scope no matter how many actions exist.
 *
 * Communication with the side panel is done via `chrome.storage.session` so the
 * panel can pick up the pending action even if it was not yet open when the
 * menu item was clicked.
 */

import {
  QUICK_ACTIONS,
  QUICK_ACTION_PARENT_IDS,
  findQuickAction,
  quickActionPromptPath,
  quickActionTitlePath,
  type QuickActionDefinition,
  type QuickActionScope,
} from '@/lib/quick-actions';
import { loadLocaleBundle, type LocaleBundle } from '@/i18n/load-locale';
import { resolveLanguage } from '@/i18n/locales';
import type { PageContext } from '@/lib/page-context';

// ─── Pending payload contract ────────────────────────────────────────────────

/**
 * Session storage key used to pass context-menu actions to the side panel.
 * The side panel clears it after consuming.
 */
export const CONTEXT_MENU_PENDING_KEY = 'contextMenuPending';

export interface ContextMenuPendingData {
  /** Id of the {@link QuickActionDefinition} that was clicked. */
  actionId: string;
  /** Which payload kind accompanies the action. */
  type: 'page' | 'text' | 'image';
  /** The selected text (when type is 'text') */
  text?: string;
  /** The image source URL (when type is 'image') */
  imageUrl?: string;
  /**
   * Identity of the page the action was fired from. Always present so the model
   * knows — and can address via the `page_*` tools — which tab it is working on.
   */
  pageContext: PageContext;
  /**
   * Prompt to place in the chat input, already localised in the background.
   * Absent for actions that only attach context (plain "Ask Lumo").
   */
  prompt?: string;
  /** Whether the panel may dispatch this without waiting for the user. */
  autoSend: boolean;
  /**
   * The window the action originated from. Side panels in other windows
   * should ignore this pending action.
   */
  targetWindowId?: number;
  /** Timestamp to avoid processing stale entries */
  timestamp: number;
}

// ─── i18n without React ──────────────────────────────────────────────────────

/**
 * The background has no live i18next instance (and no React), so it loads the
 * same JSON bundle the UI does, resolved from the same stored preference. This
 * keeps the right-click menu in the language the user picked instead of the
 * old hard-coded `en`/`zh` fork.
 */
async function loadLocale(): Promise<LocaleBundle> {
  try {
    const result = await chrome.storage.local.get('uiSettings');
    const language = (result.uiSettings as { language?: unknown } | undefined)?.language;
    return await loadLocaleBundle(resolveLanguage(language));
  } catch {
    // Fall through to English; the menu must still be usable.
    return loadLocaleBundle('en');
  }
}

/** Resolves a dotted i18n path against a locale object. */
function resolvePath(locale: LocaleBundle, path: string): string | undefined {
  const value = path
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], locale);
  return typeof value === 'string' ? value : undefined;
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register context menu items. Must be called synchronously during service
 * worker initialisation (inside `defineBackground`) to comply with
 * `svc-register-listeners-synchronously`.
 */
export function registerContextMenus() {
  // Replace any entries left over from an earlier service-worker lifetime with
  // a locally correct set.
  rebuildMenus();

  // Listen for clicks
  chrome.contextMenus.onClicked.addListener(handleContextMenuClick);

  // Re-create menus when the *language* changes so titles stay in sync. Theme
  // and font edits also rewrite `uiSettings`; rebuilding on those would tear
  // down and recreate every menu item for no visible reason.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes.uiSettings;
    if (!change) return;
    const before = (change.oldValue as { language?: unknown } | undefined)?.language;
    const after = (change.newValue as { language?: unknown } | undefined)?.language;
    if (before !== after) rebuildMenus();
  });
}

/**
 * Rebuild bookkeeping.
 *
 * `removeAll` and each `create` are asynchronous round trips to the browser
 * process, and the locale load sits in between. Firing two rebuilds at once —
 * the service worker starting *and* a stored language change arriving — is
 * therefore not idempotent: both passes finish removing before either creates,
 * so the second one collides with every id the first one just added and the
 * console fills with one "Cannot create item with duplicate id" per item.
 *
 * Rebuilds are chained instead of raced: a pass only starts once the previous
 * one has settled. `rebuildGeneration` lets a queued pass bail out when a newer
 * request has superseded it — two quick language edits need one final menu, not
 * two rebuilds, and the older titles must never win.
 */
let rebuildChain: Promise<void> = Promise.resolve();
let rebuildGeneration = 0;

function rebuildMenus(): void {
  const generation = ++rebuildGeneration;
  rebuildChain = rebuildChain
    .then(() => runRebuild(generation))
    .catch((error: unknown) => {
      console.error('[Lumo] Failed to rebuild context menus:', error);
    });
}

/** Which pass a rebuild is running: the normal one, or the one repair pass. */
type RebuildAttempt = 'initial' | 'recovery';

async function runRebuild(generation: number, attempt: RebuildAttempt = 'initial'): Promise<void> {
  // Superseded while queued: the newer pass owns the menu now.
  if (generation !== rebuildGeneration) return;

  // Resolve the titles *before* touching the live menu. The locale bundle is
  // the only asynchronous step in a rebuild, so doing it first leaves a
  // remove→create pair with no gap another pass could interleave with — the
  // menu is never observed half-built, and no id is ever created twice.
  const locale = await loadLocale();
  if (generation !== rebuildGeneration) return;

  await removeAllMenus();
  const failures = await createMenuItems(locale);
  if (failures.length === 0) return;
  if (generation !== rebuildGeneration) return;

  reportMenuFailures(failures, attempt);

  // A duplicate id means the browser still held an item this pass did not
  // remove, so the menu left behind is not the one we asked for (stale title,
  // stale language). One forced teardown repairs it; repeating the pass would
  // only repeat the failure, so recovery is bounded to a single retry.
  if (attempt === 'initial' && failures.some((failure) => failure.duplicateId)) {
    await runRebuild(generation, 'recovery');
  }
}

/**
 * Remove every menu item this extension owns.
 *
 * Promisified because the create pass must not begin until the browser has
 * actually applied the removal: that ordering *is* the rebuild. A failed
 * teardown is not fatal here — the create pass reports its consequences as
 * duplicate ids, which is what triggers the repair pass — so the error is only
 * logged to keep the reason next to its cause.
 */
function removeAllMenus(): Promise<void> {
  return new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => {
      const error = chrome.runtime.lastError;
      if (error) console.warn('[Lumo] Failed to clear context menus:', error.message);
      resolve();
    });
  });
}

/** One `chrome.contextMenus.create` call the browser rejected. */
interface MenuCreateFailure {
  id: string;
  message: string;
  /** Whether the browser rejected the id as already taken. */
  duplicateId: boolean;
}

/** Create properties whose id is known, so a failure can name the item. */
type MenuCreateProperties = chrome.contextMenus.CreateProperties & { id: string };

/**
 * The `chrome.contextMenus` context each scope binds to.
 *
 * Typed off `create`'s own parameter so it satisfies the non-empty mutable tuple
 * the API requires, instead of restating that shape by hand.
 */
type MenuContexts = NonNullable<chrome.contextMenus.CreateProperties['contexts']>;

const SCOPE_CONTEXTS: Record<QuickActionScope, MenuContexts> = {
  page: ['page'],
  selection: ['selection'],
  image: ['image'],
};

/**
 * Create every item for `locale` and report the ones the browser rejected.
 *
 * All calls are issued synchronously — parents before children, so a parent
 * exists by the time its child is processed — and only then awaited. Collecting
 * the callbacks is what turns a failure from an "Unchecked runtime.lastError" in
 * the console into something the rebuild can act on, and it collapses a full
 * failed pass into a single log line instead of one per item.
 */
async function createMenuItems(locale: LocaleBundle): Promise<MenuCreateFailure[]> {
  const pending: Promise<MenuCreateFailure | undefined>[] = [];

  const create = (properties: MenuCreateProperties) => {
    pending.push(
      new Promise<MenuCreateFailure | undefined>((resolve) => {
        chrome.contextMenus.create(properties, () => {
          // Reading `lastError` marks it handled; otherwise Chrome logs it as an
          // unchecked error and the rebuild learns nothing about the failure.
          const error = chrome.runtime.lastError;
          if (!error) return resolve(undefined);
          const message = error.message ?? 'unknown error';
          resolve({ id: properties.id, message, duplicateId: /duplicate/i.test(message) });
        });
      }),
    );
  };

  // One parent per scope. Chrome shows a parent only when at least one child
  // matches the current context, so an empty scope simply never appears.
  const scopes = Object.keys(QUICK_ACTION_PARENT_IDS) as QuickActionScope[];
  for (const scope of scopes) {
    create({
      id: QUICK_ACTION_PARENT_IDS[scope],
      title: locale.sidebar.contextMenu.root,
      contexts: SCOPE_CONTEXTS[scope],
    });
  }

  for (const action of QUICK_ACTIONS) {
    const title = resolvePath(locale, quickActionTitlePath(action));
    if (!title) continue; // Missing translation: skip rather than show a raw key.
    create({
      id: action.id,
      parentId: QUICK_ACTION_PARENT_IDS[action.scope],
      title,
      contexts: SCOPE_CONTEXTS[action.scope],
    });
  }

  const results = await Promise.all(pending);
  return results.filter((failure): failure is MenuCreateFailure => failure !== undefined);
}

/** Logs a pass's rejected items as one line instead of one line per item. */
function reportMenuFailures(failures: MenuCreateFailure[], attempt: RebuildAttempt): void {
  const ids = failures.map((failure) => failure.id).join(', ');
  // Every item of a failed pass usually fails the same way; collapse the reasons
  // so a full rejection stays one readable line.
  const reasons = [...new Set(failures.map((failure) => failure.message))].join('; ');
  console.warn(
    `[Lumo] Context menu ${attempt} pass rejected ${failures.length} item(s): ${ids} (${reasons})`,
  );
}

// ─── Click handler ────────────────────────────────────────────────────────────

function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab,
) {
  const tabId = tab?.id;
  if (!tabId) return;

  const action = findQuickAction(String(info.menuItemId));
  if (!action) return;

  // Open the panel first and unconditionally: the payload write is async, and
  // the panel listens for the storage change, so opening early shortens the
  // perceived latency without risking a missed payload.
  void chrome.sidePanel.open({ tabId });
  void storePendingAction(info, tab, tabId, action);
}

async function storePendingAction(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
  tabId: number,
  action: QuickActionDefinition,
) {
  const locale = await loadLocale();
  const promptPath = quickActionPromptPath(action);
  const prompt = promptPath ? resolvePath(locale, promptPath) : undefined;

  const pageContext: PageContext = {
    tabId,
    title: tab?.title ?? '',
    url: info.pageUrl ?? tab?.url ?? '',
  };

  const pending: ContextMenuPendingData = {
    actionId: action.id,
    type: action.scope === 'selection' ? 'text' : action.scope === 'image' ? 'image' : 'page',
    pageContext,
    prompt,
    // An action with no prompt has nothing to send, so it can never auto-send
    // regardless of how the registry entry is flagged.
    autoSend: action.autoSend && Boolean(prompt),
    targetWindowId: tab?.windowId,
    timestamp: Date.now(),
  };

  if (action.scope === 'selection') {
    const selectedText = info.selectionText?.trim();
    // Chrome only shows selection-scope items when there is a selection, so an
    // empty one means the page cleared it between click and dispatch. The page
    // context still makes the action meaningful, so we keep going.
    if (selectedText) pending.text = selectedText;
  } else if (action.scope === 'image') {
    if (info.srcUrl) pending.imageUrl = info.srcUrl;
  }

  await chrome.storage.session.set({ [CONTEXT_MENU_PENDING_KEY]: pending });
}
