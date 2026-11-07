import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBlobImageUrl } from '@/lib/use-blob-image-url';

/**
 * Small display primitives shared by the generic tool card and the specialised
 * views (today: `sh`). Kept out of `tool.tsx` so a view can be rendered without
 * importing the card that chooses it.
 */

export function ToolSectionLabel({ children }: { children: React.ReactNode }) {
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
export function ToolCodeBlock({
  children,
  className,
  dir,
}: {
  children: string;
  className?: string;
  dir?: 'ltr' | 'rtl';
}) {
  return (
    <pre
      dir={dir}
      className={cn(
        'max-h-80 overflow-auto scrollbar-lumo rounded-md bg-background/80 border border-border/60 p-1.5 text-[0.6875rem] leading-relaxed font-mono whitespace-pre-wrap break-all',
        className,
      )}
    >
      {children}
    </pre>
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
export function ToolBlobImage({
  blobReference,
  caption,
}: {
  blobReference: string;
  caption?: string;
}) {
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

/** An inline (non-blob) image, as a shell result carries before it is persisted. */
export function ToolInlineImage({ data, mimeType }: { data: string; mimeType: string }) {
  const { t } = useTranslation();
  return (
    <img
      src={`data:${mimeType};base64,${data}`}
      alt={t('sidebar.tool.screenshot')}
      className="max-h-48 w-full rounded-md border border-border/60 object-contain bg-background/80"
    />
  );
}
