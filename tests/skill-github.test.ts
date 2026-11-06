/**
 * GitHub import: URL parsing and the archive download.
 *
 * The parser is table-driven because users paste six different shapes of the same
 * reference, and the two ambiguous ones (branch names containing `/`) decide
 * whether a repository imports at all.
 *
 * The download is exercised against a stubbed `fetch` so the interesting parts are
 * reachable without a network: chunk-by-chunk progress, the full read of a stream
 * larger than the old 32 MB ceiling, and the 404 fallback across ref candidates.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadGitHubZip, parseGitHubUrl } from '@/lib/skills/import/github';

describe('parseGitHubUrl', () => {
  it.each([
    ['https://github.com/vercel/ai', 'vercel', 'ai', []],
    ['https://github.com/vercel/ai/', 'vercel', 'ai', []],
    ['github.com/vercel/ai', 'vercel', 'ai', []],
    ['vercel/ai', 'vercel', 'ai', []],
    ['https://github.com/vercel/ai.git', 'vercel', 'ai', []],
    ['vercel/ai@canary', 'vercel', 'ai', ['canary']],
    ['https://github.com/anthropics/skills/tree/main', 'anthropics', 'skills', ['main']],
  ])('parses %s', (input, owner, repo, refs) => {
    expect(parseGitHubUrl(input as string)).toEqual({ owner, repo, refs });
  });

  it('tries every split of an ambiguous branch path, longest first', () => {
    // `feature/foo` and `feature` are both legal branch names.
    expect(parseGitHubUrl('https://github.com/o/r/tree/feature/foo')?.refs).toEqual([
      'feature/foo',
      'feature',
    ]);
  });

  it('accepts a link to a file inside the repository', () => {
    // Pasting the SKILL.md you were looking at is the most natural thing to do;
    // the trailing path is ignored because the archive is the whole repository.
    expect(
      parseGitHubUrl('https://github.com/o/r/blob/main/skills/x/SKILL.md')?.refs,
    ).toEqual(['main/skills/x/SKILL.md', 'main/skills/x', 'main/skills', 'main']);
  });

  it.each([
    ['https://gitlab.com/o/r'],
    ['https://github.com/onlyowner'],
    ['https://github.com/o/r/issues'],
    ['not a repo'],
    [''],
  ])('rejects %s', (input) => {
    expect(parseGitHubUrl(input)).toBeNull();
  });
});

/** A `Response` whose body arrives as the given chunks. */
function streamResponse(chunks: Uint8Array[], status = 200): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
  });
  return new Response(body, { status });
}

function bytes(length: number, fill = 0x50): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('downloadGitHubZip', () => {
  it('reports progress per chunk and labels the archive with the ref', async () => {
    const progress: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamResponse([bytes(10), bytes(5), bytes(3)])),
    );

    const result = await downloadGitHubZip('https://github.com/o/r/tree/main', {
      onProgress: (update) => progress.push(update.receivedBytes),
    });

    expect(result).toMatchObject({ ok: true, label: 'o/r@main' });
    // GitHub streams without a content length, so only bytes can be reported.
    expect(progress).toEqual([10, 15, 18]);
    if (!result.ok) throw new Error('expected success');
    expect(result.blob.type).toBe('application/zip');
    expect(result.blob.size).toBe(18);
  });

  it('requests the default branch without touching the API', async () => {
    const fetchMock = vi.fn(async () => streamResponse([bytes(4)]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await downloadGitHubZip('https://github.com/o/r');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://codeload.github.com/o/r/zip/HEAD',
      expect.objectContaining({ redirect: 'follow' }),
    );
    expect(result).toMatchObject({ ok: true, label: 'o/r' });
  });

  it('falls back to the shorter ref when the longer one does not exist', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requested.push(url);
        return url.endsWith('/zip/feature/foo') ? streamResponse([], 404) : streamResponse([bytes(6)]);
      }),
    );

    const result = await downloadGitHubZip('https://github.com/o/r/tree/feature/foo');

    expect(requested).toEqual([
      'https://codeload.github.com/o/r/zip/feature/foo',
      'https://codeload.github.com/o/r/zip/feature',
    ]);
    expect(result).toMatchObject({ ok: true, label: 'o/r@feature' });
  });

  it('reports a missing repository once every candidate failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([], 404)));

    expect(await downloadGitHubZip('https://github.com/o/missing')).toEqual({
      ok: false,
      reason: 'not-found',
      status: 404,
    });
  });

  it('rejects an unparseable address without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await downloadGitHubZip('https://gitlab.com/o/r')).toEqual({
      ok: false,
      reason: 'invalid-url',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads a stream past the old 32 MB ceiling instead of aborting it', async () => {
    // The archive used to be capped while it was being read, which refused a
    // large repository outright. Size is now the unpacking step's business, so the
    // download simply reports every byte it receives.
    const chunk = bytes(17 * 1024 * 1024);
    const progress: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([chunk, chunk])));

    const result = await downloadGitHubZip('https://github.com/o/r', {
      onProgress: (update) => progress.push(update.receivedBytes),
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('expected success');
    expect(result.blob.size).toBe(34 * 1024 * 1024);
    expect(progress.at(-1)).toBe(34 * 1024 * 1024);
  });

  it('does not start when the caller already cancelled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    controller.abort();

    expect(
      await downloadGitHubZip('https://github.com/o/r', { signal: controller.signal }),
    ).toEqual({ ok: false, reason: 'aborted' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a network failure separately from a missing repository', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    expect(await downloadGitHubZip('https://github.com/o/r')).toEqual({
      ok: false,
      reason: 'network',
    });
  });
});
