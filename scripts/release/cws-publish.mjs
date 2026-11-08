#!/usr/bin/env node
/**
 * Chrome Web Store v2 发布脚本。
 *
 * 把 OAuth 换 token、resumable upload、轮询上传状态、提交审核、回读状态
 * 全部收在一个 Node 脚本里，workflow 只负责构建和传 secrets。
 * 本地也可以跑 `--mode check` / `--mode status` 自检，不消耗发布次数。
 *
 * 用法：
 *   node scripts/release/cws-publish.mjs --mode check
 *   node scripts/release/cws-publish.mjs --mode status
 *   node scripts/release/cws-publish.mjs --mode upload --expected-version v1.0.24
 *   node scripts/release/cws-publish.mjs --mode publish --expected-version v1.0.24
 *
 * 需要环境变量：CHROME_CLIENT_ID / CHROME_CLIENT_SECRET / CHROME_REFRESH_TOKEN /
 * CHROME_PUBLISHER_ID / CHROME_ITEM_ID（`check` 模式除外）。
 */
import { access, appendFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { strFromU8, unzipSync } from 'fflate';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// 默认指向真实服务；CWS_* 覆盖只用于本地 mock 测试，CI 不设置。
const API = process.env.CWS_API_BASE || 'https://chromewebstore.googleapis.com';
const TOKEN_URL = process.env.CWS_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const POLL_INTERVAL_MS = Number(process.env.CWS_POLL_INTERVAL_MS) || 5_000;

const { values: options } = parseArgs({
  options: {
    mode: { type: 'string', default: 'publish' },
    zip: { type: 'string' },
    'expected-version': { type: 'string', default: '' },
    'deploy-percentage': { type: 'string', default: '100' },
    'timeout-ms': { type: 'string', default: '600000' },
    'skip-upload': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
});

if (options.help) {
  console.log(
    'Usage: cws-publish.mjs [--mode check|status|upload|publish] [--expected-version v1.2.3]\n' +
      '                       [--zip .output/lumo-1.2.3-chrome.zip] [--deploy-percentage 100]\n' +
      '                       [--timeout-ms 600000] [--skip-upload]',
  );
  process.exit(0);
}

const MODES = new Set(['check', 'status', 'upload', 'publish']);
const mode = options.mode;
const expectedVersion = normalizeTagVersion(options['expected-version']) || undefined;

let deployPercentage = 0;
let timeoutMs = 0;
let accessToken = '';

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n✖ ${message}`);
  await writeSummary([
    '## Chrome Web Store publish failed',
    '',
    '```',
    message,
    '```',
  ]);
  process.exitCode = 1;
});

