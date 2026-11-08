// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { McpHttpServerConfig } from '@/lib/mcp/types';

/**
 * The MCP add flows moved from inline forms into dialogs, so these tests pin the
 * behaviour that used to be implicit: the dialog opens straight onto the first
 * field, invalid input is reported *next to* the offending control instead of
 * silently doing nothing, and a save receives a trimmed, header-parsed record.
 *
 * `react-i18next` is stubbed with a key-echoing `t`, which makes the assertions
 * about error keys explicit (`options.mcp.errors.invalidUrl`) without coupling
 * them to English copy.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/**
 * The dialog's scan is exercised in `extension-discovery.test.tsx`; here it only
 * has to be deterministic — and off by default, so the field tests below are not
 * racing a probe that will never answer in jsdom.
 */
let installedId: string | null = null;
vi.mock('@/lib/mcp/extension-probe', () => ({
  probeExtension: async (id: string) =>
    id === installedId
      ? {
          ok: true,
          response: {
            ok: true,
            service: { namespace: 'userscripts', name: 'Lumo Userscripts', version: '1.0.2' },
            status: { enabled: true, authorized: false, ready: true },
          },
        }
      : { ok: false, unreachable: true, error: 'Could not establish connection.' },
}));

const { CATALOG_PROVIDERS } = await import('@/lib/mcp/extension-catalog');
const { ServerDialog } = await import('@/entrypoints/options/mcp/ServerDialog');
const { ExtensionDialog } = await import('@/entrypoints/options/mcp/ExtensionDialog');
const { parseHeaderLines, headersToText } = await import('@/entrypoints/options/mcp/validation');

afterEach(cleanup);

/**
 * `Field` appends a `*` to required labels, so the accessible name carries a
 * suffix; matching the prefix keeps these queries readable.
 */
const EXACT_PREFIX = { exact: false };

const NAME_LABEL = 'options.mcp.serverName';
const URL_LABEL = 'options.mcp.serverUrl';
const HEADERS_LABEL = 'options.mcp.headers';
const SUBMIT = 'options.mcp.addServer';

/** Shape of `createServerDraft`, inlined so this test never pulls in `chrome.storage`. */
function blankServerDraft(): McpHttpServerConfig {
  return {
    id: 'external-test',
    name: '',
    description: '',
    transport: 'http-stream',
    url: '',
    enabled: true,
  };
}

function renderServerDialog(overrides: Partial<McpHttpServerConfig> = {}) {
  const onSave = vi.fn(async () => {});
  const onClose = vi.fn();
  const draft: McpHttpServerConfig = { ...blankServerDraft(), ...overrides };
  render(<ServerDialog draft={draft} onSave={onSave} onClose={onClose} />);
  return { onSave, onClose, draft };
}

