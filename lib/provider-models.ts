/**
 * Reading a provider's `/models` response.
 *
 * Gateways agree on `{ data: [...] }` and little else: entries may be bare ids,
 * OpenAI-style `{ id }` objects or LiteLLM-style `{ model_name }`. Some (Magpie)
 * also describe each model, and the details that map onto a `ModelConfig` are
 * kept so the dialog can prefill them instead of making the user retype them.
 */

import { normalizeContextWindow } from '@/lib/context-window';

export interface FetchedModel {
  id: string;
  /** Human-readable name, when the gateway publishes one distinct from the id. */
  displayName?: string;
  /** Declared context window in tokens, already range-checked. */
  contextWindow?: number;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readEntry(item: unknown): FetchedModel | undefined {
  if (typeof item === 'string') return item ? { id: item } : undefined;
  if (!item || typeof item !== 'object') return undefined;
  const entry = item as Record<string, unknown>;
  const id = readString(entry.id) ?? readString(entry.model_name);
  if (!id) return undefined;
  const displayName = readString(entry.display_name);
  // `context_window` is Magpie's name; `context_length` is OpenRouter's and is
  // also published by Magpie with the same value.
  const contextWindow = normalizeContextWindow(entry.context_window ?? entry.context_length);
  return {
    id,
    ...(displayName && displayName !== id ? { displayName } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

/**
 * Models listed in a `/models` payload, deduplicated by id and sorted by it.
 *
 * Returns an empty list for anything that is not shaped like a model list, so
 * the caller has one "nothing usable" case to report.
 */
export function parseModelList(payload: unknown): FetchedModel[] {
  const data = payload && typeof payload === 'object' && 'data' in payload
    ? (payload as { data?: unknown }).data
    : undefined;
  if (!Array.isArray(data)) return [];
  const byId = new Map<string, FetchedModel>();
  for (const item of data) {
    const model = readEntry(item);
    if (model && !byId.has(model.id)) byId.set(model.id, model);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
