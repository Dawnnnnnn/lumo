import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMcpProtocolEras: vi.fn(),
  setMcpProtocolEras: vi.fn(),
  probeProtocolEra: vi.fn(),
}));

vi.mock('@/store/storage', () => ({
  storage: {
    getMcpProtocolEras: mocks.getMcpProtocolEras,
    setMcpProtocolEras: mocks.setMcpProtocolEras,
  },
}));

vi.mock('@/lib/mcp/protocol-era', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp/protocol-era')>();
  return { ...actual, probeProtocolEra: mocks.probeProtocolEra };
});

const { __resetProtocolEraCache, forgetEra, loadEra, rememberEra, resolveEra } = await import(
  '@/lib/mcp/protocol-era-store'
);

const URL_ = 'https://mcp.exa.ai/mcp';
const ORIGIN = 'https://mcp.exa.ai';

beforeEach(() => {
  __resetProtocolEraCache();
  vi.clearAllMocks();
  mocks.getMcpProtocolEras.mockResolvedValue({});
  mocks.setMcpProtocolEras.mockResolvedValue(undefined);
});

afterEach(() => {
  __resetProtocolEraCache();
});

describe('protocol era store', () => {
  it('probes once per origin and persists the verdict', async () => {
    mocks.probeProtocolEra.mockResolvedValue('legacy');

    await expect(resolveEra(URL_)).resolves.toBe('legacy');
    expect(mocks.probeProtocolEra).toHaveBeenCalledTimes(1);
    expect(mocks.setMcpProtocolEras).toHaveBeenCalledWith({
      [ORIGIN]: expect.objectContaining({ era: 'legacy' }),
    });

    // Second resolve in the same process comes from the cache.
    await expect(resolveEra(URL_)).resolves.toBe('legacy');
    expect(mocks.probeProtocolEra).toHaveBeenCalledTimes(1);
  });

  it('does not cache an inconclusive probe', async () => {
    mocks.probeProtocolEra.mockResolvedValue('unknown');

    await expect(resolveEra(URL_)).resolves.toBeUndefined();
    expect(mocks.setMcpProtocolEras).not.toHaveBeenCalled();
  });

  it('picks up a verdict another context persisted', async () => {
    // A fresh process: nothing in memory, but the options page already learned
    // this origin and wrote it through.
    mocks.getMcpProtocolEras.mockResolvedValue({ [ORIGIN]: { era: 'legacy', updatedAt: 1 } });

    await expect(loadEra(URL_)).resolves.toBe('legacy');
    expect(mocks.probeProtocolEra).not.toHaveBeenCalled();
  });

  it('adopts a newer verdict from another context and loses nothing on write', async () => {
    await rememberEra(URL_, 'legacy');

    // Meanwhile another context upgraded the verdict and learned an unrelated
    // origin. A plain snapshot write would drop both.
    mocks.getMcpProtocolEras.mockResolvedValue({
      [ORIGIN]: { era: 'modern', updatedAt: Date.now() + 60_000 },
      'https://other.test': { era: 'legacy', updatedAt: 5 },
    });

    await rememberEra('https://second.test/mcp', 'modern');

    await expect(loadEra(URL_)).resolves.toBe('modern');
    expect(mocks.setMcpProtocolEras).toHaveBeenLastCalledWith(
      expect.objectContaining({
        'https://other.test': expect.objectContaining({ era: 'legacy' }),
        'https://second.test': expect.objectContaining({ era: 'modern' }),
      }),
    );
  });

  it('forgets a verdict so the next resolve probes again', async () => {
    mocks.probeProtocolEra.mockResolvedValue('legacy');
    await resolveEra(URL_);

    await forgetEra(URL_);
    expect(mocks.setMcpProtocolEras).toHaveBeenLastCalledWith({});
    await expect(loadEra(URL_)).resolves.toBeUndefined();
  });

  it('keeps working in memory when storage is unavailable', async () => {
    mocks.getMcpProtocolEras.mockRejectedValue(new Error('chrome is not defined'));
    mocks.setMcpProtocolEras.mockRejectedValue(new Error('chrome is not defined'));

    await rememberEra(URL_, 'modern');
    await expect(loadEra(URL_)).resolves.toBe('modern');
  });
});
