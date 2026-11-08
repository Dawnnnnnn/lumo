/**
 * Which build of Lumo is running, and where it came from.
 *
 * A published listing deliberately lags the repository — every release has to
 * pass that store's review — and the GitHub Actions artifact installs as a
 * *separate* extension, so a user can easily be running several at once. Nothing
 * in the UI used to say which one a given window belonged to, which made
 * version-specific bug reports guesswork.
 *
 * The channel is derived from the extension id: an id is assigned by a store at
 * publish time and cannot be forged by a local build, so the published ids are
 * the one reliable discriminator available at runtime. Each store assigns its
 * own id, so the id also says *which* listing. Everything else — the Actions
 * artifact, `load unpacked`, `wxt dev` — gets a key generated from the unpacked
 * directory, so it is "github" by elimination.
 */

/** Extension id of the published Chrome Web Store listing. */
export const CHROME_STORE_ID = 'cgfnadidpooocnkalljpdmelmaponefa';

/** Extension id of the published Microsoft Edge Add-ons listing. */
export const EDGE_STORE_ID = 'ngbkkjamclloepccimlbfffkcablpahh';

export const CHROME_STORE_URL = `https://chromewebstore.google.com/detail/lumo/${CHROME_STORE_ID}`;
export const EDGE_STORE_URL = `https://microsoftedge.microsoft.com/addons/detail/lumo/${EDGE_STORE_ID}`;
export const GITHUB_REPO_URL = 'https://github.com/mscststs/lumo';

/** Where this build came from. See the note above on how it is decided. */
export type ReleaseChannel = 'chrome' | 'edge' | 'github';

/** Published listing ids, mapped to the channel they name. */
const CHANNEL_BY_ID = new Map<string, ReleaseChannel>([
  [CHROME_STORE_ID, 'chrome'],
  [EDGE_STORE_ID, 'edge'],
]);

/**
 * `chrome.runtime`, or `undefined` outside an extension context.
 *
 * The About page is rendered in component tests too, and a missing global must
 * degrade to "unknown" rather than throw during render.
 */
function runtime(): typeof chrome.runtime | undefined {
  return typeof chrome !== 'undefined' ? chrome.runtime : undefined;
}

export function getExtensionId(): string {
  return runtime()?.id ?? '';
}

/** Manifest version, i.e. the `version` field of `package.json` at build time. */
export function getExtensionVersion(): string {
  try {
    return runtime()?.getManifest?.()?.version ?? '';
  } catch {
    return '';
  }
}

export function getReleaseChannel(): ReleaseChannel {
  return CHANNEL_BY_ID.get(getExtensionId()) ?? 'github';
}
