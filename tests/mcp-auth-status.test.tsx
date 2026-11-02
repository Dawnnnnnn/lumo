// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { McpHttpServerConfig, McpServerState } from '@/lib/mcp/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { ExternalServerCard } = await import('@/entrypoints/options/mcp/ExternalServerCard');
const { StatusBadge, ServerExpandedContent } = await import(
  '@/entrypoints/options/mcp/ServerCardParts'
);

afterEach(cleanup);

const config: McpHttpServerConfig = {
  id: 'script-hub',
  name: 'ScriptHub',
  description: '',
  transport: 'http-stream',
  url: 'https://sh.397710.xyz/mcp',
  enabled: true,
};

function state(overrides: Partial<McpServerState> = {}): McpServerState {
  return {
    info: {
      id: config.id,
      name: config.name,
      description: '',
      transport: 'http-stream',
      builtin: false,
      enabled: true,
    },
    status: 'unauthorized',
    tools: [],
    ...overrides,
  };
}

function renderCard(overrides: Partial<McpServerState> = {}) {
  const handlers = {
    onToggle: vi.fn(),
    onReconnect: vi.fn(),
    onAuthorize: vi.fn(),
    onSignOut: vi.fn(),
    onDelete: vi.fn(),
    onToggleEnabled: vi.fn(),
  };
  render(
    <ExternalServerCard
      state={state(overrides)}
      config={config}
      expanded
      {...handlers}
    />,
  );
  return handlers;
}

/**
 * A `401` challenge is a waiting state, not a fault. The card has to say so and
 * offer the one action that ends the wait — in the slot where "reconnect" sits,
 * so no second control appears for the same job.
 */
describe('authorization states on the server card', () => {
  it('reports the challenge as its own state', () => {
    render(<StatusBadge status="unauthorized" />);
    expect(screen.getByText('options.mcp.unauthorized')).toBeTruthy();
  });

  it('turns the reconnect affordance into sign-in', () => {
    const handlers = renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'options.mcp.signIn' }));

    expect(handlers.onAuthorize).toHaveBeenCalledTimes(1);
    expect(handlers.onReconnect).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'options.mcp.reconnect' })).toBeNull();
  });

  it('acknowledges the click while the window is being prepared', () => {
    renderCard({ status: 'authorizing' });

    const button = screen.getByRole('button', { name: 'options.mcp.signIn' }) as HTMLButtonElement;
    // Still the sign-in affordance, but busy and not clickable twice.
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('options.mcp.authorizing')).toBeTruthy();
  });

  it('keeps the reconnect affordance for every other state', () => {
    const handlers = renderCard({ status: 'error' });

    fireEvent.click(screen.getByRole('button', { name: 'options.mcp.reconnect' }));

    expect(handlers.onReconnect).toHaveBeenCalledTimes(1);
    expect(handlers.onAuthorize).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'options.mcp.signIn' })).toBeNull();
  });

  it('offers sign out while a grant exists', () => {
    const handlers = renderCard({ status: 'connected', hasCredentials: true });

    fireEvent.click(screen.getByRole('button', { name: 'options.mcp.signOut' }));

    expect(handlers.onSignOut).toHaveBeenCalledTimes(1);
  });

  it('offers sign out to clear a half-finished attempt', () => {
    const handlers = renderCard({ status: 'unauthorized' });

    fireEvent.click(screen.getByRole('button', { name: 'options.mcp.signOut' }));

    expect(handlers.onSignOut).toHaveBeenCalledTimes(1);
  });

  it('stays out of the way when there is nothing to revoke', () => {
    renderCard({ status: 'disconnected' });

    expect(screen.queryByRole('button', { name: 'options.mcp.signOut' })).toBeNull();
  });

  it('explains the manual-token fallback one layer down', () => {
    render(
      <ServerExpandedContent
        state={state({
          status: 'unauthorized',
          authError: {
            reason: 'no-registration',
            detail: 'Incompatible auth server: does not support dynamic client registration',
          },
        })}
        config={config}
      />,
    );

    // The sentence is the translated reason; the SDK text is context underneath
    // it, never the headline of a localized card.
    expect(screen.getByText('options.mcp.authReasonNoRegistration')).toBeTruthy();
    expect(
      screen.getByText('Incompatible auth server: does not support dynamic client registration'),
    ).toBeTruthy();
  });

  it('keeps a plain failure free of authorization hints', () => {
    render(
      <ServerExpandedContent state={state({ status: 'error', error: 'HTTP 500' })} config={config} />,
    );

    expect(screen.getByText('HTTP 500')).toBeTruthy();
    expect(screen.queryByText('options.mcp.authReasonNoRegistration')).toBeNull();
  });
});
