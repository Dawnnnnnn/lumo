/**
 * Tool output normalization for the sidebar.
 *
 * All MCP tools (built-in, external, WebMCP) now return a unified
 * CallToolResult format: { content: [{type, text}, ...], isError: boolean }.
 * This module unpacks that structure and classifies the output for display.
 *
 * Output is deliberately *not* length-truncated here. Tools that can return
 * unbounded text already cap themselves at the tool layer (see
 * `lib/page/output-limit.ts`) and report `limit.truncated` so the model can
 * page; a second cap in the UI only hid that metadata from the user, because
 * `limit` is serialised after the long `markdown` field. Height is bounded by
 * the scroll container instead, and `ToolOutput` only mounts when the user
 * expands a collapsed call.
 */

import { parseBlobRef } from '@/lib/blob-ref';

export type NormalizedToolOutput =
  | { kind: 'empty' }
  | { kind: 'image'; url: string; caption?: string }
  /**
   * A screenshot whose bytes live in the `blobs` store rather than in the
   * conversation record. `ref` is resolved to an object URL only when the call is
   * expanded — see `useBlobImageUrl`.
   */
  | { kind: 'image-ref'; ref: string; caption?: string }
  | { kind: 'error'; message: string }
  | { kind: 'text'; text: string };

/**
 * MCP CallToolResult content part types.
 */
interface CallToolTextPart {
  type: 'text';
  text: string;
}

interface CallToolImagePart {
  type: 'image';
  data: string;       // base64
  mimeType: string;
}

type CallToolContentPart = CallToolTextPart | CallToolImagePart | { type: string; [key: string]: unknown };

interface CallToolResult {
  content: CallToolContentPart[];
  isError: boolean;
}

/** Check if value looks like a CallToolResult. */
function isCallToolResult(value: unknown): value is CallToolResult {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.content);
}

/** Detect a data-URL or http(s) image string. */
function asImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('data:image/')) return value;
  return undefined;
}

/**
 * Try to pretty-print a string if it's valid JSON; otherwise return as-is.
 */
function prettyPrintIfJson(text: string): string {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(parsed, null, 2);
    } catch {
      // Not valid JSON, return as-is
    }
  }
  return text;
}

/**
 * Extract displayable content from a CallToolResult.
 */
function normalizeCallToolResult(result: CallToolResult): NormalizedToolOutput {
  if (result.isError) {
    const errorTexts = result.content
      .filter((p): p is CallToolTextPart => p.type === 'text')
      .map((p) => p.text);
    return {
      kind: 'error',
      message: errorTexts.join('\n') || 'Tool execution failed',
    };
  }

  if (!result.content || result.content.length === 0) {
    return { kind: 'empty' };
  }

  // Check for image parts
  const imagePart = result.content.find(
    (p): p is CallToolImagePart => p.type === 'image' && typeof (p as any).data === 'string',
  );
  if (imagePart) {
    const textParts = result.content
      .filter((p): p is CallToolTextPart => p.type === 'text')
      .map((p) => p.text);
    const caption = textParts.length > 0 ? textParts.join('\n') : undefined;

    // Persisted screenshots carry a reference instead of base64; the bytes are
    // fetched lazily so opening a long conversation does not load every image.
    const ref = parseBlobRef(imagePart.data);
    if (ref) {
      return { kind: 'image-ref', ref: imagePart.data, ...(caption ? { caption } : {}) };
    }

    const url = `data:${imagePart.mimeType || 'image/png'};base64,${imagePart.data}`;
    return { kind: 'image', url, ...(caption ? { caption } : {}) };
  }

  // Extract all text parts and combine
  const textParts = result.content
    .filter((p): p is CallToolTextPart => p.type === 'text')
    .map((p) => p.text);

  if (textParts.length === 0) {
    return { kind: 'empty' };
  }

  const combinedText = textParts.join('\n');
  return { kind: 'text', text: prettyPrintIfJson(combinedText) };
}

export function normalizeToolOutput(output: unknown): NormalizedToolOutput {
  if (output == null) return { kind: 'empty' };

  // Handle CallToolResult format (standard for all MCP tools)
  if (isCallToolResult(output)) {
    return normalizeCallToolResult(output);
  }

  // Legacy fallback for any non-CallToolResult values
  const directImage = asImageUrl(output);
  if (directImage) return { kind: 'image', url: directImage };

  if (typeof output === 'object') {
    const record = output as Record<string, unknown>;

    if (typeof record.error === 'string' && Object.keys(record).length <= 2) {
      return { kind: 'error', message: record.error };
    }
  }

  const text = typeof output === 'string'
    ? prettyPrintIfJson(output)
    : safeStringify(output);

  return { kind: 'text', text };
}

/** JSON stringify that survives circular refs and bigints. */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === 'bigint') return val.toString();
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      },
      2,
    ) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * A tool call's display label, when the raw tool name plus its arguments make a
 * worse header than the meaning behind them.
 *
 * `file_read` on `skills/pdf-tools/SKILL.md` is "read a skill"; the path is an
 * implementation detail of where skills happen to live, and in a ~320px sidebar
 * it pushes the useful part of the header out of view. Everything not matched
 * here returns `undefined` and renders exactly as it always has, so the
 * heuristic can never make an ordinary call worse.
 */
export interface ToolCallDescription {
  /** i18n key for the call's label, shown instead of the raw tool name. */
  labelKey: string;
  /** The subject of the call — for a skill, its name. */
  detail: string;
  /** Anything after the subject, such as a bundled resource path. */
  hint?: string;
}

/** `skills/<skill-name>/<path inside the skill>` */
const SKILL_PATH = /^skills\/([^/]+)\/(.+)$/;

/** The skill manifest's file name; its presence means "this is the skill itself". */
const SKILL_MANIFEST = 'SKILL.md';

export function describeToolCall(name: string, input: unknown): ToolCallDescription | undefined {
  // Only `file_read` gets a semantic label. `file_list` already names a
  // directory, which reads fine next to its argument.
  if (name !== 'file_read') return undefined;
  if (!input || typeof input !== 'object') return undefined;
  const raw = (input as Record<string, unknown>).name;
  if (typeof raw !== 'string') return undefined;

  const match = SKILL_PATH.exec(raw);
  if (!match) return undefined;
  const [, skill, rest] = match;
  if (rest === SKILL_MANIFEST) {
    return { labelKey: 'sidebar.tool.readSkill', detail: skill! };
  }
  return { labelKey: 'sidebar.tool.readSkillResource', detail: skill!, hint: rest };
}

/** Compact one-line preview of tool input, shown collapsed in the header. */
export function summarizeToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input !== 'object') return String(input);

  const entries = Object.entries(input as Record<string, unknown>).filter(
    ([, value]) => value !== undefined,
  );
  if (entries.length === 0) return '';

  return entries
    .map(([key, value]) => {
      const rendered =
        typeof value === 'string'
          ? value.length > 40
            ? `${value.slice(0, 40)}…`
            : value
          : Array.isArray(value)
            ? `[${value.length}]`
            : typeof value === 'object'
              ? '{…}'
              : String(value);
      return `${key}: ${rendered}`;
    })
    .join(', ');
}
