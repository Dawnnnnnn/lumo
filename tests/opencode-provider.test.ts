import { describe, it, expect } from 'vitest';
import { createProvider } from '@/lib/provider-runtime';
import {
  isOpenCodeVendor,
  normalizeProvider,
  normalizeProviderVendor,
  providerBaseUrlPlaceholder,
  resolveBaseUrl,
  resolveModelsUrl,
  resolveProviderSessionId,
} from '@/lib/provider-type';
import {
  OPENCODE_CLIENT,
  deriveOpenCodeSession,
  openCodeBaseUrl,
  openCodeModelsUrl,
} from '@/lib/opencode';
import type { ModelConfig, ProviderConfig } from '@/types';

/**
 * OpenCode is the one vendor whose endpoints do not follow `${baseUrl}/…`.
 *
 * Two failures are worth pinning down, because both are silent:
 * 1. the model-shot endpoint is a *sibling* of the protocol path, so a
 *    `${baseUrl}/models` fetch 404s instead of listing anything;
 * 2. the per-conversation routing headers are absent, so requests are
 *    attributed to nobody — which only surfaces as a wrong upstream answer.
 *
 * The header assertions read the SDK model's internal `config`. That is
 * white-box, but so is the existing reasoning-effort suite: the alternative is
 * issuing a real request, and the wire shape is exactly what is being checked.
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

/** Request headers the SDK model will actually send, per its own config. */
function requestHeaders(resolved: ReturnType<typeof createProvider>): Record<string, string> {
  const config = (resolved.model as unknown as { config?: { headers?: unknown } }).config;
  const headers = config?.headers;
  if (typeof headers === 'function') return headers() as Record<string, string>;
  return (headers as Record<string, string>) ?? {};
}

/** URL the OpenAI Responses model resolves to. */
function responsesUrl(resolved: ReturnType<typeof createProvider>): string {
  const config = (resolved.model as unknown as { config?: { url?: unknown } }).config;
  return String(config?.url);
}

describe('normalizeProviderVendor', () => {
  it('preserves an absent vendor rather than materialising "custom"', () => {
    // Same rule as `reasoningEffort`: absence already *means* custom, and
    // writing it back would rewrite every stored provider on a plain read.
    expect(normalizeProviderVendor(undefined)).toBeUndefined();
  });

  it.each([
    ['custom', 'custom'],
    ['opencode', 'opencode'],
  ] as const)('keeps the known vendor %s', (input, expected) => {
    expect(normalizeProviderVendor(input)).toBe(expected);
  });

  it('degrades an unknown vendor to custom', () => {
    // A value from a build that knows a vendor this one doesn't must not be
    // forwarded as if it were understood.
    expect(normalizeProviderVendor('mystery-vendor')).toBe('custom');
  });

  it('leaves a provider without a vendor identity-stable', () => {
    const stored = provider();
    expect(normalizeProvider(stored)).toBe(stored);
  });

  it('adds the vendor when a stored one is stale', () => {
    const normalized = normalizeProvider(provider({ vendor: 'mystery-vendor' as never }));
    expect(normalized.vendor).toBe('custom');
  });
});

describe('resolveBaseUrl', () => {
  it.each([
    ['openai-chat', 'https://opencode.ai/inference/openai/v1'],
    ['openai-responses', 'https://opencode.ai/inference/openai/v1'],
    ['anthropic', 'https://opencode.ai/inference/anthropic'],
  ] as const)('derives the OpenCode %s endpoint', (type, expected) => {
    expect(resolveBaseUrl(provider({ vendor: 'opencode', type }))).toBe(expected);
  });

  it('lets a typed URL win over the derived one', () => {
    expect(
      resolveBaseUrl(provider({ vendor: 'opencode', baseUrl: 'https://proxy.internal/v1' })),
    ).toBe('https://proxy.internal/v1');
  });

  it('answers with nothing for a custom provider, leaving the SDK default', () => {
    expect(resolveBaseUrl(provider())).toBeUndefined();
  });
});

describe('resolveModelsUrl', () => {
  it('uses the shared OpenCode list endpoint regardless of protocol', () => {
    for (const type of ['openai-chat', 'openai-responses', 'anthropic'] as const) {
      expect(resolveModelsUrl(provider({ vendor: 'opencode', type }))).toBe(
        'https://opencode.ai/inference/v1/models',
      );
    }
  });

  it('derives the OpenCode list endpoint from a typed protocol URL', () => {
    // The failure this guards: appending `/models` to the Anthropic base gives
    // `https://opencode.ai/inference/models`, which 404s.
    expect(
      resolveModelsUrl(
        provider({ vendor: 'opencode', type: 'anthropic', baseUrl: openCodeBaseUrl('anthropic') }),
      ),
    ).toBe('https://opencode.ai/inference/v1/models');
  });

  it('keeps a self-hosted OpenCode subpath', () => {
    expect(
      resolveModelsUrl(
        provider({ vendor: 'opencode', baseUrl: 'https://host.example/oc/inference/openai/v1' }),
      ),
    ).toBe('https://host.example/oc/inference/v1/models');
  });

  it('keeps the historical derivation for a custom provider', () => {
    expect(resolveModelsUrl(provider({ baseUrl: 'https://api.example.com/v1' }))).toBe(
      'https://api.example.com/v1/models',
    );
  });

  it('does not double up when the URL already names /models', () => {
    expect(resolveModelsUrl(provider({ baseUrl: 'https://api.example.com/v1/models' }))).toBe(
      'https://api.example.com/v1/models',
    );
  });

  it('answers with nothing when a custom provider has no URL', () => {
    expect(resolveModelsUrl(provider())).toBeUndefined();
  });
});

