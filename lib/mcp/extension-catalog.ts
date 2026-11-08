/**
 * Curated list of extensions known to serve MCP to Lumo.
 *
 * The dialog cannot ask "which extensions are installed?": `chrome.management`
 * would mean a "manage your apps and extensions" permission on every install,
 * for a feature that is a convenience. So discovery works the other way round —
 * a short list of ids we can name, each probed with the same L0 message every
 * provider already answers (`extension-probe.ts`). An id that answers is
 * installed and speaks the protocol; an id that rejects is simply absent.
 *
 * Every store assigns its own id to the same source, so one provider is one
 * entry with several listings. Edge installs the Edge id, Chrome the Chrome id,
 * and the scan keeps whichever one answered.
 */

export type ExtensionStore =
  | 'chrome'
  | 'edge'
  /**
   * An unpacked build (`load unpacked`, `wxt dev`). Its id is derived from the
   * directory it was loaded from, so it only exists on the machine that built it
   * — the same rule Lumo's own `lib/extension-info.ts` uses to call non-store
   * builds "local".
   */
  | 'local';

export interface CatalogListing {
  store: ExtensionStore;
  /** Extension id as published on that store. */
  id: string;
}

export interface CatalogProvider {
  /** Stable key for React lists and dismissal state, not an extension id. */
  key: string;
  /**
   * Brand name, deliberately untranslated: the provider reports the same string
   * in its own probe response, and a translated label would disagree with what
   * the card shows after adding it.
   */
  name: string;
  listings: readonly CatalogListing[];
}

export const CATALOG_PROVIDERS: readonly CatalogProvider[] = [
  {
    key: 'lumo-userscripts',
    name: 'Lumo Userscripts',
    listings: [
      // TEMP (local testing): the unpacked build's id on one development
      // machine. Listed first so a machine that has both builds resolves to the
      // one being developed. Delete this entry before shipping.
      { store: 'local', id: 'obkobbonakfdjloobfkkamfpdmeifaga' },
      { store: 'chrome', id: 'cifapeigdoopgjmliljlbboidgncpdeg' },
      { store: 'edge', id: 'bdommoplclgbhmnomicnodjfbknkkfnb' },
    ],
  },
];
