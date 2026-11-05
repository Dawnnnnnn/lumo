import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  Wrench,
  BookOpen,
  Loader2,
  Check,
  AlertCircle,
  Ban,
  CircleSlash,
  ShieldQuestion,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  describeToolCall,
  normalizeToolOutput,
  safeStringify,
  summarizeToolInput,
} from '@/lib/tool-output';
import { useBlobImageUrl } from '@/lib/use-blob-image-url';
import type { ToolPart } from '@/lib/message-parts';

/**
 * Compact tool-invocation display.
 *
 * Sized down from upstream ai-elements: single-line header, 11px mono body and
 * capped output height, so a tool call costs roughly one text line of vertical
 * space in a narrow sidebar.
 */

type ToolState = ToolPart['state'];

/**
 * States a tool call can be *left* in rather than reach.
 *
 * A tool part is persisted exactly as it stood, so a turn cut short while a tool
 * was still running keeps one of these on disk forever. Both render as a
 * spinner, which is only honest while the turn is live.
 */
const UNSETTLED_STATES = new Set<ToolState>(['input-streaming', 'input-available']);

/**
 * A tool state as displayed, which is not always the state that was stored.
 *
 * `interrupted` has no counterpart in the AI SDK because it is not something a
 * tool call reaches — it is what an unsettled call *becomes* once the turn
 * around it is over.
 */
export type ToolDisplayState = ToolState | 'interrupted';

/**
 * Resolves how a stored state should read now.
 *
 * Reopening a conversation whose last turn was interrupted mid-tool used to show
 * that call spinning forever: the part still said `input-available`, and nothing
 * in the display knew the turn had ended, so the UI claimed work was in progress
 * that no longer had a request behind it. `isStreaming` is that missing piece —
 * an unsettled call is only pending while the turn producing it is live.
 */
export function toolDisplayState(state: ToolState, isStreaming: boolean): ToolDisplayState {
  return !isStreaming && UNSETTLED_STATES.has(state) ? 'interrupted' : state;
}

/** Terminal states are collapsed by default to keep long tool chains scannable. */
const STATUS_META: Record<
  ToolDisplayState,
  { icon: React.ElementType; className: string; i18nKey: string; spin?: boolean }
> = {
  'input-streaming': {
    icon: Loader2,
    className: 'text-muted-foreground',
    i18nKey: 'sidebar.tool.pending',
    spin: true,
  },
  'input-available': {
    icon: Loader2,
    className: 'text-blue-600 dark:text-blue-400',
    i18nKey: 'sidebar.tool.running',
    spin: true,
  },
  'approval-requested': {
    icon: ShieldQuestion,
    className: 'text-yellow-600 dark:text-yellow-400',
    i18nKey: 'sidebar.tool.awaitingApproval',
  },
  'approval-responded': {
    icon: ShieldQuestion,
    className: 'text-muted-foreground',
    i18nKey: 'sidebar.tool.responded',
  },
  'output-available': {
    icon: Check,
    className: 'text-green-600 dark:text-green-400',
    i18nKey: 'sidebar.tool.completed',
  },
  'output-error': {
    icon: AlertCircle,
    className: 'text-destructive',
    i18nKey: 'sidebar.tool.error',
  },
  'output-denied': {
    icon: Ban,
    className: 'text-muted-foreground',
    i18nKey: 'sidebar.tool.denied',
  },
  // Never streamed by the SDK — derived by `toolDisplayState` for a call the
  // turn abandoned. `CircleSlash` matches the interrupted-reply notice on the
  // bubble, so the two read as the same event.
  interrupted: {
    icon: CircleSlash,
    className: 'text-muted-foreground',
    i18nKey: 'sidebar.tool.interrupted',
  },
};

export function ToolStatusIcon({
  state,
  className,
}: {
  state: ToolDisplayState;
  className?: string;
}) {
  const meta = STATUS_META[state] ?? STATUS_META['input-available'];
  const Icon = meta.icon;
  return (
    <Icon
      className={cn('h-3 w-3 shrink-0', meta.className, meta.spin && 'animate-spin', className)}
    />
  );
}

export function useToolStatusLabel(state: ToolDisplayState): string {
  const { t } = useTranslation();
  const meta = STATUS_META[state] ?? STATUS_META['input-available'];
  return t(meta.i18nKey);
}

interface ToolProps {
  part: ToolPart;
  name: string;
  /**
   * Whether the turn this call belongs to is still streaming. Drives the
   * pending-vs-interrupted distinction — see `toolDisplayState`.
   */
  isStreaming?: boolean;
  className?: string;
}

