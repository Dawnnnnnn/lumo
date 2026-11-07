/**
 * `yq` — YAML (and JSON) query/edit for the browser shell.
 *
 * just-bash ships a `yq`, but the browser build excludes it: its bundle depends
 * on Node. `js-yaml` is already a runtime dependency of the extension (the
 * editor renders YAML), so a small `yq` subset costs nothing extra and covers
 * what an agent actually does with config files:
 *
 *   yq '.' config.yml                  # YAML → JSON
 *   yq -o yaml '.services.web' c.yml   # sub-document, back to YAML
 *   yq -r '.version' package.json      # raw scalar
 *   yq -p json '.' package.json        # JSON in, YAML out
 *   yq '.a.b = "x"' config.yml         # assignment (also += and |=)
 */

import { defineCommand, type ExecResult, type ResolvedCommandContext } from 'just-bash/browser';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';

type Json = unknown;

interface Segment {
  kind: 'key' | 'index' | 'iterate';
  key?: string;
  index?: number;
}

function parsePath(expression: string): Segment[] {
  const source = expression.trim();
  if (source === '' || source === '.') return [];
  let rest = source.startsWith('.') ? source.slice(1) : source;
  const segments: Segment[] = [];
  while (rest.length > 0) {
    if (rest.startsWith('[')) {
      const end = rest.indexOf(']');
      if (end === -1) throw new Error(`yq: unterminated '[' in filter`);
      const inner = rest.slice(1, end).trim();
      segments.push(inner === '' ? { kind: 'iterate' } : { kind: 'index', index: Number(inner) });
      rest = rest.slice(end + 1);
      if (rest.startsWith('.')) rest = rest.slice(1);
      continue;
    }
    if (rest.startsWith('.')) {
      rest = rest.slice(1);
      continue;
    }
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quote = rest.charAt(0);
      const end = rest.indexOf(quote, 1);
      if (end === -1) throw new Error('yq: unterminated quoted key');
      segments.push({ kind: 'key', key: rest.slice(1, end) });
      rest = rest.slice(end + 1);
      continue;
    }
    const match = /^[^.[\]]+/.exec(rest);
    if (!match) throw new Error(`yq: cannot parse filter near '${rest}'`);
    segments.push({ kind: 'key', key: match[0]! });
    rest = rest.slice(match[0].length);
  }
  return segments;
}

function navigate(value: Json, segments: Segment[], from = 0): Json {
  let current = value;
  // Index-based rather than `indexOf`: segments are not unique values, so
  // searching by identity both costs O(n²) and can resume at the wrong place.
  for (let index = from; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.kind === 'iterate') {
      if (!Array.isArray(current)) throw new Error('yq: cannot iterate a non-array');
      return current.map((item) => navigate(item, segments, index + 1));
    }
    if (current === null || current === undefined) return null;
    if (segment.kind === 'index') {
      if (!Array.isArray(current)) throw new Error('yq: cannot index a non-array');
      current = current[segment.index!];
      continue;
    }
    if (typeof current !== 'object') {
      throw new Error(`yq: cannot read '${segment.key}' of ${typeof current}`);
    }
    current = (current as Record<string, Json>)[segment.key!];
  }
  return current === undefined ? null : current;
}

function parseLiteral(text: string): Json {
  try {
    return JSON.parse(text);
  } catch {
    return yamlLoad(text);
  }
}

/** Apply `+=` / `|=` / `=` to the current value at the assigned path. */
function combine(current: Json, incoming: Json, operator: string): Json {
  if (operator === '+=') {
    if (typeof current === 'number' && typeof incoming === 'number') return current + incoming;
    if (Array.isArray(current) && Array.isArray(incoming)) return [...current, ...incoming];
    if (typeof current === 'string' && typeof incoming === 'string') return current + incoming;
    return incoming;
  }
  if (operator === '|=') {
    // `|=` updates with an expression. A path expression is evaluated against
    // the current value; anything else is a literal.
    const expression = typeof incoming === 'string' ? incoming.trim() : '';
    if (expression.startsWith('.')) return navigate(current, parsePath(expression));
    return incoming;
  }
  return incoming;
}

/**
 * Write `value` at `segments`, creating missing object/array branches.
 *
 * Missing parents become containers, but a *scalar* in the way is an error: the
 * old implementation replaced the whole document with `{}` in that case, which
 * silently discarded every other key.
 */
