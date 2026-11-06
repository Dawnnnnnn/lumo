/**
 * Reading a repository without downloading it, and falling back when that path
 * is unavailable.
 *
 * The listing path is the default because it costs one API request and transfers
 * only the chosen skills. It also depends on endpoints that can be blocked, rate
 * limited or truncated, so every failure there has to end in the archive rather
 * than in an error — only both paths failing is a failure.
 *
 * `fetch` is stubbed so each of those branches is reachable without a network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { inspectGitHubImport } from '@/lib/skills/import';

const state = vi.hoisted(() => ({ occupied: [] as string[] }));

vi.mock('@/lib/mcp/file-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp/file-storage')>();
  return {
    ...actual,
    fileStorage: {
      listByPrefix: async (dir: string) =>
        state.occupied
          .filter((name) => name.startsWith(dir))
          .map((name) => ({ name, mimeType: 'text/markdown', size: 1, createdAt: 1, updatedAt: 1 })),
    },
  };
});

const MANIFEST = (name: string) => `---\nname: ${name}\ndescription: ${name} does things.\n---\n`;

interface TreeOptions {
  truncated?: boolean;
  skills?: string[];
  /** Size one skill's resource declares in the tree, in bytes. */
  resourceSize?: number;
}

/** A tree response listing one skill directory per name, plus one resource each. */
function treeBody({ truncated = false, skills = ['a'], resourceSize = 10 }: TreeOptions = {}) {
  const tree: Array<{ path: string; type: string; size: number }> = [];
  for (const skill of skills) {
    tree.push({ path: `skills/${skill}/SKILL.md`, type: 'blob', size: 20 });
    tree.push({ path: `skills/${skill}/references/x.md`, type: 'blob', size: resourceSize });
  }
  return { sha: 'tree-sha', tree, truncated };
}

/** A binary response body; `Uint8Array` is not a `BodyInit` under this lib config. */
function binaryResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(new Blob([bytes as unknown as BlobPart]), { status });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function zipArchive(skills = ['a']): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const skill of skills) {
    entries[`repo-HEAD/skills/${skill}/SKILL.md`] = strToU8(MANIFEST(skill));
    entries[`repo-HEAD/skills/${skill}/references/x.md`] = strToU8('reference');
  }
  return zipSync(entries);
}

beforeEach(() => {
  state.occupied = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('inspectGitHubImport — listing a repository', () => {
  it('reads the tree once and only the manifests', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requested.push(url);
        if (url.startsWith('https://api.github.com/')) return jsonResponse(treeBody());
        return binaryResponse(strToU8(MANIFEST('a')));
      }),
    );

    const result = await inspectGitHubImport('https://github.com/o/r');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe('tree');
    expect(result.inspection.candidates).toHaveLength(1);
    const [candidate] = result.inspection.candidates;
    expect(candidate!.plan.pkg).toMatchObject({ installName: 'a' });
    expect(candidate!.plan.pkg!.skill.description).toBe('a does things.');
    // Sizes come from the tree, so the review can show them before downloading.
    expect(candidate!.fileCount).toBe(2);
    expect(candidate!.size).toBe(30);

    // One tree request, one manifest request — the resource was not downloaded.
    expect(requested.filter((url) => url.startsWith('https://api.github.com/'))).toHaveLength(1);
    expect(requested).toContain('https://raw.githubusercontent.com/o/r/tree-sha/skills/a/SKILL.md');
    expect(requested.some((url) => url.endsWith('references/x.md'))).toBe(false);
  });

  it('pins content to the tree sha, so every file comes from one snapshot', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requested.push(url);
        if (url.startsWith('https://api.github.com/')) return jsonResponse(treeBody());
        return binaryResponse(strToU8(MANIFEST('a')));
      }),
    );

    await inspectGitHubImport('https://github.com/o/r');

    // `HEAD` never reaches the content endpoints: the resolved sha does.
    expect(requested.some((url) => url.includes('/HEAD/'))).toBe(false);
    expect(requested.some((url) => url.includes('/tree-sha/'))).toBe(true);
  });

  it('falls back to the CDN when raw is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('https://api.github.com/')) return jsonResponse(treeBody());
        if (url.startsWith('https://raw.githubusercontent.com/')) {
          throw new TypeError('Failed to fetch');
        }
        return binaryResponse(strToU8(MANIFEST('a')));
      }),
    );

    const result = await inspectGitHubImport('https://github.com/o/r');
    expect(result.ok && result.inspection.candidates[0]!.plan.pkg).toBeTruthy();
  });

  it('lists a manifest it could not download instead of hiding the skill', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('https://api.github.com/')) {
          return jsonResponse(treeBody({ skills: ['ok', 'broken'] }));
        }
        if (url.endsWith('skills/broken/SKILL.md')) return new Response('', { status: 500 });
        return new Response(strToU8(MANIFEST('ok')));
      }),
    );

    const result = await inspectGitHubImport('https://github.com/o/r');
    if (!result.ok) throw new Error('expected a tree result');

    const byRoot = new Map(result.inspection.candidates.map((c) => [c.discovered.root, c]));
    expect(byRoot.get('skills/ok/')!.plan.pkg).toBeTruthy();
    expect(byRoot.get('skills/broken/')!.plan.pkg).toBeNull();
    expect(byRoot.get('skills/broken/')!.plan.diagnostics).toEqual([
      expect.objectContaining({ code: 'manifest-unreadable', level: 'error' }),
    ]);
  });

  it('reports an installed skill so the review can default it to unchecked', async () => {
    state.occupied = ['skills/a/SKILL.md'];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.startsWith('https://api.github.com/')
          ? jsonResponse(treeBody())
          : binaryResponse(strToU8(MANIFEST('a'))),
      ),
    );

    const result = await inspectGitHubImport('https://github.com/o/r');
    expect(result.ok && result.inspection.candidates[0]!.installed).toBe(true);
  });

  it('answers "no skills here" without downloading the archive', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requested.push(url);
        return jsonResponse({ sha: 'tree-sha', tree: [{ path: 'README.md', type: 'blob', size: 5 }] });
      }),
    );

    const result = await inspectGitHubImport('https://github.com/o/r');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe('tree');
    expect(result.inspection.candidates).toEqual([]);
    expect(result.inspection.empty).toBe(true);
    expect(requested.some((url) => url.includes('codeload'))).toBe(false);
  });
});

