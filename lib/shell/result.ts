/**
 * Reading a `sh` tool result back out of the transcript.
 *
 * Kept out of the component so the contract has one owner and a test: a fresh
 * call keeps the raw `CallToolResult` returned by `execute`, a resumed
 * transcript can hold the SDK's JSON wrapper, and a rendered history carries
 * `lumo-blob:` image references. All three shapes carry the same text part, so
 * the summary is always parsed from that one place.
 */

/** What one shell invocation produced, before it is shaped into a tool result. */
export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  fullOutputPath?: string;
  attachments: Array<{ path: string; mimeType: string; data: string }>;
}

/** One invocation result, as the `sh` tool reports it. */
export interface ShellSummary {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated?: boolean;
  fullOutputPath?: string;
  attachments?: Array<{ path?: string; mimeType?: string }>;
}

/** An image the call produced, inline or as a persisted blob reference. */
export interface ShellImagePart {
  data: string;
  mimeType: string;
}

export interface ShellOutputView {
  summary: ShellSummary;
  images: ShellImagePart[];
}

/** Matches the `content` array of a CallToolResult, whichever shape it arrived in. */
function contentParts(output: unknown): Record<string, unknown>[] | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const record = output as Record<string, unknown>;

  const content = Array.isArray(record.content)
    ? record.content
    : record.type === 'json' &&
        record.value !== null &&
        typeof record.value === 'object' &&
        Array.isArray((record.value as { content?: unknown }).content)
      ? (record.value as { content: unknown[] }).content
      : undefined;
  if (!content) return undefined;

  return content.filter(
    (part): part is Record<string, unknown> => !!part && typeof part === 'object',
  );
}

/**
 * Parse the JSON summary and any image parts out of a stored shell result.
 *
 * Returns `null` when the output is not a shell result at all, which is what
 * lets the tool card fall back to the generic renderer.
 */
export function parseShellResult(output: unknown): ShellOutputView | null {
  const parts = contentParts(output);
  if (!parts) return null;

  const text = parts.find((part) => part.type === 'text' && typeof part.text === 'string')?.text;
  if (typeof text !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const summary = parsed as Partial<ShellSummary>;
  if (typeof summary.exitCode !== 'number' && typeof summary.stdout !== 'string') return null;

  const images: ShellImagePart[] = parts
    .filter(
      (part): part is { type: 'image'; data: string; mimeType?: unknown } =>
        part.type === 'image' && typeof part.data === 'string',
    )
    .map((part) => ({ data: part.data, mimeType: String(part.mimeType ?? 'image/png') }));

  return {
    summary: {
      stdout: typeof summary.stdout === 'string' ? summary.stdout : '',
      stderr: typeof summary.stderr === 'string' ? summary.stderr : '',
      exitCode: typeof summary.exitCode === 'number' ? summary.exitCode : 0,
      ...(summary.truncated ? { truncated: true } : {}),
      ...(typeof summary.fullOutputPath === 'string'
        ? { fullOutputPath: summary.fullOutputPath }
        : {}),
      ...(Array.isArray(summary.attachments) ? { attachments: summary.attachments } : {}),
    },
    images,
  };
}

/** The command text a shell call was given, trimmed; `''` for a non-shell input. */
export function shellCommandOf(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' ? command.trim() : '';
}
