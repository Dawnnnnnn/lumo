/**
 * RFC 4180 CSV parsing for the file preview, plus the two judgements a table
 * view has to make before it can render anything: which character separates the
 * fields, and whether the first record is a header.
 *
 * The preview's job is to show the file, so this parser is deliberately
 * forgiving where real-world exports are sloppy and strict where the
 * specification defines an answer:
 *
 * - quoted fields may contain the delimiter, doubled quotes (`""`) and line
 *   breaks, which is the whole reason a naive `split(',')` is wrong;
 * - `CRLF`, `LF` and lone `CR` all end a record (Excel on Windows, Numbers on
 *   macOS, editors that were told otherwise);
 * - a UTF-8 BOM is dropped instead of turning the first header name into
 *   `\uFEFFid`;
 * - a trailing newline is not a record, and neither is a blank line — both are
 *   file plumbing, not data;
 * - an unterminated quote (a truncated write, or a stray `"` the producer never
 *   escaped, which only opens a quote at the start of a field) swallows the rest
 *   of the file into one field rather than throwing, because a preview that
 *   goes blank on a malformed line is worse than one that shows it.
 */

/** Characters a record may be split on. Tab is here for `.tsv` and for the tab
 * exports many systems emit under a `.csv` name. */
export type CsvDelimiter = ',' | ';' | '\t' | '|';

/** Candidates {@link detectDelimiter} scores, in preference order. */
export const CSV_DELIMITERS: readonly CsvDelimiter[] = [',', ';', '\t', '|'];

export interface CsvParseResult {
  /** Records in file order; quoted line breaks are kept inside their field. */
  rows: string[][];
  /** Delimiter that produced {@link rows}. */
  delimiter: CsvDelimiter;
}

export interface CsvTable extends CsvParseResult {
  /** Width of the widest record — the number of columns to render. */
  columns: number;
  /** Whether the first record reads as a header; see {@link hasHeaderRow}. */
  header: boolean;
}

/** Bytes inspected when guessing the delimiter. */
const DETECTION_SAMPLE_SIZE = 64 * 1024;

/** Numbers as producers write them: optional currency sign, thousands
 * separators, decimals, trailing percent. */
const NUMERIC_LABEL = /^[+-]?[$€£¥]?\s*[\d.,\s]+%?$/;

/** `2024-01-31`, `31.01.2024`, `01/31/24` — a date is data, not a label. */
const DATE_LABEL = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Append a record unless it is a blank line.
 *
 * A single empty field is what a blank line parses to. Skipping it keeps
 * trailing newlines and the double newline some editors leave behind out of the
 * table, without touching a genuine record that merely has empty fields
 * (`a,,c` keeps its middle cell).
 */
function pushRecord(rows: string[][], record: string[]): void {
  if (record.length === 1 && record[0] === '') return;
  rows.push(record);
}

/**
 * Parse CSV text into records.
 *
 * Character-by-character rather than split-and-rejoin: the parser has to know
 * whether it is inside a quoted field before it can decide what a comma or a
 * newline means, and that state cannot be recovered after splitting.
 */
export function parseCsv(
  text: string,
  options: { delimiter?: CsvDelimiter } = {},
): CsvParseResult {
  const input = stripBom(text);
  const delimiter = options.delimiter ?? detectDelimiter(input);
  const rows: string[][] = [];

  let record: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  while (i < input.length) {
    const char = input[i]!;
    i += 1;

    if (quoted) {
      if (char !== '"') {
        field += char;
        continue;
      }
      // `""` inside a quoted field is one literal quote; a lone `"` closes it.
      if (input[i] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }

    // A quote only opens a quoted field at its start. Mid-field it is a
    // character the producer forgot to escape, and honouring it here would
    // swallow every following record.
    if (char === '"' && field === '') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      record.push(field);
      field = '';
      continue;
    }
    if (char === '\r' || char === '\n') {
      record.push(field);
      field = '';
      pushRecord(rows, record);
      record = [];
      // `CRLF` is one line ending, not two.
      if (char === '\r' && input[i] === '\n') i += 1;
      continue;
    }
    field += char;
  }

  // A record only exists if something was read: `a,b\n` must not gain a third,
  // empty one. An unterminated quote still lands here, keeping its content.
  if (field !== '' || record.length > 0) {
    record.push(field);
    pushRecord(rows, record);
  }

  return { rows, delimiter };
}

