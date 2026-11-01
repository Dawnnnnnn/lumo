import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, ArrowDown, ArrowUp, Zap } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@radix-ui/react-tooltip';
import { Button } from '@/components/ui/button';
import type { TokenUsageStats, TokenUsageStep } from '@/types';

interface TokenUsageTooltipProps {
  usage: TokenUsageStats;
}

/**
 * A small dashboard-style button that shows token usage stats on hover.
 * Renders as an icon button inside MessageActions, with a rich tooltip
 * displaying the full breakdown.
 *
 * The agent loop is uncapped by default (`lib/max-steps.ts`), so a browsing turn
 * routinely runs dozens — sometimes hundreds — of steps. Radix's popper only
 * shifts and flips its content, it never resizes it, so an unclamped step list
 * simply grows past the top of the sidepanel. The content therefore takes its
 * `max-height` from `--radix-tooltip-content-available-height` (the real space
 * left on the chosen side, after `collisionPadding`) and lets the step list —
 * not the summary — absorb the deficit as a scroll area.
 *
 * Portalled to `body` so the fixed position cannot be captured by an animating
 * ancestor (`motion.div` sets a transform) and clipped by the message scroller.
 */
export function TokenUsageTooltip({ usage }: TokenUsageTooltipProps) {
  const { t } = useTranslation();

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 rounded-md text-muted-foreground hover:text-foreground"
            aria-label={t('sidebar.tokenUsage')}
          >
            <Activity className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent
            side="top"
            align="end"
            sideOffset={6}
            collisionPadding={8}
            className="z-50 flex max-h-[var(--radix-tooltip-content-available-height)] flex-col overflow-hidden rounded-lg border border-border bg-popover px-3 py-2.5 shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
            <UsagePanel usage={usage} />
          </TooltipContent>
        </TooltipPortal>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The hover breakdown: a fixed summary plus a scrollable per-step ledger.
 *
 * Exported so the height/scroll contract can be asserted without going through
 * Radix's hover machinery (the content only mounts while open).
 */
export function UsagePanel({ usage }: { usage: TokenUsageStats }) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);
  const steps = usage.steps ?? [];

  // Open at the newest step: the panel is a ledger, and while a run is in flight
  // the last row is the one that keeps changing. `steps.length` re-pins the list
  // if more steps land while the panel stays open.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [steps.length]);

  return (
    <div className="flex min-h-0 min-w-[180px] flex-col gap-1.5 overflow-hidden">
      {/* Everything above the ledger keeps its size; the ledger gives way. */}
      <div className="shrink-0 space-y-1.5">
        <div className="text-[0.6875rem] font-medium text-foreground">
          {t('sidebar.tokenUsage')}
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[0.625rem] font-mono tabular-nums">
          <StatRow label={t('sidebar.tokenInput')} value={usage.inputTokens} />
          <StatRow label={t('sidebar.tokenOutput')} value={usage.outputTokens} />
          {(usage.cacheReadTokens ?? 0) > 0 && (
            <StatRow
              label={t('sidebar.tokenCacheRead')}
              value={usage.cacheReadTokens!}
              className="text-green-600 dark:text-green-400"
            />
          )}
          {(usage.cacheWriteTokens ?? 0) > 0 && (
            <StatRow
              label={t('sidebar.tokenCacheWrite')}
              value={usage.cacheWriteTokens!}
              className="text-amber-600 dark:text-amber-400"
            />
          )}
          {(usage.reasoningTokens ?? 0) > 0 && (
            <StatRow
              label={t('sidebar.tokenReasoning')}
              value={usage.reasoningTokens!}
              className="text-purple-600 dark:text-purple-400"
            />
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border/50 pt-1 text-[0.625rem] font-mono tabular-nums">
          <span className="text-muted-foreground">{t('sidebar.tokenTotal')}</span>
          <span className="font-medium text-foreground">
            {usage.totalTokens.toLocaleString()}
          </span>
        </div>
      </div>

      {/* Per-step breakdown (only if multi-step) */}
      {steps.length > 1 && (
        <div className="flex min-h-0 flex-col border-t border-border/50 pt-1">
          <div className="flex shrink-0 items-baseline justify-between pb-0.5 text-[0.6rem] uppercase tracking-wide text-muted-foreground/70">
            <span>{t('sidebar.tokenSteps')}</span>
            <span className="font-mono tabular-nums">{steps.length}</span>
          </div>
          <div
            ref={listRef}
            data-testid="token-usage-steps"
            className="min-h-0 overflow-y-auto overscroll-contain scrollbar-lumo -me-1.5 pe-1.5"
          >
            <div className="space-y-0.5 py-0.5">
              {steps.map((step) => (
                <StepRow key={step.step} step={step} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One step of the ledger.
 *
 * Glyphs are Lucide icons rather than `↑ ↓ ⚡`: the text arrows inherit whatever
 * font fallback the platform picks and the lightning bolt renders as a colour
 * emoji on most systems, so the same row came out in three different weights and
 * styles. Each metric keeps its name in `title` so the icon is not the only
 * carrier of meaning.
 */
function StepRow({ step }: { step: TokenUsageStep }) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-1.5 text-[0.6rem] font-mono tabular-nums text-muted-foreground">
      <span className="min-w-[2.5ch] shrink-0 text-end text-muted-foreground/60">
        #{step.step + 1}
      </span>
      <Metric
        icon={<ArrowUp className="size-2.5" aria-hidden="true" />}
        label={t('sidebar.tokenInput')}
        value={step.inputTokens}
      />
      <Metric
        icon={<ArrowDown className="size-2.5" aria-hidden="true" />}
        label={t('sidebar.tokenOutput')}
        value={step.outputTokens}
      />
      {(step.cacheReadTokens ?? 0) > 0 && (
        <Metric
          icon={<Zap className="size-2.5" aria-hidden="true" />}
          label={t('sidebar.tokenCacheRead')}
          value={step.cacheReadTokens!}
          className="text-green-600 dark:text-green-400"
        />
      )}
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  className,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  className?: string;
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap"
      title={label}
    >
      <span className="shrink-0 text-muted-foreground/50">{icon}</span>
      <span className={className}>{value.toLocaleString()}</span>
    </span>
  );
}

function StatRow({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className?: string;
}) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className={className ?? 'text-foreground/80'}>
        {value.toLocaleString()}
      </span>
    </>
  );
}
