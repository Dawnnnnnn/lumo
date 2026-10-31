import { useTranslation } from 'react-i18next';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@radix-ui/react-tooltip';
import type { ContextUsage } from '@/lib/context-usage';
import { cn } from '@/lib/utils';
import { ContextUsagePanel } from '@/components/chat/ContextUsagePanel';

const SIZE = 18;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface ContextUsageRingProps {
  usage: ContextUsage;
  /**
   * Tokens the current unsent draft would add. Rendered in the tooltip as a
   * "pending" projection only — deliberately excluded from the arc so a number
   * that changes on every keystroke cannot make the ring jitter.
   */
  pendingTokens?: number;
}

/**
 * A glanceable context-window gauge for the composer footer.
 *
 * The arc and its tone are the whole message at rest; the breakdown lives in a
 * hover tooltip, so the composer keeps its information density without a single
 * line of explanatory text. Color is the only escalation: muted under 70%,
 * warning past 70%, destructive past 90%.
 *
 * When no provider usage has anchored the number, the gauge draws only its
 * track: an empty ring. The arc has one meaning — measured progress — so it is
 * either drawn or absent, never replaced by a glyph. A chars-per-token guess is
 * useful for planning but must never be mistaken for a measurement, and a ring
 * that saturates on an estimate reads as "out of context" while the real prompt
 * may be a fraction of the window. The tooltip owns the "not measured" wording.
 */
export function ContextUsageRing({ usage, pendingTokens = 0 }: ContextUsageRingProps) {
  const { t } = useTranslation();
  const estimated = usage.estimated;
  const ratio = estimated ? 0 : Math.min(1, Math.max(0, usage.percent / 100));
  const offset = CIRCUMFERENCE * (1 - ratio);

  const tone = estimated
    ? 'text-muted-foreground'
    : usage.percent > 90
      ? 'text-destructive'
      : usage.percent > 70
        ? 'text-amber-500'
        : 'text-muted-foreground';

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              'grid h-7 w-7 place-items-center rounded-lg transition-colors hover:bg-accent',
              tone,
            )}
            aria-label={
              estimated
                ? t('sidebar.contextUsage')
                : t('sidebar.contextUsageLabel', { percent: `${Math.round(usage.percent)}%` })
            }
          >
            <span className="relative grid place-items-center">
              <svg
                width={SIZE}
                height={SIZE}
                viewBox={`0 0 ${SIZE} ${SIZE}`}
                className="-rotate-90"
                aria-hidden="true"
              >
                <circle
                  cx={SIZE / 2}
                  cy={SIZE / 2}
                  r={RADIUS}
                  fill="none"
                  strokeWidth={STROKE}
                  className="stroke-muted-foreground/20"
                />
                {!estimated && (
                  <circle
                    cx={SIZE / 2}
                    cy={SIZE / 2}
                    r={RADIUS}
                    fill="none"
                    strokeWidth={STROKE}
                    strokeLinecap="round"
                    strokeDasharray={CIRCUMFERENCE}
                    strokeDashoffset={offset}
                    className="stroke-current transition-[stroke-dashoffset] duration-200 ease-out"
                  />
                )}
              </svg>
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="end"
          sideOffset={6}
          className="z-50 rounded-lg border border-border bg-popover px-3 py-2.5 shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-in-95"
        >
          <ContextUsagePanel usage={usage} pendingTokens={pendingTokens} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
