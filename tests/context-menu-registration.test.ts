/**
 * Right-click menu registration must be idempotent under concurrency.
 *
 * `chrome.contextMenus.removeAll` and every `create` are asynchronous round
 * trips, and a rebuild resolves its locale bundle in between. Two rebuilds in
 * flight at once — the service worker cold-starting while a stored language
 * change arrives — therefore both finish removing before either creates, and the
 * second pass collides with every id the first one just added. That produced one
 * "Cannot create item with duplicate id" per menu item (sixteen lines) and left
 * the menu holding whichever pass happened to win.
 *
 * The fake below models the real API contract closely enough to catch it: menu
 * items live in the browser, `removeAll` clears them asynchronously, `create`
 * fails when an id is taken, and `runtime.lastError` is only defined for the
 * duration of a callback.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { en } from '@/i18n/en';
import { zh } from '@/i18n/zh';
import { QUICK_ACTIONS, QUICK_ACTION_PARENT_IDS } from '@/lib/quick-actions';

/** Every item a rebuild is expected to leave behind: one root per scope plus each action. */
const EXPECTED_ITEM_COUNT = QUICK_ACTIONS.length + Object.keys(QUICK_ACTION_PARENT_IDS).length;

interface FakeMenuItem {
  id: string;
  parentId?: string | number;
  title?: string;
}

type StorageChangeListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
) => void;

interface FakeChromeOptions {
  /** Latency of `chrome.storage.local.get`, which is what widens the race window. */
  storageDelayMs?: number;
  /** Latency of `removeAll`. */
  removeDelayMs?: number;
  /**
   * Items already present in the browser when the extension starts, plus the ids
   * the *first* `removeAll` fails to clear — i.e. a browser that still holds
   * items the extension believes it removed, which is what a duplicate-id
   * rejection means in practice.
   */
  staleItems?: string[];
  /** Makes the settings read reject, so the rebuild must fall back to English. */
  storageFails?: boolean;
}

function installFakeChrome(options: FakeChromeOptions = {}) {
  const items = new Map<string, FakeMenuItem>();
  // Ids the browser rejected as already taken, in creation order.
  const duplicateErrors: string[] = [];
  const changeListeners: StorageChangeListener[] = [];
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const settings: { language: string } = { language: 'en' };

  for (const id of options.staleItems ?? []) {
    items.set(id, { id, title: 'stale' });
  }

  let removeAllCalls = 0;
  // Outstanding timers, so `settle()` can tell "the chain is thinking" from
  // "the chain is done".
  let inFlight = 0;
  let lastError: { message: string } | undefined;

  const later = (run: () => void, delay: number) => {
    inFlight += 1;
    setTimeout(() => {
      inFlight -= 1;
      run();
    }, delay);
  };

  const stub = {
    runtime: {
      get lastError() {
        return lastError;
      },
    },
    i18n: { getUILanguage: () => 'en' },
    storage: {
      local: {
        get: (key: string) => {
          if (options.storageFails) return Promise.reject(new Error('storage unavailable'));
          return new Promise<Record<string, unknown>>((resolve) => {
            later(() => resolve({ [key]: { ...settings } }), options.storageDelayMs ?? 0);
          });
        },
      },
      onChanged: {
        addListener: (listener: StorageChangeListener) => changeListeners.push(listener),
      },
    },
    contextMenus: {
      onClicked: { addListener: () => {} },
      removeAll: (callback: () => void) => {
        removeAllCalls += 1;
        const survivors = removeAllCalls === 1 ? (options.staleItems ?? []) : [];
        later(() => {
          for (const id of [...items.keys()]) {
            if (!survivors.includes(id)) items.delete(id);
          }
          callback();
        }, options.removeDelayMs ?? 0);
      },
      create: (properties: FakeMenuItem, callback?: () => void) => {
        later(() => {
          const id = String(properties.id);
          if (items.has(id)) {
            duplicateErrors.push(id);
            lastError = { message: `Cannot create item with duplicate id ${id}` };
          } else {
            items.set(id, { id, parentId: properties.parentId, title: properties.title });
            lastError = undefined;
          }
          try {
            callback?.();
          } finally {
            // Chrome only defines `lastError` for the duration of the callback.
            lastError = undefined;
          }
        }, 0);
      },
    },
  };

  vi.stubGlobal('chrome', stub);

  return {
    items,
    duplicateErrors,
    warn,
    get removeAllCalls() {
      return removeAllCalls;
    },

    /** Waits until no menu call is outstanding any more. */
    async settle() {
      for (let tick = 0; tick < 400; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (inFlight > 0) continue;
        // One more turn: a resolved step schedules the next one as a microtask.
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (inFlight === 0) return;
      }
      throw new Error('the fake chrome never settled');
    },

    /** Simulates the language field of `uiSettings` changing in another context. */
    setLanguage(next: string) {
      const previous = settings.language;
      settings.language = next;
      const changes = {
        uiSettings: { oldValue: { language: previous }, newValue: { language: next } },
      };
      for (const listener of changeListeners) listener(changes, 'local');
    },
  };
}

