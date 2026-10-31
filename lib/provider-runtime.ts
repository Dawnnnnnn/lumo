/**
 * Provider runtime — the one place a stored provider config becomes an AI SDK
 * model with its request options.
 *
 * Extracted from `lib/ai.ts` so modules that only need a model handle (OCR, the
 * summarizer) do not depend on the agent loop and its tool registry. The
 * provider-specific quirks live here: base URL resolution, OpenCode session
 * headers, reasoning effort translation, and the Responses API's `store: false`.
 */

import { createOpenResponses } from '@ai-sdk/open-responses';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel, ProviderMetadata } from 'ai';
import type { ModelConfig, ProviderConfig } from '@/types';
import {
  isOpenCodeVendor,
  normalizeProviderType,
  resolveBaseUrl,
} from '@/lib/provider-type';
import { openCodeHeaders } from '@/lib/opencode';
import {
  resolveReasoningEffort,
  type UnifiedReasoningEffort,
} from '@/lib/reasoning-effort';

/**
 * A model plus the provider-specific request options it needs.
 *
 * `providerOptions` is not cosmetic for the Responses API: with the SDK default
 * `store: true` and no `previousResponseId`, prior assistant/reasoning parts are
 * replayed as `{ type: 'item_reference', id }`, which requires the server to
 * still hold those items. Forcing `store: false` makes the SDK inline the real
 * content (and auto-request `reasoning.encrypted_content`) instead.
 */
export interface ResolvedModel {
  model: LanguageModel;
  /** `ProviderMetadata` is the request-side provider options bag in ai v7. */
  providerOptions?: ProviderMetadata;
  /**
   * The unified reasoning level for this request, or `undefined` to leave the
   * setting off entirely.
   *
   * Every level reaches this field rather than provider options: the SDK's own
   * provider adapter translates it per model, including corrections we could not
   * make ourselves, such as Anthropic turning `high` into `output_config.effort`
   * on models that support it and into a derived `thinking.budget_tokens` on
   * models that do not, using a capability table we have no access to.
   */
  reasoning?: UnifiedReasoningEffort;
}

export function createProvider(
  provider: ProviderConfig,
  model: ModelConfig,
  /**
   * Session identifier for vendors that route per conversation.
   *
   * Only OpenCode consumes it today, as the `x-opencode-session` header. Callers
   * that are not tied to a conversation (OCR) may omit it, which leaves the
   * header off rather than fabricating one.
   */
  options?: { sessionId?: string },
): ResolvedModel {
  const type = normalizeProviderType(provider.type);
  const effort = resolveReasoningEffort(model.reasoningEffort);
  const reasoning = effort ? { reasoning: effort } : {};
  const baseUrl = resolveBaseUrl(provider);
  // Vendor extras are attached here rather than at each call site: every wire
  // protocol OpenCode serves needs the same two headers, and forgetting one on
  // a branch is exactly how the session header went missing before.
  const headers = isOpenCodeVendor(provider) ? openCodeHeaders(options?.sessionId) : undefined;

  if (type === 'anthropic') {
    const anthropic = createAnthropic({
      apiKey: provider.apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
      ...(headers ? { headers } : {}),
    });
    return {
      model: anthropic(model.modelId),
      ...reasoning,
    };
  }

  if (type === 'openai-responses') {
    const openResponses = createOpenResponses({
      name: 'open-responses',
      url: `${baseUrl || 'https://api.openai.com/v1'}/responses`,
      apiKey: provider.apiKey,
      ...(headers ? { headers } : {}),
    });
    return {
      model: openResponses(model.modelId),
      ...reasoning,
      providerOptions: {
        openai: { store: false },
      },
    };
  }

  // `openai-chat` → /chat/completions, the portable shape every
  // "OpenAI compatible" gateway implements.
  const openai = createOpenAI({
    apiKey: provider.apiKey,
    baseURL: baseUrl || 'https://api.openai.com/v1',
    ...(headers ? { headers } : {}),
  });
  return {
    model: openai.chat(model.modelId),
    ...reasoning,
  };
}
