/**
 * Busy-send normalisation.
 *
 * The value decides whether a send can throw away a half-written reply, so an
 * unrecognised or missing value must land on the non-destructive mode — never on
 * `interrupt`.
 */
import { describe, it, expect } from 'vitest';
import {
  BUSY_SEND_BEHAVIORS,
  DEFAULT_BUSY_SEND,
  normalizeBusySend,
} from '@/lib/busy-send';

describe('normalizeBusySend', () => {
  it('keeps a known behaviour', () => {
    expect(normalizeBusySend('interrupt')).toBe('interrupt');
    expect(normalizeBusySend('steer')).toBe('steer');
  });

  it('falls back to the non-destructive default for anything else', () => {
    // A config written before this setting existed is the common case.
    expect(normalizeBusySend(undefined)).toBe(DEFAULT_BUSY_SEND);
    expect(normalizeBusySend(null)).toBe(DEFAULT_BUSY_SEND);
    expect(normalizeBusySend('')).toBe(DEFAULT_BUSY_SEND);
    expect(normalizeBusySend('immediate')).toBe(DEFAULT_BUSY_SEND);
    expect(normalizeBusySend(true)).toBe(DEFAULT_BUSY_SEND);
  });

  it('defaults to the mode that does not discard work', () => {
    expect(DEFAULT_BUSY_SEND).toBe('steer');
    expect(BUSY_SEND_BEHAVIORS).toContain(DEFAULT_BUSY_SEND);
  });
});