async function main() {
  if (!MODES.has(mode)) {
    fatal(`Unknown --mode "${mode}". Expected one of: ${[...MODES].join(', ')}`);
  }
  if (options['skip-upload'] && mode !== 'publish') {
    fatal('--skip-upload is only valid with --mode publish.');
  }
  deployPercentage = parsePercentage(options['deploy-percentage']);
  timeoutMs = Number(options['timeout-ms']);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    fatal(`Invalid --timeout-ms "${options['timeout-ms']}"`);
  }

  const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const localVersion = packageJson.version;
  assertVersion(localVersion, 'package.json version');

  if (expectedVersion) {
    if (!versionEquals(expectedVersion, localVersion)) {
      fatal(
        `Tag/package version mismatch: expected ${expectedVersion}, ` +
          `but package.json is ${localVersion}. Bump package.json before tagging.`,
      );
    }
  }

  const zipPath = await resolveZip(localVersion);
  const manifestVersion = await readZipManifestVersion(zipPath);
  assertVersion(manifestVersion, 'zip manifest version');

  if (!versionEquals(manifestVersion, localVersion)) {
    fatal(
      `Zip manifest version ${manifestVersion} does not match package.json ${localVersion}. ` +
        'The zip is stale — run "npm run zip" again.',
    );
  }

  const targetVersion = expectedVersion ?? localVersion;
  log(`Local package OK: ${path.relative(ROOT, zipPath)} (version ${targetVersion})`);

  if (mode === 'check') {
    await writeSummary([
      '## Chrome Web Store package check',
      '',
      `- Version: \`${targetVersion}\``,
      `- Package: \`${path.relative(ROOT, zipPath)}\``,
      '- No API calls were made.',
    ]);
    return;
  }

  accessToken = await getAccessToken();
  const itemName = getItemName();
  let status = await fetchStatus(itemName);

  const published = publishedVersion(status);
  const pending = submittedVersion(status);

  log(`Published version: ${published ?? '(none)'}`);
  if (pending.version) log(`Submitted version: ${pending.version} (${pending.state ?? 'unknown'})`);

  if (published && compareVersions(targetVersion, published) <= 0) {
    fatal(
      `Version ${targetVersion} is not greater than the published version ${published}. ` +
        'Bump package.json and retag before publishing.',
    );
  }

  let skipUpload = Boolean(options['skip-upload']);
  let skipPublish = false;

  if (skipUpload) {
    if (pending.version && !versionEquals(pending.version, targetVersion)) {
      fatal(
        `--skip-upload refused: the submitted revision is ${pending.version}, ` +
          `but this run targets ${targetVersion}. Upload the matching package instead.`,
      );
    }
    if (!pending.version) {
      console.warn(
        '⚠ No submitted revision recorded; publishing whatever package the store processed last. ' +
          'Verify the uploaded version in the developer dashboard first.',
      );
    }
    log('Skipping upload; publishing the last package the store processed.');
  }

  if (pending.version && versionEquals(pending.version, targetVersion)) {
    if (pending.state === 'PENDING_REVIEW' || pending.state === 'PUBLISHED') {
      // 同一版本已经在审核队列/已经发布，再传一次只会被商店拒绝。
      skipUpload = true;
      skipPublish = true;
      log(`This version is already ${pending.state.toLowerCase()}; nothing to upload or submit.`);
    } else if (pending.state === 'STAGED' || pending.state === 'CANCELLED') {
      // 审核已通过但被暂存，或提交被取消：包还在商店里，重新 publish 即可。
      skipUpload = true;
      log(`This version is ${pending.state.toLowerCase()}; skipping upload and resubmitting it.`);
    } else if (pending.state === 'REJECTED') {
      fatal(
        `Version ${targetVersion} was rejected by the store. Fix the listing/package, ` +
          'bump the version, and tag again.',
      );
    }
  }

  if (mode === 'status') {
    printStatus(status);
    await writeSummary(statusSummary(status, { zipPath, targetVersion, mode }));
    return;
  }

  if (!skipUpload) {
    log(`Uploading ${path.relative(ROOT, zipPath)}…`);
    status = await uploadAndWait(itemName, zipPath, targetVersion);
  }

  if (mode === 'upload') {
    printStatus(status);
    await writeSummary(statusSummary(status, { zipPath, targetVersion, mode }));
    return;
  }

  if (!skipPublish) {
    await publish(itemName);
  }

  // 提交后回读一次用于日志和摘要。发布已经成功，状态查询失败不应把整次发布判为失败，
  // 否则重跑 workflow 有机会被商店当成重复提交。
  try {
    status = await fetchStatus(itemName);
    printStatus(status);
    await writeSummary(statusSummary(status, { zipPath, targetVersion, mode }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠ Published, but the final status query failed: ${message}`);
    await writeSummary([
      ...statusSummary(status, { zipPath, targetVersion, mode }),
      '',
      '> Final status query failed; check the developer dashboard.',
    ]);
  }
}

function getItemName() {
  const publisherId = requireEnv('CHROME_PUBLISHER_ID');
  const itemId = requireEnv('CHROME_ITEM_ID');
  return `publishers/${publisherId}/items/${itemId}`;
}

async function getAccessToken() {
  const clientId = requireEnv('CHROME_CLIENT_ID');
  const clientSecret = requireEnv('CHROME_CLIENT_SECRET');
  const refreshToken = requireEnv('CHROME_REFRESH_TOKEN');

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    fatal(`OAuth token refresh failed (${response.status}): ${text}`);
  }

  const data = JSON.parse(text);
  if (!data.access_token) {
    fatal('OAuth token refresh returned no access_token.');
  }

  return data.access_token;
}

async function fetchStatus(itemName) {
  return request(`/v2/${itemName}:fetchStatus`);
}

async function uploadAndWait(itemName, zipPath, targetVersion) {
  const buffer = await readFile(zipPath);
  const size = buffer.byteLength;

  // 1) 发起 resumable upload，响应头里带真正的 upload URL。
  const startResponse = await fetch(`${API}/upload/v2/${itemName}:upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': 'application/zip',
    },
  });

  if (!startResponse.ok) {
    fatal(
      `Upload start failed (${startResponse.status}): ${await startResponse.text()}`,
    );
  }

  const uploadUrl = startResponse.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    fatal('Upload start succeeded but returned no x-goog-upload-url header.');
  }
  // 释放连接；start 响应体本身没有有用信息。
  await startResponse.arrayBuffer();

  // 2) 一次性上传全部字节并 finalize。
  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: buffer,
  });

  const uploadText = await uploadResponse.text();
  if (!uploadResponse.ok) {
    fatal(`Upload failed (${uploadResponse.status}): ${uploadText}`);
  }

  const result = parseJson(uploadText, 'upload response');
  log(`Upload accepted: uploadState=${result.uploadState ?? '(unknown)'}`);

  if (result.crxVersion && !versionEquals(result.crxVersion, targetVersion)) {
    fatal(
      `Store read version ${result.crxVersion} from the zip, but expected ${targetVersion}.`,
    );
  }

  if (result.uploadState === 'IN_PROGRESS') {
    return waitForUpload();
  }

  if (result.uploadState === 'SUCCEEDED') {
    try {
      return await fetchStatus(itemName);
    } catch (error) {
      // 上传已经成功，不要因为一次状态查询抖动而让重跑再传一次同版本。
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`⚠ Upload succeeded, but the status query failed: ${message}`);
      return { ...result, lastAsyncUploadState: result.uploadState };
    }
  }

  fatal(`Upload did not succeed: ${uploadText}`);
}

