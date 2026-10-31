/**
 * Lazy locale loader.
 *
 * Fifty-five full translation bundles at ~20 KB each is ~1 MB. Eagerly importing
 * them would put all of that in every entry point — the side panel, the options
 * page and the background service worker — while each session only ever needs
 * one. `import.meta.glob` (without `eager`) emits one chunk per locale, so the
 * active language costs a single local file read and the rest are never fetched.
 *
 * English is the exception: it is the fallback bundle i18next resolves missing
 * keys against, so it is imported statically — and explicitly excluded from the
 * glob below. Without the exclusion the same module would be both statically
 * inlined and dynamically imported, and Rollup would warn that it cannot move
 * `en.json` into its own chunk.
 */

import en from './locales/en.json';
import { DEFAULT_LOCALE } from './locales';

/** Shape of a translation bundle. `en.json` is the canonical schema. */
export type LocaleBundle = typeof en;

const loaders = import.meta.glob<{ default: LocaleBundle }>([
  './locales/*.json',
  '!./locales/en.json',
]);

const cache = new Map<string, LocaleBundle>([[DEFAULT_LOCALE, en as LocaleBundle]]);

/**
 * Load a bundle by BCP-47 tag.
 *
 * Unknown tags resolve to English rather than rejecting: a stale config or a
 * locale Chrome knows but this build does not should degrade to English, never
 * to an empty UI.
 */
export async function loadLocaleBundle(tag: string): Promise<LocaleBundle> {
  const cached = cache.get(tag);
  if (cached) return cached;

  const loader = loaders[`./locales/${tag}.json`];
  if (!loader) return en as LocaleBundle;

  try {
    const module = await loader();
    cache.set(tag, module.default);
    return module.default;
  } catch (error) {
    console.error(`[Lumo] Failed to load locale "${tag}"`, error);
    return en as LocaleBundle;
  }
}

/** Drop a cached bundle (used by tests). */
export function clearLocaleCache(): void {
  cache.clear();
  cache.set(DEFAULT_LOCALE, en as LocaleBundle);
}
