/**
 * WebMCP execution budget.
 *
 * A page tool can legitimately run longer than a browser action (upload,
 * export, an in-page model call), so the budget comes from the caller instead
 * of a fixed number: the value the page declares, then ours, then the default.
 * These tests pin that precedence and the clamp, because the value decides when
 * a listener gives up — too small truncates real work, too large leaks a port.
 */

import { describe, expect, it } from 'vitest';
import {
  clampWebMcpTimeoutMs,
  resolveWebMcpTimeoutMs,
  WEBMCP_DEFAULT_TIMEOUT_MS,
  WEBMCP_MAX_TIMEOUT_MS,
  WEBMCP_MIN_TIMEOUT_MS,
} from '@/lib/mcp/webmcp-timeout';

describe('resolveWebMcpTimeoutMs', () => {
  it('falls back to the default when the caller names no budget', () => {
    expect(resolveWebMcpTimeoutMs(undefined)).toBe(WEBMCP_DEFAULT_TIMEOUT_MS);
    expect(resolveWebMcpTimeoutMs(null)).toBe(WEBMCP_DEFAULT_TIMEOUT_MS);
    expect(resolveWebMcpTimeoutMs({})).toBe(WEBMCP_DEFAULT_TIMEOUT_MS);
    expect(resolveWebMcpTimeoutMs('120000')).toBe(WEBMCP_DEFAULT_TIMEOUT_MS);
  });

  it('honours a millisecond budget the page schema already defines', () => {
    expect(resolveWebMcpTimeoutMs({ timeoutMs: 90_000 })).toBe(90_000);
    expect(resolveWebMcpTimeoutMs({ timeout: 90_000 })).toBe(90_000);
  });

  it('treats a non-positive or non-finite value as "not given"', () => {
    expect(resolveWebMcpTimeoutMs({ timeoutMs: 0 })).toBe(WEBMCP_DEFAULT_TIMEOUT_MS);
    expect(resolveWebMcpTimeoutMs({ timeoutMs: -5 })).toBe(WEBMCP_DEFAULT_TIMEOUT_MS);
    expect(resolveWebMcpTimeoutMs({ timeoutMs: Number.NaN })).toBe(WEBMCP_DEFAULT_TIMEOUT_MS);
    expect(resolveWebMcpTimeoutMs({ timeout: '5000' })).toBe(WEBMCP_DEFAULT_TIMEOUT_MS);
  });

  it('clamps a request into the usable range instead of trusting it', () => {
    expect(resolveWebMcpTimeoutMs({ timeoutMs: 5 })).toBe(WEBMCP_MIN_TIMEOUT_MS);
    expect(resolveWebMcpTimeoutMs({ timeoutMs: 365 * 24 * 60 * 60 * 1000 })).toBe(
      WEBMCP_MAX_TIMEOUT_MS,
    );
  });

  it('prefers `timeoutMs` when a page declares both fields', () => {
    expect(resolveWebMcpTimeoutMs({ timeoutMs: 60_000, timeout: 5_000 })).toBe(60_000);
  });
});

describe('clampWebMcpTimeoutMs', () => {
  it('truncates fractions and keeps the bounds', () => {
    expect(clampWebMcpTimeoutMs(1_500.9)).toBe(1_500);
    expect(clampWebMcpTimeoutMs(WEBMCP_MIN_TIMEOUT_MS - 1)).toBe(WEBMCP_MIN_TIMEOUT_MS);
    expect(clampWebMcpTimeoutMs(WEBMCP_MAX_TIMEOUT_MS + 1)).toBe(WEBMCP_MAX_TIMEOUT_MS);
  });
});