async function waitForUpload() {
  const deadline = Date.now() + timeoutMs;
  const itemName = getItemName();

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let status;
    try {
      status = await fetchStatus(itemName);
    } catch (error) {
      // 轮询期间的瞬时失败不应中断上传，继续等到 deadline。
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`⚠ Status poll failed, retrying: ${message}`);
      continue;
    }
    const state = status.lastAsyncUploadState;
    log(`Upload state: ${state ?? '(unknown)'}`);

    if (state === 'SUCCEEDED') return status;
    if (state === 'FAILED') fatal('The store rejected the package while processing it.');
    if (state === 'NOT_FOUND') fatal('The store has no record of the upload (NOT_FOUND).');
  }

  fatal(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for upload processing.`);
}

async function publish(itemName) {
  const body = { publishType: 'DEFAULT_PUBLISH' };
  // 交接文档建议用 setPublishedDeployPercentage 恢复 100%，但该接口只对
  // 7 日活跃用户 > 10,000 的条目开放；在 publish 请求里指定初始 rollout 更通用。
  if (deployPercentage > 0) {
    body.deployInfos = [{ deployPercentage }];
  }

  log(`Submitting for review${deployPercentage > 0 ? ` (rollout ${deployPercentage}%)` : ''}…`);

  const response = await request(`/v2/${itemName}:publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const warnings = response.warningInfo?.warnings ?? [];
  for (const warning of warnings) {
    console.warn(`⚠ ${warning.reason ?? 'warning'}: ${warning.description ?? ''}`);
  }

  if (response.state === 'REJECTED' || response.state === 'CANCELLED') {
    fatal(`Publish was not accepted: state=${response.state}`);
  }

  log(`Publish submitted: state=${response.state ?? '(unknown)'}`);
}

