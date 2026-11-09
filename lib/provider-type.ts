import type {
  ModelConfig,
  ProviderConfig,
  ProviderType,
  ProviderVendor,
  StoredProviderType,
} from '@/types';
import {
  REASONING_EFFORT_DEFAULT,
  normalizeReasoningEffort,
} from '@/lib/reasoning-effort';
import { deriveOpenCodeSession, openCodeBaseUrl, openCodeModelsUrl } from '@/lib/opencode';
import { normalizeContextWindow } from '@/lib/context-window';

/** i18n key suffix under `options.models.providerTypes` for each type. */
export const PROVIDER_TYPE_I18N_KEY: Record<ProviderType, string> = {
  anthropic: 'anthropic',
  'openai-chat': 'openaiChat',
  'openai-responses': 'openaiResponses',
};

/** Order shown in the provider type picker, most portable option first. */
export const PROVIDER_TYPES: ProviderType[] = [
  'openai-chat',
  'openai-responses',
  'anthropic',
];

/** i18n key suffix under `options.models.vendors` for each vendor. */
export const PROVIDER_VENDOR_I18N_KEY: Record<ProviderVendor, string> = {
  custom: 'custom',
  opencode: 'opencode',
};

/** Order shown in the vendor picker, the generic option first. */
export const PROVIDER_VENDORS: ProviderVendor[] = ['custom', 'opencode'];

/** Default base URL hint per provider type, used as an input placeholder. */
export const PROVIDER_BASE_URL_PLACEHOLDER: Record<ProviderType, string> = {
  anthropic: 'https://api.anthropic.com',
  'openai-chat': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
};

/**
 * Map a persisted vendor onto a current one.
 *
 * `undefined` is preserved rather than materialised to `'custom'`, for the same
 * reason `reasoningEffort` is: an absent field already *means* "custom", so
 * writing it back would rewrite every provider stored before this dimension
 * existed and hand React a fresh identity for every row on each read.
 * Anything unrecognised degrades to `'custom'` — a value from a build that
 * knows a vendor this one doesn't must not be forwarded as if it were known.
 */
export function normalizeProviderVendor(
  vendor: string | undefined,
): ProviderVendor | undefined {
  if (vendor === undefined) return undefined;
  return vendor === 'opencode' ? 'opencode' : 'custom';
}

/**
 * Map a persisted provider type onto a current one.
 *
 * Legacy `openai-compatible` configs pointed at arbitrary gateways but were
 * actually dispatched to the OpenAI Responses API, which those gateways do not
 * implement. They are migrated to `openai-chat` (`/chat/completions`), which is
 * what the label promised and what such gateways actually serve.
 */
export function normalizeProviderType(type: StoredProviderType | undefined): ProviderType {
  if (type === 'openai-compatible' || type === undefined) return 'openai-chat';
  return type;
}

/**
 * Read a stored model with its reasoning effort migrated to a current value.
 *
 * An absent field is left absent: it already *means* "provider default", and
 * materialising that on read would rewrite every model stored before the
 * setting existed. Only a present value can be stale — a level written by a
 * build that knows one this doesn't, which must not be forwarded to the API,
 * where it would fail the whole request rather than degrade.
 *
 * Returns the same object when nothing changed, so an ordinary read does not
 * hand React a fresh identity for every row.
 */
function normalizeModel(model: ModelConfig): ModelConfig {
  let next = model;
  if (next.reasoningEffort !== undefined) {
    const reasoningEffort = normalizeReasoningEffort(next.reasoningEffort);
    if (reasoningEffort !== next.reasoningEffort) next = { ...next, reasoningEffort };
  }
  // A present-but-invalid window (a hand-edited export) is dropped to
  // `undefined` rather than clamped, so the ring hides instead of dividing by a
  // number the user never entered. An absent field stays absent, like
  // `reasoningEffort`: materialising it would hand React a fresh identity for
  // every model stored before this field existed.
  if (next.contextWindow !== undefined) {
    const contextWindow = normalizeContextWindow(next.contextWindow);
    if (contextWindow !== next.contextWindow) next = { ...next, contextWindow };
  }
  return next;
}

