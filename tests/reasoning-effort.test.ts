import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { en } from '@/i18n/en';
import { zh } from '@/i18n/zh';
import { resumeFingerprint, runAgentLoop } from '@/lib/ai';
import { createProvider } from '@/lib/provider-runtime';
import { normalizeProvider } from '@/lib/provider-type';
import {
  REASONING_EFFORTS,
  REASONING_EFFORTS_BY_PROVIDER,
  REASONING_EFFORT_DEFAULT,
  isWireEffort,
  normalizeReasoningEffort,
  reasoningEffortsFor,
  resolveReasoningEffort,
} from '@/lib/reasoning-effort';
import type { ModelConfig, ProviderConfig, ProviderType } from '@/types';

/**
 * The reasoning level is stored per model but its legal values belong to the
 * *provider*, and the failure a wrong one causes is not a degraded reply but a
 * rejected request: `@ai-sdk/openai` writes `reasoning_effort` into the Chat
 * Completions body unconditionally, without checking whether the model id is one
 * it knows to be a reasoning model. So two properties are worth pinning down:
 * the default reaches the provider as *nothing at all* — no key, no `undefined` —
 * and a chosen level takes the one route that provider understands.
 */

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'p1',
    name: 'My Provider',
    type: 'openai-chat',
    apiKey: 'sk-test',
    models: [],
    ...overrides,
  };
}

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { id: 'm1', modelId: 'gpt-4o', displayName: 'GPT-4o', isVision: false, ...overrides };
}

/** Resolves a dotted i18n key against a locale bundle. */
function lookup(bundle: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], bundle);
}

describe('normalizeReasoningEffort', () => {
  it('reads an absent value as the provider default', () => {
    // A model stored before this setting existed must not acquire a level: the
    // request it produced yesterday has to be the request it produces today.
    expect(normalizeReasoningEffort(undefined)).toBe(REASONING_EFFORT_DEFAULT);
    expect(normalizeReasoningEffort(null)).toBe(REASONING_EFFORT_DEFAULT);
    expect(normalizeReasoningEffort('')).toBe(REASONING_EFFORT_DEFAULT);
  });

  it('keeps every offered level verbatim', () => {
    for (const effort of REASONING_EFFORTS) {
      expect(normalizeReasoningEffort(effort)).toBe(effort);
    }
  });

  it('degrades an unrecognised level to the default instead of forwarding it', () => {
    // These are the shapes an imported or hand-edited config can carry. Passing
    // one through would fail the whole request at the provider, not just lose
    // the setting.
    expect(normalizeReasoningEffort('ultra')).toBe(REASONING_EFFORT_DEFAULT);
    expect(normalizeReasoningEffort('HIGH')).toBe(REASONING_EFFORT_DEFAULT);
    expect(normalizeReasoningEffort(3)).toBe(REASONING_EFFORT_DEFAULT);
    expect(normalizeReasoningEffort({ effort: 'high' })).toBe(REASONING_EFFORT_DEFAULT);
  });
});

describe('resolveReasoningEffort', () => {
  it('resolves the default to undefined so the caller can omit the setting', () => {
    expect(resolveReasoningEffort(undefined)).toBeUndefined();
    expect(resolveReasoningEffort(REASONING_EFFORT_DEFAULT)).toBeUndefined();
  });

  it('distinguishes "off" from "provider default"', () => {
    // `none` is an instruction — Anthropic `thinking: disabled`, OpenAI
    // `reasoning_effort: 'none'` — so it must survive as a value.
    expect(resolveReasoningEffort('none')).toBe('none');
  });

  it('passes a chosen level through', () => {
    expect(resolveReasoningEffort('xhigh')).toBe('xhigh');
  });
});