function statusSummary(status, { zipPath, targetVersion, mode }) {
  const published = publishedVersion(status) ?? '(none)';
  const pending = submittedVersion(status);
  const lines = [
    '## Chrome Web Store publish',
    '',
    `| Field | Value |`,
    `| --- | --- |`,
    `| Mode | \`${mode}\` |`,
    `| Target version | \`${targetVersion}\` |`,
    `| Package | \`${path.relative(ROOT, zipPath)}\` |`,
    `| Published version | \`${published}\` |`,
    `| Submitted version | \`${pending.version ?? '(none)'}\` |`,
    `| Submission state | \`${pending.state ?? '(none)'}\` |`,
    `| Last upload state | \`${status.lastAsyncUploadState ?? '(unknown)'}\` |`,
  ];

  if (status.warned) lines.push('| Warned | yes — check the developer dashboard |');
  if (status.takenDown) lines.push('| Taken down | yes — cannot publish until resolved |');
  return lines;
}

function publishedVersion(status) {
  return latestChannelVersion(status.publishedItemRevisionStatus);
}

function submittedVersion(status) {
  return {
    version: latestChannelVersion(status.submittedItemRevisionStatus),
    state: status.submittedItemRevisionStatus?.state,
  };
}

function latestChannelVersion(revision) {
  const versions = (revision?.distributionChannels ?? [])
    .map((channel) => channel.crxVersion)
    .filter(Boolean);

  if (versions.length === 0) return undefined;
  return versions.sort(compareVersions).at(-1);
}

async function resolveZip(version) {
  if (options.zip) {
    const explicit = path.resolve(ROOT, options.zip);
    try {
      await access(explicit);
    } catch {
      fatal(`--zip file not found: ${explicit}`);
    }
    if (!explicit.endsWith('.zip')) fatal(`--zip must point to a .zip file: ${explicit}`);
    return explicit;
  }

  const outputDir = path.join(ROOT, '.output');
  let entries;
  try {
    entries = await readdir(outputDir);
  } catch {
    fatal(`No build output at ${outputDir}. Run "npm run zip" first.`);
  }

  const candidates = entries.filter((name) => name.endsWith('-chrome.zip'));
  const matching = candidates.filter((name) => name.endsWith(`-${version}-chrome.zip`));

  if (matching.length === 1) return path.join(outputDir, matching[0]);

  if (matching.length > 1) {
    fatal(
      `Found multiple packages for version ${version}: ${matching.join(', ')}. ` +
        'Remove stale zips or pass --zip.',
    );
  }

  fatal(
    `No Chrome package for version ${version} in ${outputDir}. ` +
      `Found: ${candidates.length ? candidates.join(', ') : '(none)'}. Run "npm run zip" first.`,
  );
}

async function readZipManifestVersion(zipPath) {
  const archive = unzipSync(await readFile(zipPath), {
    filter: (file) => file.name === 'manifest.json',
  });
  const manifest = archive['manifest.json'];
  if (!manifest) fatal(`${zipPath} has no top-level manifest.json.`);
  return JSON.parse(strFromU8(manifest)).version;
}

async function request(url, init = {}) {
  const response = await fetch(`${API}${url}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    fatal(`${init.method ?? 'GET'} ${url} failed (${response.status} ${response.statusText}): ${text}`);
  }

  return text ? parseJson(text, url) : {};
}

function printStatus(status) {
  console.log(JSON.stringify(status, null, 2));
}

async function writeSummary(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    await appendFile(file, `${lines.join('\n')}\n\n`);
  } catch {
    // Summary 只是锦上添花，写失败不应该影响发布结果。
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fatal(`Missing required environment variable ${name}.`);
  return value;
}

function normalizeTagVersion(value) {
  return String(value ?? '').trim().replace(/^v/i, '');
}

function assertVersion(version, source) {
  if (!/^\d+(\.\d+){0,3}$/.test(String(version))) {
    fatal(`Invalid extension version "${version}" from ${source}.`);
  }
}

function versionEquals(a, b) {
  return compareVersions(a, b) === 0;
}

/** 按 Chrome 扩展的 1~4 段数字版本比较；缺省段按 0 处理。 */
function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  return 0;
}

function parsePercentage(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    fatal(`Invalid --deploy-percentage "${value}". Expected an integer 0-100 (0 = leave unset).`);
  }
  return parsed;
}

function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch {
    fatal(`Invalid JSON in ${source}: ${text.slice(0, 500)}`);
  }
}

function log(message) {
  console.log(`• ${message}`);
}

function fatal(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