describe('inspectGitHubImport — falling back to the archive', () => {
  it.each([
    ['rate limited', () => jsonResponse({ message: 'API rate limit exceeded' }, 403)],
    [
      'unreachable',
      () => {
        throw new TypeError('Failed to fetch');
      },
    ],
    ['truncated', () => jsonResponse({ sha: 'tree-sha', tree: [], truncated: true })],
  ])('downloads the archive when the listing is %s', async (_label, treeResponse) => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requested.push(url);
        if (url.startsWith('https://api.github.com/')) return treeResponse();
        if (url.startsWith('https://codeload.github.com/')) return binaryResponse(zipArchive());
        return new Response('', { status: 404 });
      }),
    );

    const result = await inspectGitHubImport('https://github.com/o/r');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe('zip');
    expect(result.inspection.candidates.map((c) => c.plan.pkg?.installName)).toEqual(['a']);
    expect(requested.some((url) => url.startsWith('https://codeload.github.com/'))).toBe(true);
  });

  it('falls back when the tree exists but no manifest can be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('https://api.github.com/')) return jsonResponse(treeBody());
        if (url.startsWith('https://codeload.github.com/')) return binaryResponse(zipArchive());
        return new Response('', { status: 502 });
      }),
    );

    const result = await inspectGitHubImport('https://github.com/o/r');
    expect(result.ok && result.mode).toBe('zip');
  });

  it('fails only when both paths failed, and keeps the more specific reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('https://api.github.com/')) {
          return jsonResponse({ message: 'API rate limit exceeded' }, 403);
        }
        return new Response('', { status: 404 });
      }),
    );

    expect(await inspectGitHubImport('https://github.com/o/r')).toMatchObject({
      ok: false,
      reason: 'rate-limited',
    });
  });

  it('does not try the archive for an address that is not a repository', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await inspectGitHubImport('https://gitlab.com/o/r')).toEqual({
      ok: false,
      reason: 'invalid-url',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('candidate file loading', () => {
  it('downloads the resources of one skill, reusing the manifest', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requested.push(url);
        if (url.startsWith('https://api.github.com/')) return jsonResponse(treeBody());
        if (url.endsWith('references/x.md')) return binaryResponse(strToU8('reference'));
        return binaryResponse(strToU8(MANIFEST('a')));
      }),
    );

    const result = await inspectGitHubImport('https://github.com/o/r');
    if (!result.ok) throw new Error('expected a tree result');
    const candidate = result.inspection.candidates[0]!;

    const files = await candidate.loadFiles!();
    expect(files.map((file) => file.path)).toEqual(['SKILL.md', 'references/x.md']);
    expect(new TextDecoder().decode(files[0]!.data)).toContain('name: a');
    // Only the resource was fetched a second time.
    expect(requested.filter((url) => url.endsWith('/references/x.md'))).toHaveLength(1);
  });

  it('refuses an oversized skill before downloading its resources', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requested.push(url);
        if (url.startsWith('https://api.github.com/')) {
          // Two gigabytes, as the tree declares them — the blob itself never is.
          return jsonResponse(treeBody({ resourceSize: 2 * 1024 * 1024 * 1024 }));
        }
        return binaryResponse(strToU8(MANIFEST('a')));
      }),
    );

    const result = await inspectGitHubImport('https://github.com/o/r');
    if (!result.ok) throw new Error('expected a tree result');

    await expect(result.inspection.candidates[0]!.loadFiles!()).rejects.toThrow('expands beyond');
    // The budget is spent from the tree's own sizes, so the resource is never
    // fetched: failing fast is the whole point of reading the manifest listing.
    expect(requested.some((url) => url.endsWith('/references/x.md'))).toBe(false);
  });

  it('fails loudly when a resource cannot be downloaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('https://api.github.com/')) return jsonResponse(treeBody());
        if (url.endsWith('references/x.md')) return new Response('', { status: 404 });
        return binaryResponse(strToU8(MANIFEST('a')));
      }),
    );

    const result = await inspectGitHubImport('https://github.com/o/r');
    if (!result.ok) throw new Error('expected a tree result');

    await expect(result.inspection.candidates[0]!.loadFiles!()).rejects.toThrow(
      'skills/a/references/x.md could not be downloaded',
    );
  });
});
