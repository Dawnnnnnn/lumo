/**
 * The CSV parser is the difference between a data file and a wall of commas.
 *
 * What matters for a preview: a field may contain the delimiter, a `""` escape
 * and a line break (RFC 4180), all three line-ending conventions end a record,
 * a BOM does not become part of the first header name, and sloppy real-world
 * files (trailing newlines, ragged rows, an unterminated quote) still render
 * every record they contain instead of failing the whole file.
 */
import { describe, expect, it } from 'vitest';
import {
  detectDelimiter,
  hasHeaderRow,
  isNumericColumn,
  parseCsv,
  parseCsvTable,
} from '@/lib/csv';

describe('parseCsv records', () => {
  it('splits plain records and keeps the trailing newline out of the table', () => {
    expect(parseCsv('id,name\n1,Ada\n2,Grace\n').rows).toEqual([
      ['id', 'name'],
      ['1', 'Ada'],
      ['2', 'Grace'],
    ]);
  });

  it('accepts CRLF, LF and lone CR as record separators', () => {
    const rows = [
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ];
    expect(parseCsv('a,b\r\nc,d\r\ne,f\r\n').rows).toEqual(rows);
    expect(parseCsv('a,b\nc,d\ne,f').rows).toEqual(rows);
    expect(parseCsv('a,b\rc,d\re,f').rows).toEqual(rows);
  });

  it('keeps a quoted delimiter inside its field', () => {
    expect(parseCsv('name,note\n"Smith, Ada",ok\n').rows).toEqual([
      ['name', 'note'],
      ['Smith, Ada', 'ok'],
    ]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('"say ""hi""",b').rows).toEqual([['say "hi"', 'b']]);
  });

  it('keeps a quoted line break inside its field instead of splitting the record', () => {
    const { rows } = parseCsv('id,note\r\n1,"line one\r\nline two"\r\n2,flat\r\n');

    expect(rows).toEqual([
      ['id', 'note'],
      ['1', 'line one\r\nline two'],
      ['2', 'flat'],
    ]);
    // The record count is the proof: the embedded break did not create a row.
    expect(rows).toHaveLength(3);
  });

  it('drops the BOM instead of prefixing the first header name', () => {
    expect(parseCsv('\uFEFFid,name\n1,Ada\n').rows[0]).toEqual(['id', 'name']);
  });

  it('ignores blank lines but keeps records with empty fields', () => {
    expect(parseCsv('a,,c\n\n\nb,,d\n\n').rows).toEqual([
      ['a', '', 'c'],
      ['b', '', 'd'],
    ]);
  });

  it('keeps ragged records as they are', () => {
    expect(parseCsv('a,b,c\n1,2\n3,4,5,6\n').rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2'],
      ['3', '4', '5', '6'],
    ]);
  });

  it('treats an unterminated quote as the rest of the file, not as an error', () => {
    expect(parseCsv('id,note\n1,"never closed\n2,still here\n').rows).toEqual([
      ['id', 'note'],
      ['1', 'never closed\n2,still here\n'],
    ]);
  });

  it('keeps a stray quote mid-field literal rather than swallowing the file', () => {
    expect(parseCsv('5" screen,b\n2,in\n').rows).toEqual([
      ['5" screen', 'b'],
      ['2', 'in'],
    ]);
  });
});

describe('detectDelimiter', () => {
  it('finds a comma-separated file', () => {
    expect(detectDelimiter('a,b,c\n1,2,3\n')).toBe(',');
  });

  it('finds a semicolon file whose text fields contain commas', () => {
    expect(detectDelimiter('name;city\n"Smith, Ada";Paris\n"Doe, John";Lyon\n')).toBe(';');
  });

  it('finds tab-separated data stored under a .csv name', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3\n')).toBe('\t');
  });

  it('falls back to a comma when nothing splits the records', () => {
    expect(detectDelimiter('one\ntwo\nthree\n')).toBe(',');
  });
});

describe('hasHeaderRow', () => {
  it('accepts distinct text labels', () => {
    expect(hasHeaderRow([['id', 'name'], ['1', 'Ada']])).toBe(true);
  });

  it('rejects a first record that reads as data', () => {
    expect(hasHeaderRow([['1', 'Ada'], ['2', 'Grace']])).toBe(false);
    expect(hasHeaderRow([['2024-01-31', '12.5'], ['2024-02-01', '13.5']])).toBe(false);
  });

  it('rejects blank or duplicated labels', () => {
    expect(hasHeaderRow([['id', ''], ['1', 'Ada']])).toBe(false);
    expect(hasHeaderRow([['name', 'name'], ['a', 'b']])).toBe(false);
  });

  it('never treats a single column as a header', () => {
    expect(hasHeaderRow([['title'], ['Ada']])).toBe(false);
  });
});

describe('isNumericColumn', () => {
  const rows = [
    ['1', 'Ada', ''],
    ['2', 'Grace', ''],
    ['3', 'Alan', ''],
  ];

  it('recognises a numeric column, ignoring empty cells', () => {
    expect(isNumericColumn(rows, 0)).toBe(true);
    expect(isNumericColumn(rows, 2)).toBe(false);
  });

  it('rejects mixed columns', () => {
    expect(isNumericColumn(rows, 1)).toBe(false);
  });
});

describe('parseCsvTable', () => {
  it('reports the width of the widest record and whether a header was found', () => {
    const table = parseCsvTable('id;name\n1;Ada\n2;Grace;extra\n');

    expect(table.delimiter).toBe(';');
    expect(table.columns).toBe(3);
    expect(table.header).toBe(true);
  });

  it('yields an empty table for an empty file', () => {
    expect(parseCsvTable('')).toEqual({ rows: [], delimiter: ',', columns: 0, header: false });
  });
});
