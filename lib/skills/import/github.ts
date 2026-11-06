/**
 * Importing skills from a GitHub repository.
 *
 * GitHub serves a whole repository as a zip at
 * `codeload.github.com/<owner>/<repo>/zip/<ref>`, and that archive has the shape
 * this project already imports: a single `repo-ref/` root with `skills/x/SKILL.md`
 * nested somewhere underneath. So a repository is not a new kind of package — it
 * is a zip the user did not have to download by hand, and everything after the
 * bytes (`unpackZipArchive` → `discoverSkills` → review → install) is shared with
 * the upload path.
 *
 * `zip/HEAD` resolves the default branch server-side. That matters: it costs no
 * API request, so importing is not subject to the 60-requests-per-hour
 * unauthenticated API limit, and asking for a branch that does not exist is a 404
 * rather than a rate-limit error.
 *
 * Two properties of that endpoint shape the code here:
 *
 * - **No `Content-Length`.** GitHub streams the archive chunked, so progress can
 *   only be "received so far", never a percentage. Reporting bytes is honest;
 *   inventing a denominator would not be.
 * - **`zip/<ref>` streams while it builds.** The response is not seekable and
 *   cannot be replayed, so the bytes are accumulated as they arrive, reported
 *   through `onProgress`, and cancellable through `signal`. No size ceiling is
 *   imposed here: a repository that is large is still a repository the user asked
 *   for, and the unpack step bounds the expansion instead.
 */
import { strFromU8 } from 'fflate';
import { MAX_EXPANDED_BYTES, MAX_PACKAGE_FILES, isIgnoredPackagePath } from './archive';
import { discoverSkills } from './discover';
import type { DiscoveredSkill } from './discover';
import { inspectSkillPackages } from './inspect';
import type { SkillCandidate, SkillInspection } from './inspect';
import { zipPackageSource } from './sources';
import { isSkillDirectoryOccupied, planSkillPackage } from './install';
import type { SkillPlan } from './install';
import { SKILL_FILE_NAME } from '../constants';
import type { PackageFile } from './types';

export interface GitHubRepoRef {
  owner: string;
  repo: string;
  /**
   * Refs to try, most specific first.
   *
   * A URL like `/tree/feature/foo` is genuinely ambiguous — `feature/foo` and
   * `feature` are both valid branch names — and the URL alone cannot say which
   * one the user meant. Rather than guessing once, the candidates are tried in
   * order and a 404 moves to the next. Empty means "the default branch".
   */
  refs: string[];
}

export interface GitHubDownloadProgress {
  receivedBytes: number;
  /** Always `null` for GitHub: the archive is streamed without a length. */
  totalBytes: number | null;
}

export type GitHubDownloadResult =
  | { ok: true; blob: Blob; label: string }
  | {
      ok: false;
      reason: 'invalid-url' | 'not-found' | 'network' | 'aborted';
      /** HTTP status, when the failure came from the server. */
      status?: number;
    };

export interface GitHubDownloadOptions {
  onProgress?: (progress: GitHubDownloadProgress) => void;
  signal?: AbortSignal;
}

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Ref candidates from the path segments after `tree/` or `blob/`.
 *
 * Longest first, so `/tree/main/skills` still resolves when `main` is the branch:
 * `main/skills` 404s, `main` succeeds. A name that happens to be both is
 * unresolvable from the URL alone, and the longest match is the better guess.
 */
function refCandidates(segments: string[]): string[] {
  const candidates: string[] = [];
  for (let length = segments.length; length >= 1; length -= 1) {
    candidates.push(segments.slice(0, length).join('/'));
  }
  return candidates;
}

/**
 * Parse a repository reference from what a user would paste.
 *
 * Accepted: `https://github.com/o/r`, `github.com/o/r`, `o/r`, an `@ref` suffix,
 * a `.git` suffix, and `/tree/<ref>/…` or `/blob/<ref>/…` URLs (the trailing path
 * is ignored — the archive is the whole repository either way).
 */