export function Tool({ part, name, isStreaming = false, className }: ToolProps) {
  const { t } = useTranslation();
  const state = toolDisplayState(part.state, isStreaming);
  const statusLabel = useToolStatusLabel(state);
  // A skill read is named by the skill, not by the storage path that happens to
  // hold it. Everything else keeps the raw tool name and its argument summary.
  const described = describeToolCall(name, part.input);
  const inputSummary = described
    ? [described.detail, described.hint].filter(Boolean).join(' / ')
    : summarizeToolInput(part.input);
  const HeaderIcon = described ? BookOpen : Wrench;
  // Failures are expanded up front; successful calls stay collapsed so long
  // tool chains remain scannable in a narrow sidebar.
  const failed = state === 'output-error';

  return (
    <Collapsible
      defaultOpen={failed}
      className={cn(
        '@container rounded-lg border bg-muted/40 overflow-hidden w-full min-w-0',
        failed ? 'border-destructive/40' : 'border-border',
        className,
      )}
    >
      <CollapsibleTrigger className="group/tool gap-1.5 px-2 py-1.5 hover:bg-muted/70 transition-colors min-w-0">
        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/tool:rotate-90 rtl:-scale-x-100" />
        <HeaderIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span
          className="font-mono text-[0.6875rem] font-medium truncate shrink-0 max-w-[45%]"
          title={described ? name : undefined}
        >
          {described ? t(described.labelKey) : name}
        </span>
        {inputSummary && (
          <span className="text-[0.6875rem] text-muted-foreground/70 truncate min-w-0 flex-1">
            {inputSummary}
          </span>
        )}
        <span className="ms-auto flex items-center gap-1 shrink-0 ps-1">
          <ToolStatusIcon state={state} />
          <span
            className={cn(
              'hidden @[16rem]:inline text-[0.625rem]',
              STATUS_META[state]?.className ?? 'text-muted-foreground',
            )}
          >
            {statusLabel}
          </span>
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent className="border-t border-border/60 px-2 py-1.5 flex flex-col gap-1.5">
        <ToolInput input={part.input} />
        {state === 'output-error' ? (
          <ToolError message={part.errorText ?? t('sidebar.tool.unknownError')} />
        ) : state === 'output-available' ? (
          <ToolOutput output={part.output} />
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground/70">
      {children}
    </div>
  );
}

/**
 * Scrollable, height-capped mono block.
 *
 * The only bound on tool output now that `tool-output.ts` no longer truncates
 * characters, so it is roomier than a single-glance preview.
 */
function ToolCodeBlock({ children }: { children: string }) {
  return (
    <pre className="max-h-80 overflow-auto scrollbar-lumo rounded-md bg-background/80 border border-border/60 p-1.5 text-[0.6875rem] leading-relaxed font-mono whitespace-pre-wrap break-all">
      {children}
    </pre>
  );
}

export function ToolInput({ input }: { input: unknown }) {
  const { t } = useTranslation();
  if (input == null || (typeof input === 'object' && Object.keys(input).length === 0)) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 min-w-0">
      <ToolSectionLabel>{t('sidebar.tool.input')}</ToolSectionLabel>
      <ToolCodeBlock>{safeStringify(input)}</ToolCodeBlock>
    </div>
  );
}

export function ToolError({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <ToolSectionLabel>{t('sidebar.tool.error')}</ToolSectionLabel>
      {/* Tinting the whole block `text-destructive` makes the message itself
          harder to read than the surrounding output; the accent stays on the
          icon and the message keeps normal body contrast. */}
      <div className="flex items-start gap-1.5 rounded-md border border-destructive/25 bg-destructive/5 p-1.5 text-[0.6875rem] text-foreground/80">
        <AlertCircle className="h-3 w-3 shrink-0 mt-0.5 text-destructive" />
        <span className="break-words min-w-0">{message}</span>
      </div>
    </div>
  );
}

/**
 * A screenshot kept outside the conversation record.
 *
 * Split into its own component so the blob is fetched only once this subtree
 * mounts, which happens when the user expands the call.
 */
function ToolBlobImage({ blobReference, caption }: { blobReference: string; caption?: string }) {
  const { t } = useTranslation();
  const state = useBlobImageUrl(blobReference);

  return (
    <div className="flex flex-col gap-1 min-w-0">
      {state.status === 'ready' ? (
        <img
          src={state.url}
          alt={t('sidebar.tool.screenshot')}
          className="max-h-48 w-full rounded-md border border-border/60 object-contain bg-background/80"
        />
      ) : (
        // A fixed-height placeholder keeps the transcript from jumping when the
        // image arrives. `loading` must read differently from a real failure —
        // treating the two alike made every expand flash an error first.
        <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border/60 bg-background/50">
          {state.status === 'loading' ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/70" />
          ) : (
            <span className="px-2 text-center text-[0.6875rem] text-muted-foreground">
              {t('sidebar.tool.screenshotUnavailable')}
            </span>
          )}
        </div>
      )}
      {caption && <ToolCodeBlock>{caption}</ToolCodeBlock>}
    </div>
  );
}

export function ToolOutput({ output }: { output: unknown }) {
  const { t } = useTranslation();
  const normalized = React.useMemo(() => normalizeToolOutput(output), [output]);

  if (normalized.kind === 'empty') return null;

  if (normalized.kind === 'error') {
    return <ToolError message={normalized.message} />;
  }

  return (
    <div className="flex flex-col gap-1 min-w-0">
      <ToolSectionLabel>{t('sidebar.tool.output')}</ToolSectionLabel>

      {normalized.kind === 'image-ref' ? (
        <ToolBlobImage blobReference={normalized.ref} caption={normalized.caption} />
      ) : normalized.kind === 'image' ? (
        <div className="flex flex-col gap-1 min-w-0">
          <img
            src={normalized.url}
            alt={t('sidebar.tool.screenshot')}
            className="max-h-48 w-full rounded-md border border-border/60 object-contain bg-background/80"
          />
          {normalized.caption && <ToolCodeBlock>{normalized.caption}</ToolCodeBlock>}
        </div>
      ) : (
        <ToolCodeBlock>{normalized.text}</ToolCodeBlock>
      )}
    </div>
  );
}