describe('normalizeProvider', () => {
  it('drops a model level it does not recognise', () => {
    const stored = provider({
      models: [model({ reasoningEffort: 'ludicrous' as never })],
    });
    expect(normalizeProvider(stored).models[0]!.reasoningEffort).toBe(REASONING_EFFORT_DEFAULT);
  });

  it('leaves an absent level absent rather than materialising the default', () => {
    // Writing the default in on every read would rewrite every stored model and
    // hand React a new identity for every row on each storage change.
    const stored = provider({ models: [model()] });
    const normalized = normalizeProvider(stored);
    expect(normalized).toBe(stored);
    expect('reasoningEffort' in normalized.models[0]!).toBe(false);
  });

  it('keeps a valid level and the provider identity untouched', () => {
    const stored = provider({ models: [model({ reasoningEffort: 'medium' })] });
    expect(normalizeProvider(stored)).toBe(stored);
  });

  it('drops an unusable context window and keeps a valid one', () => {
    // Same reasoning as an unknown reasoning level: a hand-edited export must
    // not reach the ring as a denominator the user never chose.
    const invalid = provider({ models: [model({ contextWindow: -1 })] });
    expect(normalizeProvider(invalid).models[0]!.contextWindow).toBeUndefined();

    const valid = provider({ models: [model({ contextWindow: 128_000 })] });
    expect(normalizeProvider(valid).models[0]!.contextWindow).toBe(128_000);
  });

  it('tolerates a config with no models array', () => {
    // Imported files are not guaranteed to be well-formed, and throwing here
    // would take down the whole import rather than one provider.
    const stored = { ...provider(), models: undefined } as unknown as ProviderConfig;
    expect(() => normalizeProvider(stored)).not.toThrow();
  });
});

describe('createProvider', () => {
  const TYPES: ProviderType[] = ['openai-chat', 'openai-responses', 'anthropic'];

  it.each(TYPES)('routes a unified level through the top-level setting on %s', (type) => {
    const resolved = createProvider(
      provider({ type, apiKey: 'sk-test' }),
      model({ reasoningEffort: 'high' }),
    );
    // The SDK's own adapter translates it per model — on Anthropic that is
    // `output_config.effort` or a derived `thinking.budget_tokens` depending on
    // the model, a decision we deliberately do not reimplement.
    expect(resolved.reasoning).toBe('high');
  });

  it.each(TYPES)('omits the key entirely on %s when left on the default', (type) => {
    const resolved = createProvider(provider({ type }), model());
    expect('reasoning' in resolved).toBe(false);
  });

  it('sends max as the unified setting on every provider', () => {
    // `max` is part of the SDK's unified union, so it travels the same route as
    // every other level and the provider adapter decides how to spell it.
    for (const type of TYPES) {
      const resolved = createProvider(
        provider({ type }),
        model({ reasoningEffort: 'max' }),
      );
      expect(resolved.reasoning, type).toBe('max');
    }
  });

  it('keeps the Responses stateless options alongside a unified level', () => {
    // The level must not displace `store: false`, which is what stops replayed
    // history from being sent as `item_reference`.
    const resolved = createProvider(
      provider({ type: 'openai-responses' }),
      model({ reasoningEffort: 'low' }),
    );
    expect(resolved.reasoning).toBe('low');
    expect(resolved.providerOptions?.openai?.store).toBe(false);
  });

  it('keeps the Responses stateless options alongside max', () => {
    // Same guarantee on the branch that writes into the same options bag: this is
    // the one place a careless spread could drop `store: false`.
    const resolved = createProvider(
      provider({ type: 'openai-responses' }),
      model({ reasoningEffort: 'max' }),
    );
    expect(resolved.reasoning).toBe('max');
    expect(resolved.providerOptions?.openai).toMatchObject({
      store: false,
    });
    // `reasoningSummary` is left to the SDK to derive from the effort.
    expect(resolved.providerOptions?.openai).not.toHaveProperty('reasoningSummary');
  });
});