export function parseGitHubUrl(raw: string): GitHubRepoRef | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;

  // `owner/repo` and `owner/repo@ref`, before URL parsing: a bare two-segment path
  // is not a URL, and users paste it constantly.
  const shorthand = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:@(.+))?$/.exec(
    trimmed.replace(/\.git$/, ''),
  );
  if (shorthand && !trimmed.includes('://') && !trimmed.includes('/tree/')) {
    const [, owner, repo, ref] = shorthand;
    if (!isUsableName(owner) || !isUsableName(repo)) return null;
    return { owner: owner!, repo: repo!, refs: ref ? [ref] : [] };
  }

  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/, '');
  if (!isUsableName(owner) || !isUsableName(repo)) return null;

  const rest = segments.slice(2);
  const kind = rest[0];
  if (kind === 'tree' || kind === 'blob') {
    const refSegments = rest.slice(1);
    return { owner, repo, refs: refSegments.length > 0 ? refCandidates(refSegments) : [] };
  }

  // Any other path (`/issues`, `/pulls`, …) is not a repository reference.
  if (rest.length > 0) return null;
  return { owner, repo, refs: [] };
}

function isUsableName(value: string | undefined): boolean {
  return typeof value === 'string' && value !== '' && value !== '.' && value !== '..' && NAME_PATTERN.test(value);
}

function zipUrl(ref: GitHubRepoRef, candidate: string): string {
  const encoded = candidate.split('/').map(encodeURIComponent).join('/');
  return `https://codeload.github.com/${ref.owner}/${ref.repo}/zip/${encoded}`;
}

/**
 * Download a repository archive, reporting progress as it arrives.
 *
 * The archive is held in memory until it is unpacked, which is what a browser
 * download is; the ceiling that matters lives in `unpackZipArchive`, where the
 * declared expansion is known before anything is inflated. Cancellation is
 * cooperative through `signal`, which also aborts the in-flight `fetch`.
 */
export async function downloadGitHubZip(
  input: string,
  options: GitHubDownloadOptions = {},
): Promise<GitHubDownloadResult> {
  const parsed = parseGitHubUrl(input);
  if (!parsed) return { ok: false, reason: 'invalid-url' };

  const candidates = parsed.refs.length > 0 ? parsed.refs : ['HEAD'];
  const { signal } = options;

  for (const [index, ref] of candidates.entries()) {
    if (signal?.aborted) return { ok: false, reason: 'aborted' };

    let response: Response;
    try {
      response = await fetch(zipUrl(parsed, ref), { signal, redirect: 'follow' });
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return { ok: false, reason: 'aborted' };
      }
      return { ok: false, reason: 'network' };
    }

    if (response.status === 404) {
      // A longer ref candidate failed; the next one may be the branch the user
      // meant. Only the last candidate decides that the repository is missing.
      if (index < candidates.length - 1) continue;
      return { ok: false, reason: 'not-found', status: 404 };
    }
    if (!response.ok) {
      return { ok: false, reason: 'network', status: response.status };
    }

    const read = await readArchive(response, options);
    if (!read.ok) return read;

    return {
      ok: true,
      blob: new Blob([read.bytes as unknown as BlobPart], { type: 'application/zip' }),
      // `HEAD` is not a name the user typed, so the label stays the repository.
      label: ref === 'HEAD' ? `${parsed.owner}/${parsed.repo}` : `${parsed.owner}/${parsed.repo}@${ref}`,
    };
  }

  return { ok: false, reason: 'not-found' };
}

type ArchiveRead =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'network' | 'aborted' };

