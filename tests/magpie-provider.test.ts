import { describe, it, expect } from 'vitest';
import { createProvider } from '@/lib/provider-runtime';
import {
  canFetchModels,
  normalizeProviderVendor,
  providerBaseUrlPlaceholder,
  resolveBaseUrl,
  resolveModelsUrl,
  resolveProviderSessionId,
} from '@/lib/provider-type';
import { MAGPIE_ORIGIN, magpieBaseUrl } from '@/lib/magpie';
import { parseModelList } from '@/lib/provider-models';
import type { ModelConfig, ProviderConfig } from '@/types';

/**
 * Magpie is a self-hosted gateway serving every protocol (and the model list)
 * from one `/v1` base. What is worth pinning down is the default: leaving the
 * URL empty must reach the local gateway for *every* protocol, including
 * Anthropic, whose SDK appends `/messages` straight onto the base.
 */

function magpie(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'p1',
    name: 'Magpie',
    type: 'anthropic',
    vendor: 'magpie',
    apiKey: 'magpie',
    models: [],
    ...overrides,
  };
}

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: 'm1',
    modelId: 'claude/claude-sonnet-5-5',
    displayName: 'Sonnet',
    isVision: false,
    ...overrides,
  };
}

/** A field of the SDK model's internal config — white-box, as in the OpenCode suite. */
function sdkConfig(resolved: ReturnType<typeof createProvider>): Record<string, unknown> {
  return (resolved.model as unknown as { config: Record<string, unknown> }).config;
}

describe('Magpie vendor', () => {
  it('is a known vendor', () => {
    expect(normalizeProviderVendor('magpie')).toBe('magpie');
  });

  it.each(['openai-chat', 'openai-responses', 'anthropic'] as const)(
    'defaults the %s base URL to the local gateway',
    (type) => {
      expect(resolveBaseUrl(magpie({ type }))).toBe('http://127.0.0.1:3425/v1');
    },
  );

  it('lets a typed URL win over the default', () => {
    expect(resolveBaseUrl(magpie({ baseUrl: 'http://10.0.0.2:3425/v1' }))).toBe(
      'http://10.0.0.2:3425/v1',
    );
  });

  it('lists models under the shared base, with or without a typed URL', () => {
    expect(resolveModelsUrl(magpie())).toBe('http://127.0.0.1:3425/v1/models');
    expect(resolveModelsUrl(magpie({ baseUrl: 'http://gw.internal/v1/' }))).toBe(
      'http://gw.internal/v1/models',
    );
  });

  it('hints the default endpoint as the placeholder for every protocol', () => {
    expect(providerBaseUrlPlaceholder('magpie', 'anthropic')).toBe('http://127.0.0.1:3425/v1');
    expect(providerBaseUrlPlaceholder('magpie', 'openai-chat')).toBe('http://127.0.0.1:3425/v1');
  });

  it('builds the base from an origin, tolerating a trailing slash', () => {
    expect(magpieBaseUrl()).toBe(`${MAGPIE_ORIGIN}/v1`);
    expect(magpieBaseUrl('http://gw.internal:8080/')).toBe('http://gw.internal:8080/v1');
  });

  it('sends Anthropic requests to the gateway rather than api.anthropic.com', () => {
    const config = sdkConfig(createProvider(magpie(), model()));
    expect(config.baseURL).toBe('http://127.0.0.1:3425/v1');
  });

  it('adds no vendor headers and no routing session', async () => {
    const headers = sdkConfig(createProvider(magpie({ type: 'openai-chat' }), model())).headers;
    const resolved = typeof headers === 'function' ? headers() : headers;
    expect(Object.keys(resolved as Record<string, string>).some((k) => k.startsWith('x-opencode')))
      .toBe(false);
    expect(await resolveProviderSessionId(magpie(), 'conv-1')).toBeUndefined();
  });
});

describe('canFetchModels', () => {
  it.each([
    [{ vendor: 'magpie', type: 'anthropic' }, true],
    [{ vendor: 'opencode', type: 'anthropic' }, true],
    [{ vendor: 'custom', type: 'openai-chat' }, true],
    [{ vendor: undefined, type: 'openai-responses' }, true],
    // The official Anthropic API rejects the Bearer-authenticated list request.
    [{ vendor: 'custom', type: 'anthropic' }, false],
    [{ vendor: undefined, type: 'anthropic' }, false],
  ] as const)('%o → %s', (input, expected) => {
    expect(canFetchModels(input)).toBe(expected);
  });
});

describe('parseModelList', () => {
  it('reads the details Magpie publishes', () => {
    expect(
      parseModelList({
        data: [
          {
            id: 'ai/deepseek-v4.1-flash-1017[1m]',
            display_name: 'DeepSeek V4.1 Flash 1017 [1m]',
            context_window: 1_000_000,
            context_length: 1_000_000,
          },
        ],
      }),
    ).toEqual([
      {
        id: 'ai/deepseek-v4.1-flash-1017[1m]',
        displayName: 'DeepSeek V4.1 Flash 1017 [1m]',
        contextWindow: 1_000_000,
      },
    ]);
  });

  it('falls back to context_length and drops unusable windows', () => {
    expect(
      parseModelList({
        data: [
          { id: 'a', context_length: 128_000 },
          { id: 'b', context_window: 12 },
        ],
      }),
    ).toEqual([{ id: 'a', contextWindow: 128_000 }, { id: 'b' }]);
  });

  it('omits a display name that only repeats the id', () => {
    expect(parseModelList({ data: [{ id: 'gpt-4o', display_name: 'gpt-4o' }] })).toEqual([
      { id: 'gpt-4o' },
    ]);
  });

  it('accepts bare ids and LiteLLM entries, deduplicated and sorted', () => {
    expect(
      parseModelList({ data: ['b', { model_name: 'a' }, { id: 'b' }, { id: '' }, null, 3] }).map(
        (m) => m.id,
      ),
    ).toEqual(['a', 'b']);
  });

  it.each([null, {}, { data: {} }, 'oops'])('reads %o as no models', (payload) => {
    expect(parseModelList(payload)).toEqual([]);
  });
});