describe('ServerDialog', () => {
  it('focuses the name field on open instead of the close button', async () => {
    renderServerDialog();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText(NAME_LABEL, EXACT_PREFIX));
    });
  });

  it('reports a missing name and URL instead of silently ignoring submit', () => {
    const { onSave } = renderServerDialog();
    fireEvent.click(screen.getByRole('button', { name: SUBMIT }));

    expect(screen.getAllByText('options.mcp.errors.required')).toHaveLength(2);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('rejects a non-http endpoint with the i18n key, not a hard-coded string', () => {
    const { onSave } = renderServerDialog();
    fireEvent.change(screen.getByLabelText(NAME_LABEL, EXACT_PREFIX), { target: { value: 'Local' } });
    fireEvent.change(screen.getByLabelText(URL_LABEL, EXACT_PREFIX), {
      target: { value: 'ftp://example.com/mcp' },
    });
    fireEvent.click(screen.getByRole('button', { name: SUBMIT }));

    expect(screen.getByText('options.mcp.errors.invalidUrl')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves trimmed fields with parsed headers and closes', async () => {
    const { onSave, onClose, draft } = renderServerDialog();
    fireEvent.change(screen.getByLabelText(NAME_LABEL, EXACT_PREFIX), { target: { value: '  Docs  ' } });
    fireEvent.change(screen.getByLabelText(URL_LABEL, EXACT_PREFIX), {
      target: { value: ' https://example.com/mcp ' },
    });
    fireEvent.change(screen.getByLabelText(HEADERS_LABEL, EXACT_PREFIX), {
      target: { value: 'Authorization: Bearer t\n\nX-Trace: 1' },
    });
    fireEvent.click(screen.getByRole('button', { name: SUBMIT }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      ...draft,
      name: 'Docs',
      url: 'https://example.com/mcp',
      description: '',
      headers: { Authorization: 'Bearer t', 'X-Trace': '1' },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const { onClose } = renderServerDialog();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('renders nothing while the draft is closed', () => {
    const { container } = render(
      <ServerDialog draft={null} onSave={vi.fn(async () => {})} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

const EXTENSION_LABEL = 'options.mcp.extensions.idLabel';
const EXTENSION_SUBMIT = 'options.mcp.extensions.add';
const VALID_ID = 'a'.repeat(32);

describe('ExtensionDialog', () => {
  function renderExtensionDialog(configured: string[] = []) {
    const onSave = vi.fn(async () => {});
    const onClose = vi.fn();
    render(
      <ExtensionDialog
        draft={{ id: '' }}
        configured={configured}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    return { onSave, onClose };
  }

  it('rejects a malformed id', () => {
    const { onSave } = renderExtensionDialog();
    fireEvent.change(screen.getByLabelText(EXTENSION_LABEL, EXACT_PREFIX), { target: { value: 'not-an-id' } });
    fireEvent.click(screen.getByRole('button', { name: EXTENSION_SUBMIT }));

    expect(screen.getByText('options.mcp.extensions.invalidId')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('rejects an id that is already configured', () => {
    const { onSave } = renderExtensionDialog([VALID_ID]);
    fireEvent.change(screen.getByLabelText(EXTENSION_LABEL, EXACT_PREFIX), { target: { value: VALID_ID } });
    fireEvent.click(screen.getByRole('button', { name: EXTENSION_SUBMIT }));

    expect(screen.getByText('options.mcp.extensions.duplicate')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves a valid id and closes', async () => {
    const { onSave, onClose } = renderExtensionDialog();
    fireEvent.change(screen.getByLabelText(EXTENSION_LABEL, EXACT_PREFIX), { target: { value: VALID_ID } });
    fireEvent.click(screen.getByRole('button', { name: EXTENSION_SUBMIT }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(VALID_ID));
    expect(onClose).toHaveBeenCalled();
  });

  it('adds an installed catalog provider in one click and closes on the card', async () => {
    const listing = CATALOG_PROVIDERS[0]?.listings[0];
    if (!listing) throw new Error('catalog has no listings');
    installedId = listing.id;
    try {
      const { onSave, onClose } = renderExtensionDialog();
      const row = await screen.findByRole('button', {
        name: 'options.mcp.extensions.discovery.add',
      });
      fireEvent.click(row);

      await waitFor(() => expect(onSave).toHaveBeenCalledWith(listing.id));
      // No id typing was needed. Both add paths end the same way — the dialog
      // closes — because the provider's own state ("approval needed", tool count)
      // only exists on the card behind it.
      expect(onClose).toHaveBeenCalled();
    } finally {
      installedId = null;
    }
  });

  it('drops the scan block once every catalog provider is configured', () => {
    renderExtensionDialog(CATALOG_PROVIDERS.flatMap((p) => p.listings.map((l) => l.id)));

    expect(
      screen.queryByRole('region', { name: 'options.mcp.extensions.discovery.label' }),
    ).toBeNull();
    expect(screen.getByLabelText(EXTENSION_LABEL, EXACT_PREFIX)).toBeTruthy();
  });
});

describe('header line parsing', () => {
  it('skips blank and malformed lines rather than failing the save', () => {
    expect(parseHeaderLines('A: 1\n\nbroken line\n: empty\nB:2')).toEqual({ A: '1', B: '2' });
  });

  it('returns undefined when nothing is parseable, so the field stays absent', () => {
    expect(parseHeaderLines('   \n')).toBeUndefined();
  });

  it('round-trips through the textarea format', () => {
    const headers = { Authorization: 'Bearer t', 'X-Trace': '1' };
    expect(parseHeaderLines(headersToText(headers))).toEqual(headers);
  });
});