/** Read the response body, reporting progress as it arrives. */
async function readArchive(
  response: Response,
  options: GitHubDownloadOptions,
): Promise<ArchiveRead> {
  const { onProgress, signal } = options;

  if (!response.body) {
    try {
      const buffer = new Uint8Array(await response.arrayBuffer());
      onProgress?.({ receivedBytes: buffer.byteLength, totalBytes: null });
      return { ok: true, bytes: buffer };
    } catch {
      return { ok: false, reason: signal?.aborted ? 'aborted' : 'network' };
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      received += value.byteLength;
      chunks.push(value);
      onProgress?.({ receivedBytes: received, totalBytes: null });
    }
  } catch {
    return { ok: false, reason: signal?.aborted ? 'aborted' : 'network' };
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

// ─── Listing a repository (tree + raw) ───────────────────────────────────────

const API_ROOT = 'https://api.github.com';
const RAW_ROOT = 'https://raw.githubusercontent.com';
const CDN_ROOT = 'https://cdn.jsdelivr.net/gh';

/** Which transport a repository import is currently using. */
export type GitHubPhase = 'scan' | 'manifests' | 'archive';

/**
 * Why a repository could not be read.
 *
 * `network` and `rate-limited` are separate because they call for different
 * words: one is "GitHub is unreachable", the other is "wait a few minutes".
 */
export type GitHubFailureReason =
  | 'invalid-url'
  | 'not-found'
  | 'rate-limited'
  | 'too-large'
  | 'network'
  | 'aborted';

export type GitHubInspectionResult =
  | { ok: true; mode: 'tree' | 'zip'; inspection: SkillInspection }
  | { ok: false; reason: GitHubFailureReason; status?: number };

export interface GitHubInspectionOptions {
  /** Which step is running, so the dialog can say what it is waiting for. */
  onPhase?: (phase: GitHubPhase) => void;
  /** Bytes received while falling back to the archive. */
  onProgress?: (progress: GitHubDownloadProgress) => void;
  signal?: AbortSignal;
}

/** One skill a repository lists, described before its bytes are fetched. */
export interface GitHubSkillEntry {
  /** Repository-relative directory, with a trailing slash. */
  dir: string;
  manifestPath: string;
  /** `null` when the manifest itself could not be downloaded. */
  manifestText: string | null;
  /** Repository-relative paths with their sizes from the tree. */
  files: Array<{ path: string; size: number }>;
}

interface TreeNode {
  path: string;
  type: string;
  size?: number;
}

type TreeAttempt =
  | { ok: true; sha: string; nodes: TreeNode[] }
  | { ok: false; kind: 'missing' | 'rate-limited' | 'truncated' | 'network' };

const EMPTY_BYTES = new Uint8Array(0);

/**
 * One request for the whole tree of a ref.
 *
 * `recursive=1` returns every path in the repository at once, which is why a
 * scan costs a single API call. GitHub caps that response (100k entries / 7 MB)
 * and reports `truncated` rather than failing; a truncated tree cannot be used to
 * claim "this repository has no skills", so it is treated as a failed scan.
 */
async function fetchTree(
  ref: GitHubRepoRef,
  revision: string,
  signal: AbortSignal | undefined,
): Promise<TreeAttempt> {
  let response: Response;
  try {
    response = await fetch(
      `${API_ROOT}/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(revision)}?recursive=1`,
      { signal, headers: { Accept: 'application/vnd.github+json' } },
    );
  } catch {
    return { ok: false, kind: signal?.aborted ? 'missing' : 'network' };
  }

  if (response.status === 404) return { ok: false, kind: 'missing' };
  // 403 is what an exhausted unauthenticated quota looks like (`429` for
  // secondary limits); neither is worth retrying immediately.
  if (response.status === 403 || response.status === 429) {
    return { ok: false, kind: 'rate-limited' };
  }
  if (!response.ok) return { ok: false, kind: 'network' };

  const body = (await response.json().catch(() => null)) as
    | { sha?: string; tree?: TreeNode[]; truncated?: boolean }
    | null;
  if (!body?.tree) return { ok: false, kind: 'network' };
  if (body.truncated) return { ok: false, kind: 'truncated' };
  return { ok: true, sha: body.sha ?? revision, nodes: body.tree };
}

/**
 * Download one repository file.
 *
 * `raw.githubusercontent.com` is the canonical path; jsDelivr serves the same
 * bytes from a CDN and is used when raw is unreachable, which is a real failure
 * mode rather than a hypothetical one. The revision is the tree's commit sha
 * when one is known, so every file of an import comes from the same snapshot.
 */
async function fetchRepositoryFile(
  ref: GitHubRepoRef,
  revision: string,
  path: string,
  signal: AbortSignal | undefined,
): Promise<Uint8Array | null> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const candidates = [
    `${RAW_ROOT}/${ref.owner}/${ref.repo}/${revision}/${encodedPath}`,
    `${CDN_ROOT}/${ref.owner}/${ref.repo}@${revision}/${encodedPath}`,
  ];

  for (const url of candidates) {
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) continue;
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      if (signal?.aborted) return null;
    }
  }
  return null;
}

