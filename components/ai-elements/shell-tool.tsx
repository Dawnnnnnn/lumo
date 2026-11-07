import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { parseBlobRef } from '@/lib/blob-ref';
import { openFilePreview } from '@/lib/file-preview-tab';
import { parseShellResult, shellCommandOf, type ShellOutputView } from '@/lib/shell/result';
import type { ToolPart } from '@/lib/message-parts';
import { ToolBlobImage, ToolCodeBlock, ToolInlineImage, ToolSectionLabel } from './tool-primitives';

/**
 * The `sh` tool's dedicated rendering.
 *
 * A shell result is a JSON summary plus optional images. Through the generic
 * card it was one opaque JSON blob, hiding the exit code that says whether the
 * command failed at all. The parsing itself lives in `lib/shell/result.ts`; this
 * file only draws it.
 */

/** Compact header text: the first line of the script. */
export function shellToolSummary(input: unknown): string {
  const command = shellCommandOf(input);
  return command.split('\n')[0] ?? '';
}

/** Whether the *script* failed, even though the tool call itself resolved. */
export function shellToolExitCode(output: unknown): number | undefined {
  return parseShellResult(output)?.summary.exitCode;
}

export function ShellToolInput({ input }: { input: unknown }) {
  const command = shellCommandOf(input);
  if (!command) return null;
  return (
    <ToolCodeBlock dir="ltr" className="max-h-40 bg-muted/50">
      {`$ ${command}`}
    </ToolCodeBlock>
  );
}

/** Whether the output is a shell result at all (used to choose a renderer). */
export function isShellResult(output: unknown): boolean {
  return parseShellResult(output) !== null;
}

/**
 * Open a spilled output file in the preview tab.
 *
 * The shell reports `/tmp/sh-…txt`; preview pages address the file library by
 * its store path, without the shell's leading slash. Previewing it is the only
 * user-facing way to read the part the model's 2 000-line/50 KB cap hid.
 */
function openSpilledOutput(path: string): void {
  void openFilePreview(path.replace(/^\/+/, '')).catch(() => undefined);
}

export function ShellToolOutput({ output }: { output: unknown }) {
  const { t } = useTranslation();
  // Parsing allocates the image list and JSON.parse()s the summary; a streaming
  // transcript re-renders on every token, so memoise on the output identity.
  const view = React.useMemo(() => parseShellResult(output), [output]);
  if (!view) return null;

  return <ShellOutputBody view={view} t={t} />;
}

function ShellOutputBody({
  view,
  t,
}: {
  view: ShellOutputView;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const { summary, images } = view;
  const stdout = summary.stdout.replace(/\n+$/, '');
  const stderr = summary.stderr.replace(/\n+$/, '');
  const showMeta = summary.exitCode !== 0 || summary.truncated;

  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      {stdout.length > 0 && (
        <div className="flex flex-col gap-1 min-w-0">
          <ToolSectionLabel>{t('sidebar.tool.stdout')}</ToolSectionLabel>
          <ToolCodeBlock dir="ltr">{stdout}</ToolCodeBlock>
        </div>
      )}
      {stderr.length > 0 && (
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-[0.625rem] font-medium uppercase tracking-wide text-destructive/80">
            {t('sidebar.tool.stderr')}
          </span>
          <ToolCodeBlock dir="ltr" className="border-destructive/25 bg-destructive/5">
            {stderr}
          </ToolCodeBlock>
        </div>
      )}
      {showMeta && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.625rem] text-muted-foreground min-w-0">
          {summary.exitCode !== 0 && (
            <span className="rounded bg-destructive/10 px-1 font-mono text-destructive">
              {t('sidebar.tool.exitCode', { code: summary.exitCode })}
            </span>
          )}
          {summary.truncated && summary.fullOutputPath && (
            <button
              type="button"
              onClick={() => openSpilledOutput(summary.fullOutputPath!)}
              className="truncate min-w-0 font-mono text-start underline decoration-dotted underline-offset-2 hover:text-foreground"
              title={summary.fullOutputPath}
            >
              {t('sidebar.tool.outputTruncated')} · {summary.fullOutputPath}
            </button>
          )}
        </div>
      )}
      {images.map((image, index) => {
        const ref = parseBlobRef(image.data);
        return ref ? (
          <ToolBlobImage key={`${ref}-${index}`} blobReference={image.data} />
        ) : (
          <ToolInlineImage key={`image-${index}`} data={image.data} mimeType={image.mimeType} />
        );
      })}
    </div>
  );
}

/**
 * Tool-view spec for `sh`, consumed by the registry in `tool.tsx`.
 *
 * Declared here rather than keyed by a literal inside the card so a second
 * specialised tool only has to add a view, not another `name === '...'` branch.
 */
export interface ToolView {
  /** Header override; `undefined` falls back to the generic argument summary. */
  summarize?: (part: ToolPart) => string | undefined;
  /** Whether the rendered header should read as a failure. */
  failed?: (part: ToolPart) => boolean;
  /** Input is forced left-to-right because it is code. */
  ltr?: boolean;
  renderInput?: (part: ToolPart) => React.ReactNode;
  /** `undefined` falls back to the generic output renderer. */
  renderOutput?: (part: ToolPart) => React.ReactNode | undefined;
}