function assignAt(current: Json, segments: Segment[], value: Json, operator: string): Json {
  const [segment, ...rest] = segments;
  if (!segment) return value;
  if (segment.kind === 'iterate') throw new Error('yq: cannot assign through an iterator');

  const wantsArray = segment.kind === 'index';
  let container: Json;
  if (current === null || current === undefined) {
    container = wantsArray ? [] : {};
  } else if (wantsArray) {
    if (!Array.isArray(current)) throw new Error('yq: target is not an array');
    container = current;
  } else if (typeof current === 'object' && !Array.isArray(current)) {
    container = current;
  } else {
    throw new Error(`yq: cannot create a child of ${Array.isArray(current) ? 'an array' : typeof current}`);
  }

  if (wantsArray) {
    const array = container as Json[];
    const index = segment.index!;
    if (rest.length === 0) {
      array[index] = combine(array[index], value, operator);
    } else {
      array[index] = assignAt(array[index], rest, value, operator);
    }
    return array;
  }

  const object = container as Record<string, Json>;
  const key = segment.key!;
  if (rest.length === 0) {
    object[key] = combine(object[key], value, operator);
  } else {
    object[key] = assignAt(object[key], rest, value, operator);
  }
  return object;
}

function assign(root: Json, expression: string): { root: Json; value: Json } {
  const match = /^(.*?)\s*(\+=|\|=|=)\s*([\s\S]*)$/.exec(expression);
  if (!match) throw new Error('yq: expected an assignment such as .a.b = "value"');
  const [, pathText, operator, valueText] = match as unknown as [string, string, string, string];
  const segments = parsePath(pathText);
  if (segments.length === 0) throw new Error('yq: cannot assign to the document root');
  // `|=` takes an expression, so the raw text is what gets evaluated later.
  const value: Json = operator === '|=' ? valueText.trim() : parseLiteral(valueText);
  return { root: assignAt(root, segments, value, operator), value };
}

function format(value: Json, output: 'json' | 'yaml' | 'toml', raw: boolean): string {
  if (raw && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
    return `${value}\n`;
  }
  if (raw && value === null) return 'null\n';
  if (output === 'yaml') {
    const dumped = yamlDump(value, { lineWidth: 120, noRefs: true });
    return dumped.endsWith('\n') ? dumped : `${dumped}\n`;
  }
  if (output === 'toml') {
    throw new Error('yq: TOML output is not supported in the browser shell');
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readDocument(ctx: ResolvedCommandContext, file: string | undefined, input: 'yaml' | 'json'): Promise<Json> {
  let text: string;
  if (!file || file === '-') {
    text = decodeStdin(ctx);
    if (text.trim() === '') return null;
  } else {
    text = await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, file));
  }
  if (input === 'json') return JSON.parse(text);
  const loaded = yamlLoad(text);
  if (loaded === undefined) return null;
  // Multi-document files become arrays, which is what `yq '.'` shows.
  return loaded as Json;
}

function decodeStdin(ctx: ResolvedCommandContext): string {
  const stdin = ctx.stdin as unknown as string;
  if (!stdin) return '';
  const bytes = new Uint8Array(stdin.length);
  for (let i = 0; i < stdin.length; i += 1) bytes[i] = stdin.charCodeAt(i) & 0xff;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function createYqCommand() {
  return defineCommand('yq', async (args, ctx): Promise<ExecResult> => {
    let output: 'json' | 'yaml' | 'toml' = 'json';
    let input: 'yaml' | 'json' = 'yaml';
    let raw = false;
    const positional: string[] = [];

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if (arg === '-o' || arg === '--output-format') {
        output = String(args[++i]) as typeof output;
        continue;
      }
      if (arg === '-p' || arg === '--input-format') {
        input = String(args[++i]) as typeof input;
        continue;
      }
      if (arg === '-r' || arg === '--raw-output') {
        raw = true;
        continue;
      }
      if (arg === '-e' || arg === '--exit-status') {
        continue;
      }
      if (arg === '--') {
        positional.push(...args.slice(i + 1));
        break;
      }
      if (arg.startsWith('-') && arg !== '-') {
        return {
          stdout: '',
          stderr: `yq: unrecognized option '${arg}' (supported: -o, -p, -r, -e)\n`,
          exitCode: 2,
        };
      }
      positional.push(arg);
    }

    const filter = positional.length > 1 ? positional[0] : undefined;
    const file = positional.length > 1 ? positional[1] : positional[0];

    try {
      let document = await readDocument(ctx, file, input);
      let result: Json = document;
      if (filter && filter !== '.') {
        if (/[^=!<>]=(?!=)|[+\-|]=/.test(filter)) {
          const assignment = assign(document, filter);
          document = assignment.root;
          // `yq '.a.b = 1'` prints the whole document, not the assigned value.
          result = assignment.root;
        } else {
          result = navigate(document, parsePath(filter));
        }
      }
      return { stdout: format(result, output, raw), stderr: '', exitCode: 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { stdout: '', stderr: `${message.startsWith('yq:') ? message : `yq: ${message}`}\n`, exitCode: 1 };
    }
  });
}