/**
 * List the skills in a repository without downloading it.
 *
 * Costs one API request for the tree plus one small request per manifest: the
 * review needs a description to be reviewable, and downloading the whole
 * repository to find one skill is what this path exists to avoid.
 */
export async function scanGitHubSkills(
  input: string,
  options: GitHubInspectionOptions = {},
): Promise<GitHubInspectionResult> {
  const parsed = parseGitHubUrl(input);
  if (!parsed) return { ok: false, reason: 'invalid-url' };
  if (options.signal?.aborted) return { ok: false, reason: 'aborted' };

  options.onPhase?.('scan');

  // `HEAD` is not passed to the content endpoints — the tree's own sha is — so the
  // default branch needs no separate metadata request.
  const revisions = parsed.refs.length > 0 ? parsed.refs : ['HEAD'];
  let tree: { sha: string; nodes: TreeNode[] } | null = null;
  for (const revision of revisions) {
    if (options.signal?.aborted) return { ok: false, reason: 'aborted' };
    const attempt = await fetchTree(parsed, revision, options.signal);
    if (attempt.ok) {
      tree = attempt;
      break;
    }
    if (attempt.kind === 'missing') continue;
    // A truncated tree (100k entries / 7 MB) cannot be used to claim the
    // repository has no skills, so the archive is tried instead.
    if (attempt.kind === 'truncated') return { ok: false, reason: 'too-large' };
    return { ok: false, reason: attempt.kind === 'rate-limited' ? 'rate-limited' : 'network' };
  }
  if (!tree) return { ok: false, reason: 'not-found', status: 404 };

  const blobs = tree.nodes
    .filter((node) => node.type === 'blob' && !isIgnoredPackagePath(node.path))
    .map((node) => ({ path: node.path, size: node.size ?? 0 }));
  // The tree is turned into a package of empty files so discovery, root detection
  // and nested-skill handling are the ones every other source uses.
  const discovered = discoverSkills(blobs.map((blob) => ({ path: blob.path, data: EMPTY_BYTES })));
  if (discovered.length === 0) {
    return {
      ok: true,
      mode: 'tree',
      inspection: {
        candidates: [],
        empty: true,
        diagnostics: [
          {
            level: 'warning',
            code: 'no-manifest',
            message: `"${parsed.owner}/${parsed.repo}" contains no SKILL.md`,
            path: `${parsed.owner}/${parsed.repo}`,
          },
        ],
      },
    };
  }

  options.onPhase?.('manifests');
  const sizes = new Map(blobs.map((blob) => [blob.path, blob.size]));
  const candidates: SkillCandidate[] = [];
  let readable = 0;

  for (const entry of discovered) {
    const manifestBytes = await fetchRepositoryFile(
      parsed,
      tree.sha,
      entry.manifestPath,
      options.signal,
    );
    const manifestText = manifestBytes ? strFromU8(manifestBytes) : null;
    if (manifestText !== null) readable += 1;

    const files = entry.files.map((file) => ({
      path: file.path,
      size: sizes.get(`${entry.root}${file.path}`) ?? 0,
    }));
    const size = files.reduce((sum, file) => sum + file.size, 0);

    // A manifest that could not be downloaded is still listed: the user should see
    // that the repository contains it, and why it cannot be installed.
    const plan: SkillPlan = manifestText
      ? planSkillPackage({ ...entry, manifestText })
      : {
          pkg: null,
          diagnostics: [
            {
              level: 'error',
              code: 'manifest-unreadable',
              message: `${entry.manifestPath} could not be downloaded`,
              path: entry.manifestPath,
            },
          ],
        };

    candidates.push({
      id: `${parsed.owner}/${parsed.repo}::${entry.manifestPath}`,
      sourceLabel: parsed.refs.length > 0 ? `${parsed.owner}/${parsed.repo}@${parsed.refs[0]}` : `${parsed.owner}/${parsed.repo}`,
      discovered: entry,
      plan,
      files: [],
      fileCount: files.length,
      size,
      installed: plan.pkg ? await isSkillDirectoryOccupied(plan.pkg.skill.dir) : false,
      loadFiles: () =>
        loadSkillFiles(parsed, tree.sha, entry, manifestBytes, sizes, options.signal),
    });
  }

  // Every manifest failed: the content endpoints are effectively down, so this is
  // a transport failure rather than a repository without skills.
  if (readable === 0) return { ok: false, reason: 'network' };

  return { ok: true, mode: 'tree', inspection: { candidates, empty: false, diagnostics: [] } };
}

