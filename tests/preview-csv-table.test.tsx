// @vitest-environment jsdom
/**
 * The CSV table is the rendered view of a data file.
 *
 * What matters: the header row becomes column headers, a quoted line break stays
 * inside its record (so the table's row count matches the file's record count),
 * a ragged record renders short instead of breaking the table, and the recorded
 * numbering tells the truth about where a record sits in the file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { CsvPreview } from '@/entrypoints/preview/CsvPreview';
import { SELECT_ALL_ROOT_ATTR } from '@/lib/use-select-all-scope';

afterEach(() => {
  cleanup();
});

/** Rendered body rows, excluding the header and the windowing spacers. */
function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr')).filter(
    (row) => !row.hasAttribute('aria-hidden'),
  );
}

function headerCells(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('thead th')).map((cell) => cell.textContent ?? '');
}

describe('CsvPreview', () => {
  it('renders the header row as column headers', () => {
    const { container } = render(<CsvPreview content={'id,name\n1,Ada\n2,Grace\n'} />);

    // The first `th` is the record-number corner.
    expect(headerCells(container)).toEqual(['', 'id', 'name']);
    expect(bodyRows(container)).toHaveLength(2);
  });

  it('keeps a quoted line break inside one record', () => {
    const content = 'id,note\r\n1,"line one\r\nline two"\r\n2,flat\r\n';
    const { container } = render(<CsvPreview content={content} />);

    const rows = bodyRows(container);
    expect(rows).toHaveLength(2);

    const cell = rows[0]!.querySelectorAll('td')[2]!;
    // Single line in the cell, full value in the hover title.
    expect(cell.textContent).toContain('line one line two');
    expect(cell.querySelector('[title]')?.getAttribute('title')).toBe('line one\r\nline two');
  });

  it('renders a ragged record short instead of breaking the table', () => {
    const { container } = render(<CsvPreview content={'a,b,c\n1,2\n3,4,5,6\n'} />);

    const rows = bodyRows(container);
    // Columns come from the widest record, plus the record-number corner.
    expect(headerCells(container)).toHaveLength(5);
    expect(rows[0]!.querySelectorAll('td')).toHaveLength(5);
    // The short record's missing cells render empty, not misaligned.
    expect(rows[0]!.querySelectorAll('td')[4]!.textContent).toBe('');
    expect(rows[1]!.querySelectorAll('td')[4]!.textContent).toBe('6');
  });

  it('treats a numeric first record as data, not as a header', () => {
    const { container } = render(<CsvPreview content={'1,Ada\n2,Grace\n'} />);

    // No header row in the file, so no header strip in the table either.
    expect(container.querySelector('thead')).toBeNull();
    const rows = bodyRows(container);
    expect(rows).toHaveLength(2);
    // No header row consumed: the first record is still numbered 1.
    expect(rows[0]!.querySelector('td')?.textContent).toBe('1');
  });

  it('numbers records by their position in the file, header included', () => {
    const { container } = render(<CsvPreview content={'id,name\n1,Ada\n2,Grace\n'} />);

    const numbers = bodyRows(container).map((row) => row.querySelector('td')?.textContent);
    expect(numbers).toEqual(['2', '3']);
  });

  it('keeps the content in the select-all scope', () => {
    const { container } = render(<CsvPreview content={'id,name\n1,Ada\n'} />);

    expect(container.querySelector(`[${SELECT_ALL_ROOT_ATTR}]`)).toBeTruthy();
  });

  it('renders nothing for an empty file', () => {
    const { container } = render(<CsvPreview content={''} />);

    expect(container.querySelector('table')).toBeNull();
  });

  it('renders only the window of a long file, with spacers for the rest', async () => {
    const records = Array.from({ length: 2000 }, (_, index) => `${index},name ${index}`);
    const { container } = render(<CsvPreview content={['id,name', ...records].join('\n')} />);

    const scroller = container.firstElementChild as HTMLElement;
    // jsdom does no layout, so the viewport the window is computed from is
    // supplied here: 280px shows ten 28px records, plus the overscan band.
    Object.defineProperty(scroller, 'clientHeight', { value: 280, configurable: true });
    Object.defineProperty(scroller, 'scrollTop', { value: 0, configurable: true });
    fireEvent.scroll(scroller);

    const visibleCount = 10 + 8 * 2;
    await waitFor(() => expect(bodyRows(container)).toHaveLength(visibleCount));

    // Scrolled 100 records down: the window starts eight records earlier, and a
    // spacer of exactly that many fixed-height rows keeps the scrollbar honest.
    Object.defineProperty(scroller, 'scrollTop', { value: 100 * 28, configurable: true });
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const spacer = Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr')).find(
        (row) => row.hasAttribute('aria-hidden'),
      );
      const height = spacer?.querySelector('td')?.style.height;
      expect(height).toBe(`${(100 - 8) * 28}px`);
    });
    expect(bodyRows(container)).toHaveLength(visibleCount);
  });
});
