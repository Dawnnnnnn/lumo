/**
 * Release channel detection.
 *
 * The channel is what tells a bug report apart: a store build trails the
 * repository, the Actions build is current but never updates itself, and all of
 * them can be installed side by side as separate extensions. The published
 * extension ids are the only thing available at runtime that distinguishes them —
 * and each store assigns its own id, so the id also names the store. This pins the
 * mapping, including the degenerate cases, because the about page renders in
 * contexts (component tests, a broken `chrome` global) where the id is missing and
 * a throw there would take the whole page down.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHROME_STORE_ID,
  CHROME_STORE_URL,
  EDGE_STORE_ID,
  EDGE_STORE_URL,
  getExtensionId,
  getExtensionVersion,
  getReleaseChannel,
} from '@/lib/extension-info';

/** Install a `chrome` global exposing just what extension-info reads. */
function stubRuntime(runtime: unknown) {
  vi.stubGlobal('chrome', { runtime });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getReleaseChannel', () => {
  it('reports the published Chrome id as the chrome store build', () => {
    stubRuntime({ id: CHROME_STORE_ID, getManifest: () => ({ version: '1.0.6' }) });
    expect(getReleaseChannel()).toBe('chrome');
    expect(getExtensionVersion()).toBe('1.0.6');
  });

  it('reports the published Edge id as the edge store build', () => {
    // Same package, different listing: Edge assigns its own id, and the badge has
    // to name the store the user actually installed from.
    stubRuntime({ id: EDGE_STORE_ID, getManifest: () => ({ version: '1.0.6' }) });
    expect(getReleaseChannel()).toBe('edge');
  });

  it('reports any other id as a github build', () => {
    // The key of an unpacked build is derived from its directory, so this is the
    // shape both the Actions artifact and `wxt dev` take.
    stubRuntime({ id: 'abcdefghijklmnopabcdefghijklmnop', getManifest: () => ({ version: '1.0.6' }) });
    expect(getReleaseChannel()).toBe('github');
  });

  it('falls back to a github build when there is no chrome global', () => {
    vi.stubGlobal('chrome', undefined);
    expect(getReleaseChannel()).toBe('github');
    expect(getExtensionId()).toBe('');
    expect(getExtensionVersion()).toBe('');
  });

  it('survives a runtime without getManifest', () => {
    stubRuntime({ id: CHROME_STORE_ID });
    expect(getExtensionVersion()).toBe('');
    expect(getReleaseChannel()).toBe('chrome');
  });
});

describe('links', () => {
  it('points each store link at its own published listing', () => {
    expect(CHROME_STORE_URL).toContain(CHROME_STORE_ID);
    expect(EDGE_STORE_URL).toContain(EDGE_STORE_ID);
    // The two listings are distinct extensions; one id must never answer for the
    // other, or a user would be sent to the store they are already on.
    expect(EDGE_STORE_URL).not.toContain(CHROME_STORE_ID);
  });
});
