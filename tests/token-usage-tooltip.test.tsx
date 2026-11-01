// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { TokenUsageStats } from '@/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { UsagePanel } = await import('@/components/chat/TokenUsageTooltip');

afterEach(cleanup);

/** A turn with `count` steps, mirroring the shape `lib/ai.ts` accumulates. */
function usageWithSteps(count: number): TokenUsageStats {
  const steps = Array.from({ length: count }, (_, step) => ({
    step,
    inputTokens: 20_000 + step * 700,
    outputTokens: 90 + step,
    totalTokens: 20_090 + step * 701,
    cacheReadTokens: 19_800 + step * 700,
  }));
  return {
    inputTokens: 1_200_000,
    outputTokens: 5_400,
    totalTokens: 1_205_400,
    cacheReadTokens: 1_190_000,
    steps,
  };
}

describe('UsagePanel', () => {
  it('keeps the summary outside the scroll area and every step inside it', () => {
    render(<UsagePanel usage={usageWithSteps(57)} />);

    const ledger = screen.getByTestId('token-usage-steps');
    // Everything that must stay readable at any step count — the summary and the
    // "Steps · 57" caption — has to live outside the element that scrolls.
    expect(ledger.textContent).not.toContain('sidebar.tokenTotal');
    expect(ledger.textContent).not.toContain('sidebar.tokenInput');
    const caption = screen.getByText('sidebar.tokenSteps').parentElement!;
    expect(caption.contains(ledger)).toBe(false);
    expect(caption.textContent).toContain('57');

    // All 57 rows are rendered (no virtualization / truncation of the ledger),
    // and the last one is the newest step rather than the first.
    expect(ledger.textContent).toContain('#57');
    expect(ledger.textContent).toContain('#1');
    expect(ledger.textContent).not.toContain('#58');
  });

  it('is the only scroller, so a long turn can never push the panel off-screen', () => {
    const { container } = render(<UsagePanel usage={usageWithSteps(200)} />);

    const scrollers = Array.from(container.querySelectorAll('*')).filter((el) =>
      /overflow-y-auto/.test(el.className),
    );
    expect(scrollers).toHaveLength(1);
    const ledger = screen.getByTestId('token-usage-steps');
    expect(scrollers).toEqual([ledger]);
    // Shrinkable inside a height-clamped flex column: without `min-h-0` the
    // ledger refuses to give way and the panel overflows again.
    expect(ledger.className).toContain('min-h-0');
    expect(ledger.className).toContain('scrollbar-lumo');
  });

  it('draws metric glyphs as icons instead of platform-dependent text', () => {
    const { container } = render(<UsagePanel usage={usageWithSteps(3)} />);

    // The old glyphs came out as a colour emoji (⚡) and two font-dependent
    // arrows on different systems; both are gone from the DOM.
    expect(container.textContent).not.toMatch(/[↑↓⚡]/);
    const ledger = screen.getByTestId('token-usage-steps');
    // Three metrics per row, each with its own svg.
    expect(ledger.querySelectorAll('svg')).toHaveLength(3 * 3);
    // Icons are decorative; the metric name travels in `title`.
    const titled = Array.from(ledger.querySelectorAll('[title]')).map((el) =>
      el.getAttribute('title'),
    );
    expect(titled).toContain('sidebar.tokenInput');
    expect(titled).toContain('sidebar.tokenOutput');
    expect(titled).toContain('sidebar.tokenCacheRead');
  });

  it('omits the ledger for a single-step turn', () => {
    render(<UsagePanel usage={usageWithSteps(1)} />);

    expect(screen.queryByTestId('token-usage-steps')).toBeNull();
    expect(screen.queryByText('sidebar.tokenSteps')).toBeNull();
    // The summary still renders.
    expect(screen.getByText('sidebar.tokenTotal')).toBeTruthy();
  });

  it('renders the summary even when the step list is absent', () => {
    render(
      <UsagePanel
        usage={{ inputTokens: 1_234, outputTokens: 56, totalTokens: 1_290 }}
      />,
    );

    expect(screen.getByText('sidebar.tokenTotal')).toBeTruthy();
    expect(screen.getByText('1,234')).toBeTruthy();
    expect(screen.getByText('1,290')).toBeTruthy();
  });
});