/** Fetch everything a discovered skill ships, reusing the manifest already read. */
async function loadSkillFiles(
  ref: GitHubRepoRef,
  revision: string,
  entry: DiscoveredSkill,
  manifestBytes: Uint8Array | null,
  sizes: Map<string, number>,
  signal: AbortSignal | undefined,
): Promise<PackageFile[]> {
  if (entry.files.length > MAX_PACKAGE_FILES) {
    throw new Error(`skill holds more than ${MAX_PACKAGE_FILES} files`);
  }

  const files: PackageFile[] = [];
  let declared = 0;

  for (const file of entry.files) {
    // The tree already states every blob's size, so the budget is decided before
    // the bytes are downloaded: a package that cannot fit fails as a message
    // rather than as a tab that ran out of memory mid-fetch.
    declared += sizes.get(`${entry.root}${file.path}`) ?? 0;
    if (declared > MAX_EXPANDED_BYTES) {
      throw new Error(`skill expands beyond ${MAX_EXPANDED_BYTES} bytes`);
    }

    const data =
      file.path === SKILL_FILE_NAME && manifestBytes
        ? manifestBytes
        : await fetchRepositoryFile(ref, revision, `${entry.root}${file.path}`, signal);
    if (data === null) throw new Error(`${entry.root}${file.path} could not be downloaded`);

    files.push({ path: file.path, data });
  }

  return files;
}

/**
 * Import from GitHub: list the repository first, fall back to its archive.
 *
 * The listing is the default because it is one request and downloads only the
 * skills that are chosen. It also depends on endpoints that can be blocked, rate
 * limited or truncated, so any failure there falls through to downloading the
 * whole archive — a bigger transfer that needs no API access at all. Only when
 * both paths fail is the user told so.
 *
 * Both paths end in the same `SkillInspection`, so the review screen and the
 * installer never learn which one produced the bytes.
 */
export async function inspectGitHubImport(
  input: string,
  options: GitHubInspectionOptions = {},
): Promise<GitHubInspectionResult> {
  const parsed = parseGitHubUrl(input);
  if (!parsed) return { ok: false, reason: 'invalid-url' };
  if (options.signal?.aborted) return { ok: false, reason: 'aborted' };

  const scanned = await scanGitHubSkills(input, options);

  // A repository with no SKILL.md is a real answer, not a failure: the archive
  // holds the same paths by definition, so downloading it to confirm would cost
  // the user megabytes for the same nothing.
  if (scanned.ok) return scanned;
  if (scanned.reason === 'aborted') return scanned;

  return inspectGitHubArchive(input, options, scanned.ok ? undefined : scanned.reason);
}

/** Last resort: the repository archive, read through the zip import path. */
async function inspectGitHubArchive(
  input: string,
  options: GitHubInspectionOptions,
  treeFailure?: GitHubFailureReason,
): Promise<GitHubInspectionResult> {
  options.onPhase?.('archive');
  const downloaded = await downloadGitHubZip(input, {
    signal: options.signal,
    onProgress: options.onProgress,
  });

  if (!downloaded.ok) {
    // The reason the tree path already knew is more specific than a generic
    // network failure (`rate-limited` vs `network`), so it wins when both failed.
    return { ok: false, reason: treeFailure ?? downloaded.reason, status: downloaded.status };
  }

  const inspection = await inspectSkillPackages([zipPackageSource(downloaded.blob, downloaded.label)]);
  return { ok: true, mode: 'zip', inspection };
}
