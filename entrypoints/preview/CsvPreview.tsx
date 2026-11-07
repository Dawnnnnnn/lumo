import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { selectAllRootProps } from '@/lib/use-select-all-scope';
import { isNumericColumn, parseCsvTable } from '@/lib/csv';

/**
 * CSV/TSV as a table.
 *
 * The source view still exists (the toolbar toggles between the two): a table is
 * the readable form of a data file, the source is where it gets edited. Commas,
 * quotes and line breaks inside fields are already resolved by
 * `parseCsvTable`, so this component only has to lay records out.
 *
 * Layout decisions that are not cosmetic:
 *
 * - **Every record is exactly one row tall.** Cells are single-line and
 *   truncated, with the full value on hover. That is what makes the windowing
 *   below exact instead of a guess, and it keeps a 50 000-row file scrollable.
 * - **Only the visible window is in the DOM.** Rows have a fixed height, so the
 *   window is `scrollTop / rowHeight`; two spacer rows stand in for the records
 *   above and below it.
 * - **The header and the record number stay put.** Both are how you read a wide
 *   or a long file: the column names while scrolling down, the record index
 *   while scrolling right.
 * - **A line break inside a cell is marked, not hidden.** Replacing it with a
 *   space would silently alter the value; the `↵` glyph says the cell continues
 *   and the hover title shows the whole thing.
 */

/** Height of one record row. The windowing arithmetic depends on it. */
const ROW_HEIGHT = 28;

/**
 * Record divider, drawn as an inset shadow rather than a border.
 *
 * A border would make a row `ROW_HEIGHT + 1` tall, and every scrolled pixel
 * would then land one more row off than the window expects — the gap a few
 * thousand records down would be a screenful. A shadow paints the same line
 * without taking part in layout, so the stride stays exactly `ROW_HEIGHT`.
 */
const RECORD_DIVIDER = 'shadow-[inset_0_-1px_0_0_var(--color-border)]';

/** Rows rendered beyond the viewport, so a fast scroll does not show blanks. */
const OVERSCAN = 8;

/** Widest a single column may get before its content is truncated. */
const COLUMN_MAX_WIDTH = 320;

export function CsvPreview({ content }: { content: string }) {
  const table = useMemo(() => parseCsvTable(content), [content]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });

  // Measure the scroll container, and keep measuring: the preview tab is
  // resizable and the window size decides how many records are worth rendering.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const sync = () => setViewport({ top: element.scrollTop, height: element.clientHeight });
    sync();

    // One frame per scroll burst: `scroll` fires per pixel on a trackpad, and a
    // re-render per event trades the smoothness it is meant to buy.
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    };

    const observer = new ResizeObserver(sync);
    observer.observe(element);
    element.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  const headerRow = table.header ? (table.rows[0] ?? null) : null;
  const bodyRows = useMemo(
    () => (table.header ? table.rows.slice(1) : table.rows),
    [table.header, table.rows],
  );

  const numericColumns = useMemo(
    () =>
      Array.from({ length: table.columns }, (_, column) => isNumericColumn(bodyRows, column)),
    [bodyRows, table.columns],
  );

  const first = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(
    bodyRows.length,
    first + Math.ceil(viewport.height / ROW_HEIGHT) + OVERSCAN * 2,
  );
  const visible = bodyRows.slice(first, last);

  // An empty file has no table to draw; the source view is the honest answer.
  if (table.rows.length === 0) return null;

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-auto scrollbar-lumo"
      {...selectAllRootProps}
    >
      <table className="w-full min-w-max border-separate border-spacing-0 text-xs">
        {/* No header row means no header: an empty strip above the first record
            would claim a column name that is not in the file. */}
        {headerRow && (
          <thead>
            <tr className="bg-card">
              {/* Corner: both the record-number column and the header row stay
                  pinned, so the intersection needs the highest layer. */}
              <th
                scope="col"
                className="sticky start-0 top-0 z-30 w-10 border-b border-e border-border bg-card p-0"
              />
              {Array.from({ length: table.columns }, (_, column) => (
                <th
                  key={column}
                  scope="col"
                  className="sticky top-0 z-20 border-b border-border bg-card p-0 text-start font-medium"
                >
                  <div
                    className="flex h-7 items-center gap-1 px-2"
                    style={{ maxWidth: COLUMN_MAX_WIDTH + 16 }}
                    title={headerRow[column] ?? ''}
                  >
                    <span className="min-w-0 truncate">{headerRow[column] ?? ''}</span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
        )}

        <tbody>
          {/* Spacer standing in for the records scrolled past. */}
          {first > 0 && <SpacerRow columns={table.columns} height={first * ROW_HEIGHT} />}

          {visible.map((record, index) => {
            const recordNumber = first + index + 1;
            return (
              <tr
                key={recordNumber}
                /* Opaque backgrounds, not a translucent tint: the pinned record
                   number inherits the row's colour and would otherwise paint
                   the tint twice over itself and read as a second stripe. */
                className="h-7 bg-background odd:bg-muted hover:bg-accent"
              >
                <td className="sticky start-0 z-10 w-10 select-none border-e border-border bg-inherit p-0 text-end align-middle">
                  <div
                    className={cn(
                      'flex h-7 items-center justify-end px-2 text-[11px] tabular-nums text-muted-foreground',
                      RECORD_DIVIDER,
                    )}
                  >
                    {/* The number is the record's place in the file, header
                        included: that is what a line reference in the source
                        view would say. */}
                    {headerRow ? recordNumber + 1 : recordNumber}
                  </div>
                </td>
                {Array.from({ length: table.columns }, (_, column) => (
                  <CsvCell
                    key={column}
                    value={record[column] ?? ''}
                    numeric={numericColumns[column] ?? false}
                  />
                ))}
              </tr>
            );
          })}

          {last < bodyRows.length && (
            <SpacerRow
              columns={table.columns}
              height={(bodyRows.length - last) * ROW_HEIGHT}
            />
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Stand-in for a run of records outside the render window. */
function SpacerRow({ columns, height }: { columns: number; height: number }) {
  return (
    <tr aria-hidden>
      <td colSpan={columns + 1} style={{ height, padding: 0, border: 0 }} />
    </tr>
  );
}

function CsvCell({ value, numeric }: { value: string; numeric: boolean }) {
  const multiline = value.includes('\n') || value.includes('\r');

  return (
    <td className="p-0 align-middle">
      <div
        className={cn(
          'flex h-7 items-center gap-1 px-2',
          RECORD_DIVIDER,
          numeric && 'justify-end',
        )}
        title={value}
      >
        <span
          className={cn(
            'min-w-0 truncate',
            // Digits are what you compare down a column; tabular figures line
            // them up across rows.
            numeric && 'tabular-nums',
          )}
          style={{ maxWidth: COLUMN_MAX_WIDTH }}
        >
          {/* A quoted line break is content: it collapses to a space in the
              single-line cell, and the hover title keeps the full value. */}
          {multiline ? value.replace(/\r\n|\r|\n/g, ' ') : value}
        </span>
        {multiline && (
          <span aria-hidden className="shrink-0 select-none text-muted-foreground/60">
            ↵
          </span>
        )}
      </div>
    </td>
  );
}