describe('per-provider level lists', () => {
  it('offers the provider default on every type', () => {
    for (const [type, levels] of Object.entries(REASONING_EFFORTS_BY_PROVIDER)) {
      // "Send nothing" is the app's own escape hatch, not a provider value, so it
      // must be reachable no matter which provider is selected.
      expect(levels[0], type).toBe(REASONING_EFFORT_DEFAULT);
    }
  });

  it('offers only levels the app knows how to send', () => {
    for (const [type, levels] of Object.entries(REASONING_EFFORTS_BY_PROVIDER)) {
      for (const level of levels) {
        expect(REASONING_EFFORTS, `${type}: ${level}`).toContain(level);
      }
    }
  });

  it('does not offer minimal on Anthropic', () => {
    // Anthropic's effort enum has no `minimal`, and the lists follow the
    // provider's enum rather than a house style.
    expect(reasoningEffortsFor('anthropic')).not.toContain('minimal');
    expect(reasoningEffortsFor('openai-chat')).toContain('minimal');
  });

  it('offers max everywhere, since every provider enum has it', () => {
    for (const type of ['anthropic', 'openai-chat', 'openai-responses'] as const) {
      expect(reasoningEffortsFor(type), type).toContain('max');
    }
  });
});

describe('resumeFingerprint', () => {
  const identity = {
    conversationId: 'c1',
    provider: provider(),
    messageCount: 2,
  };

  it('changes when the level changes', () => {
    // A checkpoint is a raw model prompt. On Anthropic the level decides whether
    // thinking blocks are in it at all, so replaying one under a different level
    // is exactly the mismatch the fingerprint exists to catch.
    const before = resumeFingerprint({ ...identity, model: model({ reasoningEffort: 'low' }) });
    const after = resumeFingerprint({ ...identity, model: model({ reasoningEffort: 'high' }) });
    expect(before).not.toBe(after);
  });

  it('treats an absent level and an explicit default as the same request', () => {
    // Both omit the field, so a snapshot taken under one is valid under the
    // other — invalidating it would throw away resumable work for nothing.
    expect(resumeFingerprint({ ...identity, model: model() })).toBe(
      resumeFingerprint({
        ...identity,
        model: model({ reasoningEffort: REASONING_EFFORT_DEFAULT }),
      }),
    );
  });
});

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} satisfies LanguageModelV4Usage;

/** A model that records the call options and answers with one text chunk. */
function recordingModel(calls: LanguageModelV4CallOptions[]) {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      calls.push(options);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: '0' },
            { type: 'text-delta', id: '0', delta: 'ok' },
            { type: 'text-end', id: '0' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: USAGE,
            },
          ] satisfies LanguageModelV4StreamPart[],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

describe('runAgentLoop reasoning pass-through', () => {
  const messages = [{ role: 'user' as const, content: 'hi' }];

  it('hands the level to the model call', async () => {
    const calls: LanguageModelV4CallOptions[] = [];
    await runAgentLoop({ model: recordingModel(calls), messages, reasoning: 'medium' });
    expect(calls[0]!.reasoning).toBe('medium');
  });

  it('leaves the setting off when no level is configured', async () => {
    const calls: LanguageModelV4CallOptions[] = [];
    await runAgentLoop({ model: recordingModel(calls), messages });
    expect(calls[0]!.reasoning).toBeUndefined();
  });
});

describe('i18n', () => {
  it('translates the field label, the hint and the one non-wire level', () => {
    // Only the default level and the prose are translated: every other level is
    // rendered verbatim because it is the API's own value — see
    // REASONING_EFFORTS — so it has no label that could go missing.
    for (const [name, bundle] of [
      ['en', en],
      ['zh', zh],
    ] as const) {
      for (const key of [
        'options.models.reasoningEffort',
        'options.models.reasoningEffortDefault',
      ]) {
        expect(typeof lookup(bundle, key), `${name}: ${key}`).toBe('string');
      }
    }
  });

  it('needs translated copy for exactly one level', () => {
    // Guards the assumption the dialog is built on: if a future level is added
    // that is not a wire value, it needs its own copy and this will say so.
    expect(REASONING_EFFORTS.filter((effort) => !isWireEffort(effort))).toEqual([
      REASONING_EFFORT_DEFAULT,
    ]);
  });
});