describe('OpenCode session identity', () => {
  it('is deterministic for the same conversation', async () => {
    // Stability is the point: OpenCode routes on it, so a changing id would
    // scatter one conversation's requests.
    expect(await deriveOpenCodeSession('conv-1')).toBe(await deriveOpenCodeSession('conv-1'));
  });

  it('separates different conversations', async () => {
    expect(await deriveOpenCodeSession('conv-1')).not.toBe(await deriveOpenCodeSession('conv-2'));
  });

  it('is de-identified: the shape is OpenCode\'s, the value is not the seed', async () => {
    const session = await deriveOpenCodeSession('conv-1');
    expect(session).toMatch(/^ses_[0-9a-f]{64}$/);
    expect(session).not.toContain('conv-1');
  });

  it('resolves to nothing for a vendor that does not route per conversation', async () => {
    expect(await resolveProviderSessionId(provider(), 'conv-1')).toBeUndefined();
  });

  it('falls back to a stable per-provider id outside a conversation', async () => {
    // OCR runs without one, and a vendor routing on the session should still
    // see one consistent identity rather than a new one per call.
    const ocr = await resolveProviderSessionId(provider({ vendor: 'opencode' }));
    expect(ocr).toMatch(/^ses_[0-9a-f]{64}$/);
    expect(ocr).toBe(await resolveProviderSessionId(provider({ vendor: 'opencode' })));
  });

  it('derives a distinct session for compaction, keeping it routable but separate', async () => {
    // OpenCode rejects a request with no session header, so the summarizer must
    // send one. It is salted away from the live chat's session so the one-off
    // summary does not share its routing/cache affinity.
    const openCode = provider({ vendor: 'opencode' });
    const chat = await resolveProviderSessionId(openCode, 'conv-1');
    const compaction = await resolveProviderSessionId(openCode, 'conv-1:compaction');
    expect(compaction).toMatch(/^ses_[0-9a-f]{64}$/);
    expect(compaction).not.toBe(chat);
  });
});

describe('createProvider on OpenCode', () => {
  const openCode = (overrides: Partial<ProviderConfig> = {}) =>
    provider({ vendor: 'opencode', ...overrides });

  it.each(['openai-chat', 'openai-responses', 'anthropic'] as const)(
    'sends the client and session headers on %s',
    async (type) => {
      const sessionId = await deriveOpenCodeSession('conv-1');
      const headers = requestHeaders(createProvider(openCode({ type }), model(), { sessionId }));
      expect(headers['x-opencode-client']).toBe(OPENCODE_CLIENT);
      expect(headers['x-opencode-session']).toBe(sessionId);
    },
  );

  it('omits the session header when no session is known', () => {
    const headers = requestHeaders(createProvider(openCode(), model()));
    expect(headers['x-opencode-client']).toBe(OPENCODE_CLIENT);
    expect(headers['x-opencode-session']).toBeUndefined();
  });

  it('sends no vendor headers for a custom provider', () => {
    const headers = requestHeaders(createProvider(provider(), model(), { sessionId: 'ses_x' }));
    expect(headers['x-opencode-client']).toBeUndefined();
    expect(headers['x-opencode-session']).toBeUndefined();
  });

  it('resolves the Responses URL onto the OpenCode path', () => {
    expect(responsesUrl(createProvider(openCode({ type: 'openai-responses' }), model()))).toBe(
      'https://opencode.ai/inference/openai/v1/responses',
    );
  });
});

describe('vendor helpers', () => {
  it('reports the vendor', () => {
    expect(isOpenCodeVendor(provider({ vendor: 'opencode' }))).toBe(true);
    expect(isOpenCodeVendor(provider())).toBe(false);
  });

  it('hints the derived endpoint as the placeholder', () => {
    expect(providerBaseUrlPlaceholder('opencode', 'anthropic')).toBe(
      'https://opencode.ai/inference/anthropic',
    );
    expect(providerBaseUrlPlaceholder(undefined, 'anthropic')).toBe('https://api.anthropic.com');
    expect(providerBaseUrlPlaceholder('custom', 'openai-chat')).toBe('https://api.openai.com/v1');
  });

  it('builds the OpenCode list URL from a base URL', () => {
    expect(openCodeModelsUrl('https://opencode.ai/inference/openai/v1')).toBe(
      'https://opencode.ai/inference/v1/models',
    );
  });
});
