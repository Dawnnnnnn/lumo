// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

/**
 * Discovery is deliberately tiny: `lumo:probe` is read-only, so opening the
 * dialog fires one message per catalog listing and renders whatever answered.
 * No phases, no timers, no "nothing found" shell. What these tests pin is the
 * part with consequences — which id gets stored, that a switched-off provider is
 * not offered, and that a repeat opening re-probes instead of trusting a cache.
 */

/** `id -> responder`; an id with no responder behaves like "not installed". */
const probes = new Map<string, () => Promise<unknown>>();
const probed: string[] = [];

vi.mock('@/lib/mcp/extension-probe', () => ({
  probeExtension: async (id: string) => {
    probed.push(id);
    const responder = probes.get(id);
    if (!responder) {
      return { ok: false, unreachable: true, error: 'Could not establish connection.' };
    }
    return responder();
  },
}));

/** Echo the key and interpolate `{{name}}`, the way the real `t` would. */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options?.name ? `${key} ${options.name}` : key,
  }),
}));

const { CATALOG_PROVIDERS } = await import('@/lib/mcp/extension-catalog');
const { useProviderDiscovery } = await import('@/entrypoints/options/mcp/useProviderDiscovery');
const { ProviderDiscovery } = await import('@/entrypoints/options/mcp/ProviderDiscovery');

const provider = CATALOG_PROVIDERS[0];
if (!provider) throw new Error('catalog is empty: discovery has nothing to scan');
const listingId = (store: string) => provider.listings.find((l) => l.store === store)?.id ?? '';
const CHROME_ID = listingId('chrome');
const EDGE_ID = listingId('edge');
const ALL_IDS = provider.listings.map((listing) => listing.id);

const SERVICE = { namespace: 'userscripts', name: 'Lumo Userscripts', version: '1.0.2' };
const status = (patch: Record<string, unknown> = {}) => ({
  enabled: true,
  authorized: true,
  ready: true,
  ...patch,
});

/** A provider that answers, i.e. is installed. */
function hit(patch: Record<string, unknown> = {}) {
  return async () => ({ ok: true, response: { ok: true, service: SERVICE, status: status(patch) } });
}

type Discovery = ReturnType<typeof useProviderDiscovery>;

function Harness({
  open,
  configured,
  onRender,
}: {
  open: boolean;
  configured: string[];
  onRender: (value: Discovery) => void;
}) {
  onRender(useProviderDiscovery({ open, configured }));
  return null;
}

beforeEach(() => {
  probed.length = 0;
  probes.clear();
});
afterEach(cleanup);

describe('catalog', () => {
  it('covers both published stores, with well-formed ids and no duplicates', () => {
    expect(provider.key).toBe('lumo-userscripts');

    // Not an exact list: a local (unpacked) listing may be present on a
    // development machine, and it must not change what the stores provide.
    const stores = provider.listings.map((listing) => listing.store);
    expect(stores).toEqual(expect.arrayContaining(['chrome', 'edge']));

    const ids = provider.listings.map((listing) => listing.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-p]{32}$/);
  });
});

describe('useProviderDiscovery', () => {
  it('probes nothing while the dialog is closed', () => {
    let latest: Discovery | undefined;
    render(<Harness open={false} configured={[]} onRender={(value) => (latest = value)} />);

    expect(latest?.found).toEqual([]);
    expect(probed).toEqual([]);
  });

  it('probes every listing of the catalog when the dialog opens', async () => {
    let latest: Discovery | undefined;
    render(<Harness open configured={[]} onRender={(value) => (latest = value)} />);

    await waitFor(() => expect(probed.length).toBeGreaterThan(0));
    expect(probed.sort()).toEqual([...ALL_IDS].sort());
  });

  it('keeps the id that answered and ignores the store that stayed silent', async () => {
    probes.set(EDGE_ID, hit());

    let latest: Discovery | undefined;
    render(<Harness open configured={[]} onRender={(value) => (latest = value)} />);

    await waitFor(() => expect(latest?.found).toHaveLength(1));
    expect(latest?.found[0]).toMatchObject({ key: provider.key, extensionId: EDGE_ID });
  });

  it('treats an unanswered probe as absent, not as a failure', async () => {
    probes.set(CHROME_ID, async () => ({ ok: false, error: 'boom' }));

    let latest: Discovery | undefined;
    render(<Harness open configured={[]} onRender={(value) => (latest = value)} />);

    await waitFor(() => expect(probed.length).toBe(ALL_IDS.length));
    expect(latest?.found).toEqual([]);
  });

  it('still offers a provider whose agent endpoint is switched off', async () => {
    // Approval is what turns that switch on, so hiding the row would make the
    // first step unreachable.
    probes.set(CHROME_ID, hit({ enabled: false }));

    let latest: Discovery | undefined;
    render(<Harness open configured={[]} onRender={(value) => (latest = value)} />);

    await waitFor(() => expect(latest?.found).toHaveLength(1));
    expect(latest?.found[0]).toMatchObject({ extensionId: CHROME_ID });
  });

  it('does not offer a provider that is already configured', async () => {
    let latest: Discovery | undefined;
    render(<Harness open configured={ALL_IDS} onRender={(value) => (latest = value)} />);

    expect(latest?.found).toEqual([]);
    expect(probed).toEqual([]);
  });

  it('drops an added provider without probing again', async () => {
    probes.set(CHROME_ID, hit());

    let latest: Discovery | undefined;
    const onRender = (value: Discovery) => (latest = value);
    const { rerender } = render(<Harness open configured={[]} onRender={onRender} />);
    await waitFor(() => expect(latest?.found).toHaveLength(1));

    rerender(<Harness open configured={ALL_IDS} onRender={onRender} />);

    await waitFor(() => expect(latest?.found).toHaveLength(0));
    expect(probed).toHaveLength(ALL_IDS.length);
  });
});

describe('ProviderDiscovery', () => {
  const ADD = 'options.mcp.extensions.discovery.add Lumo Userscripts';
  const discovered = { key: provider.key, provider, extensionId: CHROME_ID };

  it('renders a found provider as a single-click add', async () => {
    const onAdd = vi.fn(async () => {});
    render(<ProviderDiscovery found={[discovered]} onAdd={onAdd} />);

    fireEvent.click(screen.getByRole('button', { name: ADD }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(CHROME_ID));
  });

  it('has no empty state, no rescan and no approval hint of its own', () => {
    const { container } = render(<ProviderDiscovery found={[]} onAdd={vi.fn(async () => {})} />);

    // No rows means no block: the dialog falls back to the plain id field.
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('captions the block and names the region after that caption', () => {
    render(<ProviderDiscovery found={[discovered]} onAdd={vi.fn(async () => {})} />);

    // One visible caption, also the region's accessible name — announced once,
    // and in the same words as the pixels.
    expect(
      screen.getByRole('heading', { name: 'options.mcp.extensions.discovery.label' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('region', { name: 'options.mcp.extensions.discovery.label' }),
    ).toBeTruthy();
  });

  it('makes the row the block, so the hover tint reaches the border', () => {
    render(<ProviderDiscovery found={[discovered]} onAdd={vi.fn(async () => {})} />);

    const row = screen.getByRole('button', { name: ADD });
    const block = row.parentElement as HTMLElement;

    // No inset padding on the container and a full-width row: any padding here
    // would leave the hover highlight floating inside the border.
    expect(block.className).not.toMatch(/(^|\s)p-/);
    expect(block.className).toContain('overflow-hidden');
    expect(row.className).toContain('w-full');
  });
});
