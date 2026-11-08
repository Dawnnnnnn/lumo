#!/usr/bin/env node
/**
 * Manifest locale generator.
 *
 * `manifest.json` references `__MSG_extName__`, `__MSG_extDescription__` and
 * `__MSG_actionTitle__`, which Chrome resolves from `_locales/<code>/messages.json`.
 * Those files are build inputs under `public/`, but their content is translated
 * data — so it lives in `i18n/manifest-messages.json` and this script bakes it
 * out. Hand-editing `public/_locales` would silently drift from
 * `i18n/locales.ts` the moment a language is added or removed.
 *
 * Run with `npm run i18n:manifest` after touching the data, and with
 * `npm run i18n:manifest -- --check` in CI to assert the generated tree is
 * committed and up to date.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const registryPath = join(root, 'i18n/locales.ts');
const messagesPath = join(root, 'i18n/manifest-messages.json');
const outDir = join(root, 'public/_locales');

const check = process.argv.includes('--check');

/** `description` is a translator hint; no browser renders it. */
const KEY_DESCRIPTIONS = {
  extName: 'The display name of the extension.',
  extDescription:
    'The description of the extension shown in browser extension stores (Chrome Web Store, Microsoft Edge Add-ons) and the extension management page.',
  actionTitle: "Tooltip shown when hovering the extension's toolbar icon.",
};

// The registry is a TS module; Node cannot import it, and pulling in a TS
// loader for three fields is not worth it. Both fields appear once per entry in
// the same order, so a positional zip is exact — and it is verified below.
const registry = readFileSync(registryPath, 'utf8');
// Entries are written either on one line or wrapped, so the pair is matched as
// a unit instead of relying on line anchors.
const pairs = [...registry.matchAll(/tag:\s*'([^']+)',\s*chrome:\s*'([^']+)'/g)].map((m) => [
  m[1],
  m[2],
]);

if (pairs.length === 0) {
  console.error('i18n:manifest failed — no locale entries found in locales.ts.');
  process.exit(1);
}

const tags = pairs.map(([tag]) => tag);
const chromeCodes = pairs.map(([, chrome]) => chrome);

const messages = JSON.parse(readFileSync(messagesPath, 'utf8'));
const failures = [];

for (const [index, tag] of tags.entries()) {
  const chromeCode = chromeCodes[index];
  if (tag.replace(/-/g, '_') !== chromeCode) {
    failures.push(`locales.ts: tag "${tag}" does not map to chrome code "${chromeCode}"`);
  }
  if (!messages[chromeCode]) {
    failures.push(`manifest-messages.json: missing entry for "${chromeCode}"`);
  }
}

for (const chromeCode of Object.keys(messages)) {
  if (!chromeCodes.includes(chromeCode)) {
    failures.push(`manifest-messages.json: "${chromeCode}" is not in locales.ts`);
  }
}

for (const [chromeCode, entry] of Object.entries(messages)) {
  for (const field of ['name', 'description', 'actionTitle']) {
    if (!entry[field] || entry[field].trim() === '') {
      failures.push(`manifest-messages.json: "${chromeCode}" has no ${field}`);
    }
  }
  // Chrome rejects a message over 132 chars in the store listing description.
  if (entry.description.length > 132) {
    failures.push(
      `manifest-messages.json: "${chromeCode}" description is ${entry.description.length} chars (max 132)`
    );
  }
}

if (failures.length > 0) {
  console.error(`i18n:manifest failed (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const serialize = (chromeCode) => {
  const entry = messages[chromeCode];
  const body = {
    extName: { message: entry.name, description: KEY_DESCRIPTIONS.extName },
    extDescription: { message: entry.description, description: KEY_DESCRIPTIONS.extDescription },
    actionTitle: { message: entry.actionTitle, description: KEY_DESCRIPTIONS.actionTitle },
  };
  return `${JSON.stringify(body, null, 2)}\n`;
};

if (check) {
  const stale = [];
  for (const chromeCode of Object.keys(messages)) {
    let existing = null;
    try {
      existing = readFileSync(join(outDir, chromeCode, 'messages.json'), 'utf8');
    } catch {
      stale.push(`${chromeCode}: missing messages.json`);
      continue;
    }
    if (existing !== serialize(chromeCode)) stale.push(`${chromeCode}: out of date`);
  }
  for (const dir of readdirSync(outDir)) {
    if (!messages[dir]) stale.push(`${dir}: stale locale directory`);
  }
  if (stale.length > 0) {
    console.error(`i18n:manifest check failed (${stale.length}): run npm run i18n:manifest`);
    for (const item of stale) console.error(`  - ${item}`);
    process.exit(1);
  }
  console.log(`i18n:manifest check passed: ${Object.keys(messages).length} locales.`);
} else {
  // Regenerating from scratch keeps a removed language from lingering in the build.
  rmSync(outDir, { recursive: true, force: true });
  for (const chromeCode of Object.keys(messages)) {
    mkdirSync(join(outDir, chromeCode), { recursive: true });
    writeFileSync(join(outDir, chromeCode, 'messages.json'), serialize(chromeCode));
  }
  console.log(`i18n:manifest wrote ${Object.keys(messages).length} locales to public/_locales.`);
}