/** Field counts of the records in a sample, quote-aware. */
function recordWidths(sample: string, delimiter: CsvDelimiter): number[] {
  const widths: number[] = [];
  let fields = 1;
  let quoted = false;

  for (let i = 0; i < sample.length; i += 1) {
    const char = sample[i];
    if (quoted) {
      if (char === '"') {
        if (sample[i + 1] === '"') i += 1;
        else quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      fields += 1;
      continue;
    }
    if (char === '\n' || (char === '\r' && sample[i + 1] !== '\n')) {
      widths.push(fields);
      fields = 1;
    }
  }
  // The tail is a record only when the sample actually split something; when the
  // text merely ended, counting it would skew the agreement ratio below.
  if (!quoted && fields > 1) widths.push(fields);

  return widths;
}

function mostFrequent(values: readonly number[]): number {
  const counts = new Map<number, number>();
  let mode = values[0]!;
  let best = 0;
  for (const value of values) {
    const next = (counts.get(value) ?? 0) + 1;
    counts.set(value, next);
    if (next > best) {
      best = next;
      mode = value;
    }
  }
  return mode;
}

/**
 * Guess the field delimiter.
 *
 * Each candidate is scored by how *regularly* it splits the sample: the
 * delimiter a producer used splits nearly every record into the same number of
 * fields, while a character that appears inside text is irregular. Column count
 * only breaks ties, so a `;`-delimited file whose text fields contain commas
 * still resolves to `;`.
 *
 * Defaults to `,` when nothing splits a record — a single-column file has no
 * delimiter to find, and the comma is what the extension name promises.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const sample = stripBom(text).slice(0, DETECTION_SAMPLE_SIZE);
  let delimiter: CsvDelimiter = ',';
  let bestScore = 0;

  for (const candidate of CSV_DELIMITERS) {
    const widths = recordWidths(sample, candidate);
    if (widths.length === 0) continue;

    const mode = mostFrequent(widths);
    // A candidate that never splits a record is not the separator.
    if (mode < 2) continue;

    const agreement = widths.filter((width) => width === mode).length / widths.length;
    const score = agreement * 1000 + Math.min(mode, 100);
    if (score > bestScore) {
      bestScore = score;
      delimiter = candidate;
    }
  }

  return delimiter;
}

/**
 * Whether the first record is a header.
 *
 * RFC 4180 has no way to say so, so the table view infers it the way other
 * viewers do: a header is a row of distinct, non-empty labels, none of which is
 * a number or a date. Data that happens to be free text (a two-column name /
 * department export) is indistinguishable from a header, and reading it as one
 * costs nothing — the row keeps its row number and stays visible either way.
 *
 * A single column never gets header treatment: there is no second column to
 * label, and promoting the first value would hide a plain list's first item.
 */
export function hasHeaderRow(rows: readonly string[][]): boolean {
  const first = rows[0];
  if (!first || first.length < 2) return false;

  const labels = first.map((cell) => cell.trim());
  if (labels.some((label) => label === '')) return false;
  if (new Set(labels).size !== labels.length) return false;
  return !labels.some((label) => NUMERIC_LABEL.test(label) || DATE_LABEL.test(label));
}

/**
 * Whether a column reads as numbers, for right alignment.
 *
 * Decided per column rather than per cell so the digits line up, and over a
 * sample so a stray note in row 90 000 does not flip the alignment. Empty cells
 * are ignored: sparse numeric columns are still numeric.
 */
export function isNumericColumn(
  rows: readonly string[][],
  column: number,
  sampleSize = 50,
): boolean {
  let seen = 0;
  for (let i = 0; i < rows.length && seen < sampleSize; i += 1) {
    const value = rows[i]![column]?.trim() ?? '';
    if (value === '') continue;
    if (!NUMERIC_LABEL.test(value)) return false;
    seen += 1;
  }
  return seen > 0;
}

/** Parse, measure and classify in one pass — what the preview renders from. */
export function parseCsvTable(text: string, options: { delimiter?: CsvDelimiter } = {}): CsvTable {
  const { rows, delimiter } = parseCsv(text, options);
  const columns = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  return { rows, delimiter, columns, header: hasHeaderRow(rows) };
}
