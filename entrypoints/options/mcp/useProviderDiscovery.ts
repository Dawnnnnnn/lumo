import { useEffect, useRef, useState } from 'react';
import { CATALOG_PROVIDERS, type CatalogProvider } from '@/lib/mcp/extension-catalog';
import { probeExtension } from '@/lib/mcp/extension-probe';

/**
 * Which catalog providers are already installed in this browser?
 *
 * `lumo:probe` is read-only, so this is just three messages fired when the dialog
 * opens — no animation, no phases, no minimum display time. The answer arrives in
 * milliseconds and the rows appear; if nothing is installed, nothing appears at
 * all.
 *
 * Deliberately stateless between openings. Caching would only buy a stale
 * answer: the user's usual path is "install the extension, come back, open this
 * dialog", and a cached miss would hide exactly the row they were looking for.
 */

export interface DiscoveredProvider {
  /** Catalog key; stable across rescans and across store ids. */
  key: string;
  provider: CatalogProvider;
  /** The listing id that answered — the value to store in settings. */
  extensionId: string;
}

/**
 * Probe every listing of one provider and keep the first that answers.
 *
 * All ids are in flight at once: only one store's id can be installed in a given
 * browser, so waiting for Chrome before trying Edge would double the time to an
 * answer for no benefit. Listing order still decides ties.
 *
 * A provider whose agent endpoint is switched off still counts as installed: the
 * approval flow is what turns it on (`approvePendingRequest` sets `enabled`), so
 * hiding it would make that first step unreachable.
 */
async function discoverProvider(provider: CatalogProvider): Promise<DiscoveredProvider | undefined> {
  const outcomes = await Promise.all(
    provider.listings.map(async (listing) => ({
      listing,
      outcome: await probeExtension(listing.id),
    })),
  );

  const hit = outcomes.find(({ outcome }) => outcome.ok);
  if (!hit) return undefined;

  return { key: provider.key, provider, extensionId: hit.listing.id };
}

export function useProviderDiscovery(options: {
  /** The dialog is open; closing drops the results rather than keeping them. */
  open: boolean;
  /** Providers already in settings, snapshotted when the scan starts. */
  configured: readonly string[];
}) {
  const { open, configured } = options;

  // Read inside the scan, never in its dependencies: adding a provider must not
  // start a second scan. The dialog hides freshly added rows itself.
  const configuredRef = useRef(configured);
  configuredRef.current = configured;

  const [found, setFound] = useState<DiscoveredProvider[]>([]);

  useEffect(() => {
    if (!open) {
      setFound([]);
      return;
    }

    const known = new Set(configuredRef.current);
    const candidates = CATALOG_PROVIDERS.filter(
      (provider) => !provider.listings.some((listing) => known.has(listing.id)),
    );
    if (candidates.length === 0) {
      setFound([]);
      return;
    }

    let cancelled = false;
    setFound([]);

    void Promise.all(
      // A probe can throw synchronously (no runtime to send from) as well as
      // reject; one bad provider must not swallow the others.
      candidates.map((provider) => discoverProvider(provider).catch(() => undefined)),
    ).then((hits) => {
      if (cancelled) return;
      setFound(hits.filter((hit): hit is DiscoveredProvider => Boolean(hit)));
    });

    return () => {
      cancelled = true;
    };
  }, [open]);

  // Filtered against live settings, so adding a provider removes its row without
  // a second scan — and the block disappears with the last one.
  const configuredSet = new Set(configured);
  return { found: found.filter((entry) => !configuredSet.has(entry.extensionId)) };
}
