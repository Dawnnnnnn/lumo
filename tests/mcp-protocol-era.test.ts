import { describe, it, expect } from 'vitest';
import { EXPORTABLE_KEYS, STORAGE_FIELDS } from '@/store/storage-schema';
import {
  classifyDiscoveryError,
  classifyDiscoveryResponse,
  eraCacheKey,
  jsonRpcErrorCode,
  mergeProtocolEras,
  normalizeProtocolEras,
  probeProtocolEra,
  MAX_CACHED_ERAS,
  MODERN_PROBE_VERSION,
} from '@/lib/mcp/protocol-era';

/** The real rejection `https://mcp.exa.ai/mcp` returns to a modern probe. */
const EXA_400_BODY =
  '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Unsupported protocol version: 2026-07-28 (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)"},"id":null}';

/** A spec-compliant modern answer to a version it does not implement. */
const MODERN_400_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  error: {
    code: -32022,
    message: 'Unsupported protocol version',
    data: { supported: ['2026-07-28', '2025-11-25'], requested: '1900-01-01' },
  },
});

describe('classifyDiscoveryResponse', () => {
  it('treats a non-modern 400 as a legacy server, even when the wording sounds modern', () => {
    // The spec's rule: on 400, inspect the body. `-32000` is not a recognized
    // modern error, so this endpoint is legacy — this is the exa case.
    expect(classifyDiscoveryResponse(400, EXA_400_BODY)).toBe('legacy');
  });

  it('treats a recognized modern error as a modern server', () => {
    expect(classifyDiscoveryResponse(400, MODERN_400_BODY)).toBe('modern');
    // HeaderMismatch / MissingRequiredClientCapability are modern too.
    expect(classifyDiscoveryResponse(400, '{"error":{"code":-32020}}')).toBe('modern');
    expect(classifyDiscoveryResponse(400, '{"error":{"code":-32021}}')).toBe('modern');
  });

  it('treats an empty or unrecognized body as legacy', () => {
    expect(classifyDiscoveryResponse(400, '')).toBe('legacy');
    expect(classifyDiscoveryResponse(400, 'Bad Request')).toBe('legacy');
    expect(classifyDiscoveryResponse(404, 'not found')).toBe('legacy');
    expect(classifyDiscoveryResponse(405, '')).toBe('legacy');
  });

  it('does not read authentication or transient failures as an era', () => {
    expect(classifyDiscoveryResponse(401, '')).toBe('unknown');
    expect(classifyDiscoveryResponse(403, '')).toBe('unknown');
    expect(classifyDiscoveryResponse(408, '')).toBe('unknown');
    expect(classifyDiscoveryResponse(429, '')).toBe('unknown');
    expect(classifyDiscoveryResponse(500, '')).toBe('unknown');
    expect(classifyDiscoveryResponse(502, '')).toBe('unknown');
  });

  it('accepts a 2xx answer as a modern server', () => {
    expect(classifyDiscoveryResponse(200, '{"result":{"supportedVersions":["2026-07-28"]}}')).toBe(
      'modern',
    );
  });

  it('downgrades a 2xx that carries "method not found"', () => {
    expect(classifyDiscoveryResponse(200, '{"error":{"code":-32601}}')).toBe('legacy');
  });

  it('reads the code out of an SSE-framed body', () => {
    const sse = `event: message\ndata: ${MODERN_400_BODY}\n\n`;
    expect(jsonRpcErrorCode(sse)).toBe(-32022);
    expect(classifyDiscoveryResponse(400, sse)).toBe('modern');
  });
});

describe('classifyDiscoveryError', () => {
  it('classifies the transport error the SDK reports for a legacy probe', () => {
    // Shape of `MCPClientError` from `@ai-sdk/mcp`.
    expect(
      classifyDiscoveryError({
        message: 'MCP HTTP Transport Error: POSTing to endpoint (HTTP 400)',
        statusCode: 400,
        responseBody: EXA_400_BODY,
        code: undefined,
      }),
    ).toBe('legacy');
  });

  it('classifies a modern version rejection by its JSON-RPC code', () => {
    expect(classifyDiscoveryError({ code: -32022, statusCode: 400 })).toBe('modern');
  });

  it('refuses to guess from network and auth errors', () => {
    expect(classifyDiscoveryError(new Error('Failed to fetch'))).toBe('unknown');
    expect(classifyDiscoveryError({ statusCode: 401 })).toBe('unknown');
    expect(classifyDiscoveryError(undefined)).toBe('unknown');
    expect(classifyDiscoveryError(null)).toBe('unknown');
  });
});