/** Read a stored provider with its vendor, type and models migrated to current values. */
export function normalizeProvider(provider: ProviderConfig): ProviderConfig {
  const type = normalizeProviderType(provider.type as StoredProviderType);
  const vendor = normalizeProviderVendor(provider.vendor);
  // Tolerate a `models`-less object rather than throwing: this also runs on
  // imported config files, which are not guaranteed to be well-formed.
  const models = Array.isArray(provider.models) ? provider.models.map(normalizeModel) : undefined;
  const modelsChanged = models?.some((model, i) => model !== provider.models[i]) ?? false;
  if (type === provider.type && vendor === provider.vendor && !modelsChanged) return provider;
  return {
    ...provider,
    type,
    ...(vendor !== provider.vendor ? { vendor } : {}),
    ...(modelsChanged ? { models: models! } : {}),
  };
}

/** Whether the provider is an OpenCode endpoint that needs its vendor extras. */
export function isOpenCodeVendor(provider: ProviderConfig): boolean {
  return provider.vendor === 'opencode';
}

/**
 * The minimum a provider must expose for its endpoint to be resolved.
 *
 * Narrower than `ProviderConfig` on purpose: the model dialog holds these three
 * fields on their own (there is no provider draft there), and a `ProviderConfig`
 * satisfies this structurally.
 */
export interface ProviderEndpointInput {
  vendor?: ProviderVendor;
  type: ProviderType;
  baseUrl?: string;
}

function inputIsOpenCode(input: ProviderEndpointInput): boolean {
  return input.vendor === 'opencode';
}

/**
 * The base URL a request should actually use, or `undefined` to let the SDK
 * apply its own default.
 *
 * Derived rather than required for a known vendor: OpenCode's path differs per
 * protocol, and asking the user to type it is how the wrong one gets saved.
 * A URL the user did type always wins.
 */
export function resolveBaseUrl(input: ProviderEndpointInput): string | undefined {
  if (input.baseUrl?.trim()) return input.baseUrl.trim();
  if (inputIsOpenCode(input)) return openCodeBaseUrl(normalizeProviderType(input.type));
  return undefined;
}

/**
 * Where the provider's model list lives, or `undefined` when this provider has
 * no derivable one (the fetch button is hidden then).
 *
 * Only OpenCode has an endpoint that is not `${baseUrl}/models`; for everything
 * else the historical derivation is kept so existing gateways keep working.
 */
export function resolveModelsUrl(input: ProviderEndpointInput): string | undefined {
  if (inputIsOpenCode(input)) {
    // `resolveBaseUrl` always answers for OpenCode (it falls back to the
    // official origin), so there is no "no URL configured" case here.
    return openCodeModelsUrl(resolveBaseUrl(input)!);
  }
  const base = input.baseUrl?.trim().replace(/\/+$/, '');
  return base ? (base.endsWith('/models') ? base : `${base}/models`) : undefined;
}

/** Placeholder for the provider's base URL field, aware of the vendor. */
export function providerBaseUrlPlaceholder(
  vendor: ProviderVendor | undefined,
  type: ProviderType,
): string {
  return normalizeProviderVendor(vendor) === 'opencode'
    ? openCodeBaseUrl(type)
    : PROVIDER_BASE_URL_PLACEHOLDER[type];
}

/**
 * Session identifier to present, when the vendor routes per conversation.
 *
 * Returns `undefined` for every other vendor, so the header is simply absent
 * rather than empty. Without a conversation (OCR runs outside one) a stable
 * per-provider id is used instead of nothing: a vendor that keys routing on the
 * session should see one consistent identity, not a fresh one per request.
 */
export async function resolveProviderSessionId(
  provider: ProviderConfig,
  conversationId?: string,
): Promise<string | undefined> {
  if (!isOpenCodeVendor(provider)) return undefined;
  return deriveOpenCodeSession(conversationId ?? `provider:${provider.id}`);
}

/** Whether the provider speaks one of the OpenAI wire protocols. */
export function isOpenAIProvider(type: ProviderType): boolean {
  return type === 'openai-chat' || type === 'openai-responses';
}
