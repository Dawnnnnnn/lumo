// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ContextUsage } from '@/lib/context-usage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { percent?: string }) => `${key}|${opts?.percent ?? ''}`,
  }),
}));

const { ContextUsageRing } = await import('@/components/chat/ContextUsageRing');
const { ContextUsagePanel } = await import('@/components/chat/ContextUsagePanel');

afterEach(cleanup);

function usage(overrides: Partial<ContextUsage> = {}): ContextUsage {
  return {
    tokens: 10_000,
    contextWindow: 1_000_000,
    percent: 1,
    estimated: false,
    inputTokens: 9_000,
    outputTokens: 1_000,
    trailingTokens: 0,
    ...overrides,
  };
}

describe('ContextUsageRing', () => {
  it('renders a measured percentage when a real usage anchored it', () => {
    render(<ContextUsageRing usage={usage({ percent: 12.4 })} />);
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-label')).toBe('sidebar.contextUsageLabel|12%');
    expect(button.textContent).not.toContain('?');
  });

  it('renders an empty gauge, not a glyph, when the number is only an estimate', () => {
    const { container } = render(
      <ContextUsageRing usage={usage({ estimated: true, percent: 100, tokens: 1_000_000 })} />,
    );
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
      'sidebar.contextUsage|',
    );
    // The arc is either drawn or absent; "?" belongs to the tooltip only.
    expect(container.textContent).toBe('');
  });

  it('never escalates a purely estimated number to the destructive tone', () => {
    const { container } = render(
      <ContextUsageRing usage={usage({ estimated: true, percent: 100 })} />,
    );
    expect(container.querySelector('.text-destructive')).toBeNull();
    expect(container.querySelector('.text-amber-500')).toBeNull();
  });

  it('still escalates a measured number past 90%', () => {
    const { container } = render(
      <ContextUsageRing usage={usage({ estimated: false, percent: 95 })} />,
    );
    expect(container.querySelector('.text-destructive')).not.toBeNull();
  });
});

describe('ContextUsagePanel', () => {
  it('keeps the unknown glyph inside the tooltip', () => {
    // The ring itself shows nothing when unmeasured, so this is the only place
    // the "not measured" state is explained.
    const { container } = render(
      <ContextUsagePanel usage={usage({ estimated: true })} pendingTokens={0} />,
    );
    expect(container.textContent).toContain('?');
  });
  it('shows em dashes instead of zeroes while the size is unknown', () => {
    const { container } = render(
      <ContextUsagePanel usage={usage({ estimated: true })} pendingTokens={1234} />,
    );
    expect(container.textContent).toContain('—');
    // A projection on top of an unknown base would be meaningless.
    expect(container.textContent).not.toContain('+1.2K');
  });

  it('shows the exact breakdown once a real usage anchored it', () => {
    const { container } = render(
      <ContextUsagePanel usage={usage({ percent: 12.34 })} pendingTokens={0} />,
    );
    expect(container.textContent).toContain('12.3%');
    expect(container.textContent).not.toContain('—');
  });

  it('never lists cache reads/writes, which do not size the window', () => {
    // Cache tokens are a billing subset of `inputTokens`; showing them beside
    // an occupancy figure reads as double-counting.
    const { container } = render(
      <ContextUsagePanel
        usage={usage({ inputTokens: 9_989, outputTokens: 265, tokens: 10_300 })}
        pendingTokens={0}
      />,
    );
    expect(container.textContent).not.toContain('sidebar.tokenCacheRead');
    expect(container.textContent).not.toContain('sidebar.tokenCacheWrite');
  });
});
