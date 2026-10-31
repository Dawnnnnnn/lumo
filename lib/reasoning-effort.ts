import type { CallSettings } from 'ai';
import type { ProviderType } from '@/types';

/**
 * How hard a reasoning model should think before it answers.
 *
 * The offered levels follow the *provider*, not this app: each provider defines
 * its own set, so what a model may be set to depends on which provider it hangs
 * off (see {@link REASONING_EFFORTS_BY_PROVIDER}). Where a provider publishes no
 * enum at all — the OpenAI Responses API takes `reasoning_effort` as a free
 * string — we supply the widest set its family is known to accept.
 *
 * Every level is a value of the AI SDK's unified `reasoning` setting, so every
 * level rides that setting and the SDK's provider adapter translates it per
 * model. Only two spellings are ours:
 * - `'provider-default'` is the identity value: the field is omitted entirely, so
 *   the request is byte-for-byte what it was before this setting existed. That
 *   matters more than a tidier default, because `@ai-sdk/openai` writes
 *   `reasoning_effort` into the Chat Completions body *unconditionally* — it does
 *   not drop it for a model it fails to recognise as a reasoning model. A
 *   third-party "OpenAI compatible" gateway that has never heard of the field
 *   will therefore see it and may reject the request, so no model may acquire a
 *   level it was not explicitly given.
 * - `'none'` on Anthropic is not an `effort` value but a different field
 *   (`thinking: { type: 'disabled' }`). It is offered because turning thinking
 *   off is a real Anthropic capability, and the SDK already maps it there.
 */
export type ReasoningEffort = UnifiedReasoningEffort;

/**
 * The levels the AI SDK's unified `reasoning` setting can carry.
 *
 * Worth naming separately because it decides *how* a level is sent. A unified
 * level goes to `streamText` as one value and the SDK's own provider adapter
 * translates it per model — including corrections we could not make ourselves,
 * such as Anthropic turning `high` into `output_config.effort` on models that
 * support it and into a derived `thinking.budget_tokens` on models that do not.
 * Anything outside this set has no unified spelling and must be written by hand
 * into the right provider's options.
 */
export type UnifiedReasoningEffort = NonNullable<CallSettings['reasoning']>;

/** Omit the field: send exactly what the provider would send on its own. */
export const REASONING_EFFORT_DEFAULT = 'provider-default' satisfies ReasoningEffort;

/**
 * Every level any provider offers, in ascending order after the two specials.
 *
 * This is the domain of a *stored* value, deliberately wider than any single
 * provider's list: a model keeps its level when its provider's type is changed,
 * and narrowing on read would silently discard a setting that becomes valid
 * again the moment the type is switched back.
 */
export const REASONING_EFFORTS = [
  'provider-default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ReasoningEffort[];

/**
 * Levels offered per provider type, in display order.
 *
 * Each list is the provider's own enum, plus `'provider-default'` at the front:
 * - `anthropic` — `providerOptions.anthropic.effort` accepts
 *   `low | medium | high | xhigh | max`; `'none'` is added for the separate
 *   thinking-disabled switch. There is no `minimal`, so it is not offered.
 * - `openai-chat` — verbatim the `reasoningEffort` enum of
 *   `@ai-sdk/openai`'s Chat model.
 * - `openai-responses` — the Responses schema types this field as a free string,
 *   i.e. publishes no enum, so this is the broadest set the OpenAI family is
 *   known to take. A model that rejects one fails the request, which is why the
 *   default remains "send nothing".
 */
export const REASONING_EFFORTS_BY_PROVIDER = {
  anthropic: ['provider-default', 'none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'openai-chat': [
    'provider-default',
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ],
  'openai-responses': [
    'provider-default',
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ],
} as const satisfies Record<ProviderType, readonly ReasoningEffort[]>;

/** The levels a model on `type` may be set to. */
export function reasoningEffortsFor(type: ProviderType): readonly ReasoningEffort[] {
  return REASONING_EFFORTS_BY_PROVIDER[type];
}

/**
 * Whether `effort` is a value the provider API itself takes.
 *
 * Only `'provider-default'` is not: it is this app's way of saying "leave the
 * field out". The split drives presentation — a wire value is shown verbatim in
 * the code face, the default is the one row that needs translated prose — and it
 * is the same split {@link resolveReasoningEffort} makes for the request.
 */
export function isWireEffort(effort: ReasoningEffort): boolean {
  return effort !== REASONING_EFFORT_DEFAULT;
}

/**
 * Coerce a stored or imported value into a usable level.
 *
 * Deliberately provider-agnostic: it validates against every known level rather
 * than against the current provider's list, because a level that is merely wrong
 * *here* is still the user's setting and still valid elsewhere. Only a value no
 * provider knows degrades to the default — which is what an imported config from
 * a build that knows a level this one does not, or a hand-edited file, can carry.
 * Forwarding one of those would fail the whole request rather than lose a
 * setting.
 */
export function normalizeReasoningEffort(raw: unknown): ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(raw as string)
    ? (raw as ReasoningEffort)
    : REASONING_EFFORT_DEFAULT;
}

/**
 * The level to send, or `undefined` to leave the setting off entirely.
 *
 * Returning `undefined` for the default rather than passing `'provider-default'`
 * through keeps the omission at *our* boundary: callers spread the result, so a
 * default-configured model produces a request with no reasoning field at all.
 */
export function resolveReasoningEffort(
  effort: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  const normalized = normalizeReasoningEffort(effort);
  return normalized === REASONING_EFFORT_DEFAULT ? undefined : normalized;
}

/**
 * Compile-time guard that {@link REASONING_EFFORTS} offers every level the SDK's
 * unified setting defines.
 *
 * The `satisfies` above only proves the list contains nothing invalid; it says
 * nothing about omissions. Without this, an upgrade that widens the unified
 * setting would leave the new level silently unreachable — no error, no UI entry,
 * just a capability the app quietly lacks. This turns that into a build failure
 * naming the missing member.
 */
type UnofferedEffort = Exclude<UnifiedReasoningEffort, (typeof REASONING_EFFORTS)[number]>;
const _everyUnifiedLevelIsOffered: UnofferedEffort extends never ? true : UnofferedEffort = true;
void _everyUnifiedLevelIsOffered;