/** Imports the module under test with fresh rebuild state. */
async function loadSubject() {
  vi.resetModules();
  return import('@/lib/context-menu');
}

describe('context menu registration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('creates each item once when a rebuild is superseded mid-flight', async () => {
    const browser = installFakeChrome({ storageDelayMs: 10, removeDelayMs: 5 });
    const { registerContextMenus } = await loadSubject();

    registerContextMenus();
    // Let the first pass reach its locale await, then change the language: the
    // exact window in which the old implementation had already queued its
    // creates without having removed anything.
    await new Promise((resolve) => setTimeout(resolve, 1));
    browser.setLanguage('zh');
    await browser.settle();

    expect(browser.duplicateErrors).toEqual([]);
    expect(browser.items.size).toBe(EXPECTED_ITEM_COUNT);
    // The superseded pass bailed out before touching the live menu, so the only
    // teardown is the one belonging to the pass that actually built it.
    expect(browser.removeAllCalls).toBe(1);
    expect(browser.warn).not.toHaveBeenCalled();
  });

  it('wires every action under its scope root', async () => {
    const browser = installFakeChrome();
    const { registerContextMenus } = await loadSubject();

    registerContextMenus();
    await browser.settle();

    for (const scope of Object.keys(QUICK_ACTION_PARENT_IDS) as Array<
      keyof typeof QUICK_ACTION_PARENT_IDS
    >) {
      const rootId = QUICK_ACTION_PARENT_IDS[scope];
      expect(browser.items.get(rootId)?.parentId).toBeUndefined();
      for (const action of QUICK_ACTIONS.filter((entry) => entry.scope === scope)) {
        expect(browser.items.get(action.id)?.parentId).toBe(rootId);
      }
    }
  });

  it('repairs the menu once when stale items survive the teardown', async () => {
    const browser = installFakeChrome({
      removeDelayMs: 1,
      staleItems: ['lumo-root-page', 'lumo-page-ask'],
    });
    const { registerContextMenus } = await loadSubject();

    registerContextMenus();
    await browser.settle();

    // Both stale ids were rejected exactly once, then the repair pass cleared
    // the browser's menu and rebuilt it completely.
    expect(browser.duplicateErrors).toEqual(['lumo-root-page', 'lumo-page-ask']);
    expect(browser.removeAllCalls).toBe(2);
    expect(browser.items.size).toBe(EXPECTED_ITEM_COUNT);
    // A whole failed pass is one log line, not one per item.
    expect(browser.warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to English when the stored language cannot be read', async () => {
    const browser = installFakeChrome({ storageFails: true });
    const { registerContextMenus } = await loadSubject();

    registerContextMenus();
    await browser.settle();

    expect(browser.items.size).toBe(EXPECTED_ITEM_COUNT);
    expect(browser.items.get('lumo-root-page')?.title).toBe(en.sidebar.contextMenu.root);
  });

  it('retitles the menu in place when the language changes', async () => {
    const browser = installFakeChrome({ storageDelayMs: 2 });
    const { registerContextMenus } = await loadSubject();

    registerContextMenus();
    await browser.settle();
    expect(browser.items.get('lumo-root-page')?.title).toBe(en.sidebar.contextMenu.root);

    browser.setLanguage('zh');
    await browser.settle();

    expect(browser.duplicateErrors).toEqual([]);
    expect(browser.items.size).toBe(EXPECTED_ITEM_COUNT);
    expect(browser.items.get('lumo-root-page')?.title).toBe(zh.sidebar.contextMenu.root);
  });
});
