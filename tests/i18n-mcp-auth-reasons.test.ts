import { describe, it, expect, beforeAll } from 'vitest';
import i18next from 'i18next';
import { en } from '@/i18n/en';
import { zh } from '@/i18n/zh';
import { AUTH_REASON_KEYS } from '@/lib/mcp/server-labels';
import type { McpAuthFailureReason } from '@/lib/mcp/oauth/types';

/**
 * Guards the OAuth failure copy.
 *
 * `AUTH_REASON_KEYS` is a runtime map from reason to translation key, so the
 * static `i18n:check` contract cannot see it: a typo there would not fail the
 * locale comparison, it would silently render the raw key on the server card.
 * Resolving every value through i18next is the only check that catches it.
 */

/** Every reason the union carries; the map must be total over it. */
const REASONS: McpAuthFailureReason[] = [
  'authorization-required',
  'insufficient-scope',
  'no-registration',
  'identity-unavailable',
  'busy',
  'authorization-server-error',
  'temporary',
  // Not OAuth: the extension provider wants the user's approval, and the card
  // reuses this surface so the wording stays localized.
  'extension-approval',
];

beforeAll(async () => {
  await i18next.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, zh: { translation: zh } },
    interpolation: { escapeValue: false },
  });
});

describe('authorization failure copy', () => {
  it('maps every reason to a key', () => {
    expect(Object.keys(AUTH_REASON_KEYS).sort()).toEqual([...REASONS].sort());
  });

  it.each(['en', 'zh'] as const)('resolves each reason to its own sentence in %s', async (lng) => {
    await i18next.changeLanguage(lng);

    const sentences = REASONS.map((reason) => {
      const key = AUTH_REASON_KEYS[reason];
      const sentence = i18next.t(key);
      // A missing key resolves to the key itself; a fallback-to-English bug under
      // `zh` would show up as a sentence identical to the English one.
      expect(sentence, `${lng}:${reason}`).not.toBe(key);
      expect(sentence.trim(), `${lng}:${reason}`).not.toBe('');
      return sentence;
    });

    // Each reason names a different next step, so no two may read the same.
    expect(new Set(sentences).size).toBe(REASONS.length);
  });
});
