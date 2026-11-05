/**
 * Frontmatter parsing for `SKILL.md`.
 *
 * Agent Skills files open with a YAML frontmatter block delimited by `---`
 * lines. The block *is* the manifest — `name`, `description`, and the optional
 * `license`, `compatibility`, `metadata`, `allowed-tools` and
 * `disable-model-invocation` — so it is parsed with a real YAML parser rather
 * than a `key: value` scanner: a description spanning several lines with quoted
 * colons is ordinary YAML and would be read as garbage by the cheap version.
 *
 * The body is returned untouched (it is what the model reads after routing), and
 * a file without frontmatter is not an error here — the validator decides whether
 * that is fatal, so the parser stays a parser.
 */
import { load as loadYaml } from 'js-yaml';

export interface FrontmatterDocument {
  /** Parsed frontmatter mapping, or `{}` when the file has none. */
  data: Record<string, unknown>;
  /** Everything after the closing delimiter, or the whole file when there is none. */
  body: string;
}

export type FrontmatterResult =
  | { ok: true; document: FrontmatterDocument }
  | { ok: false; error: string };

const OPENING_DELIMITER = '---';

/** Strip a byte-order mark; editors on Windows add one and it would hide `---`. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseFrontmatter(raw: string): FrontmatterResult {
  const text = stripBom(raw);
  const lines = text.split('\n');
  const first = lines[0]?.trim() ?? '';

  if (first !== OPENING_DELIMITER) {
    return { ok: true, document: { data: {}, body: text } };
  }

  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === OPENING_DELIMITER || line === '...') {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex === -1) {
    return { ok: false, error: 'frontmatter opens with "---" but never closes' };
  }

  const yamlText = lines.slice(1, closingIndex).join('\n');
  let parsed: unknown;
  try {
    parsed = loadYaml(yamlText);
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return { ok: false, error: `frontmatter is not valid YAML: ${message}` };
  }

  if (parsed === null || parsed === undefined) {
    parsed = {};
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'frontmatter must be a YAML mapping of fields' };
  }

  return {
    ok: true,
    document: {
      data: parsed as Record<string, unknown>,
      body: lines.slice(closingIndex + 1).join('\n'),
    },
  };
}