describe('probeProtocolEra', () => {
  it('sends one modern server/discover request and reports a legacy server', async () => {
    const seen: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: unknown }> = [];
    const probe = probeProtocolEra('https://mcp.exa.ai/mcp', {
      headers: { 'x-api-key': 'k' },
      fetch: async (input, init) => {
        seen.push({
          url: String(input),
          method: init?.method,
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body)),
        });
        return new Response(EXA_400_BODY, {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await expect(probe).resolves.toBe('legacy');
    expect(seen).toHaveLength(1);
    const request = seen[0]!;
    expect(request.url).toBe('https://mcp.exa.ai/mcp');
    expect(request.method).toBe('POST');
    expect(request.headers?.['mcp-protocol-version']).toBe(MODERN_PROBE_VERSION);
    expect(request.headers?.['x-api-key']).toBe('k');
    expect(request.body).toMatchObject({ jsonrpc: '2.0', method: 'server/discover' });
  });

  it('reports a modern server without reading its SSE stream', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message\n'));
        // Left open on purpose: reading it would hang until the probe timeout.
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      probeProtocolEra('https://example.com/mcp', {
        fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      }),
    ).resolves.toBe('modern');
    expect(cancelled).toBe(true);
  });

  it('gives up as unknown when the endpoint is slow or unreachable', async () => {
    const hang = probeProtocolEra('https://example.com/mcp', {
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await expect(hang).resolves.toBe('unknown');

    await expect(
      probeProtocolEra('https://example.com/mcp', {
        fetch: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    ).resolves.toBe('unknown');
  });
});

describe('era cache', () => {
  it('keys by origin, as the spec does for HTTP', () => {
    expect(eraCacheKey('https://mcp.exa.ai/mcp')).toBe('https://mcp.exa.ai');
    expect(eraCacheKey('https://mcp.exa.ai/other?x=1')).toBe('https://mcp.exa.ai');
    expect(eraCacheKey('not a url')).toBe('not a url');
  });

  it('drops malformed records and repairs missing timestamps', () => {
    const normalized = normalizeProtocolEras({
      'https://a.test': { era: 'legacy', updatedAt: 1 },
      'https://b.test': { era: 'modern', updatedAt: 2 },
      'https://c.test': { era: 'sideways', updatedAt: 3 },
      'https://d.test': { era: 'legacy', updatedAt: 'yesterday' },
      'https://e.test': null,
    });

    expect(Object.keys(normalized).sort()).toEqual([
      'https://a.test',
      'https://b.test',
      'https://d.test',
    ]);
    expect(normalized['https://d.test']!.updatedAt).toBe(0);
    expect(normalizeProtocolEras(undefined)).toEqual({});
    expect(normalizeProtocolEras('nope')).toEqual({});
  });

  it('stays bounded, keeping the most recently confirmed origins', () => {
    const raw: Record<string, { era: 'legacy'; updatedAt: number }> = {};
    for (let i = 0; i < MAX_CACHED_ERAS + 10; i++) {
      raw[`https://s${i}.test`] = { era: 'legacy', updatedAt: i };
    }
    const normalized = normalizeProtocolEras(raw);
    expect(Object.keys(normalized)).toHaveLength(MAX_CACHED_ERAS);
    expect(normalized['https://s0.test']).toBeUndefined();
    expect(normalized[`https://s${MAX_CACHED_ERAS + 9}.test`]).toBeDefined();
  });

  it('is runtime state, so it never travels in an exported config', () => {
    expect(EXPORTABLE_KEYS).not.toContain('mcpProtocolEras');
    expect(STORAGE_FIELDS.mcpProtocolEras.normalize?.({
      'https://a.test': { era: 'legacy', updatedAt: 5 },
    })).toEqual({ 'https://a.test': { era: 'legacy', updatedAt: 5 } });
  });

  it('prefers the more recently confirmed verdict when merging contexts', () => {
    const merged = mergeProtocolEras(
      {
        'https://old.test': { era: 'legacy', updatedAt: 10 },
        'https://stale.test': { era: 'legacy', updatedAt: 5 },
      },
      {
        'https://stale.test': { era: 'modern', updatedAt: 20 },
        'https://new.test': { era: 'modern', updatedAt: 15 },
      },
    );

    // Unchanged, replaced by a newer observation, and newly learned.
    expect(merged['https://old.test']!.era).toBe('legacy');
    expect(merged['https://stale.test']).toEqual({ era: 'modern', updatedAt: 20 });
    expect(merged['https://new.test']!.era).toBe('modern');
  });
});
