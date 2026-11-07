// @vitest-environment jsdom
/**
 * The `sh` tool card.
 *
 * A shell result is a JSON summary plus optional images. Rendered through the
 * generic tool card it was one opaque JSON blob, hiding the exit code that says
 * whether the command failed at all. These pin the dedicated rendering: the
 * script, stdout and stderr in their own blocks, an exit badge only when the
 * command actually failed, and images kept visible.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { ToolPart } from '@/lib/message-parts';

// Labels are asserted through their i18n keys, so the test does not restate the
// copy and stays valid when the wording changes. `{{code}}` is expanded to keep
// the exit-code assertion meaningful.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { code?: number }) =>
      options?.code === undefined ? key : `${key}:${options.code}`,
  }),
}));

// The preview tab API is browser-only; the card only needs to know which file
// path it hands over when the spill path is clicked.
const openPreview = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('@/lib/file-preview-tab', () => ({ openFilePreview: openPreview }));

const { Tool } = await import('@/components/ai-elements/tool');

interface ShellSummary {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated?: boolean;
  fullOutputPath?: string;
}

function summary(overrides: Partial<ShellSummary> = {}): ShellSummary {
  return { stdout: '', stderr: '', exitCode: 0, ...overrides };
}

function shellPart(
  command: string,
  output: unknown,
  state: 'output-available' | 'output-error' = 'output-available',
): ToolPart {
  return {
    type: 'dynamic-tool',
    toolName: 'sh',
    toolCallId: 'call-1',
    state,
    input: { command },
    ...(state === 'output-available' ? { output } : { errorText: 'boom' }),
  } as unknown as ToolPart;
}

function result(summaryValue: ShellSummary, images: Array<{ data: string; mimeType: string }> = []) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(summaryValue) },
      ...images.map((image) => ({ type: 'image' as const, ...image })),
    ],
    isError: summaryValue.exitCode !== 0,
  };
}

describe('sh tool card', () => {
  it('shows stdout and stderr separately and auto-expands a non-zero exit', () => {
    const { container } = render(
      <Tool
        part={shellPart('seq 1 2', result(summary({ stdout: '1\n2\n', stderr: 'boom\n', exitCode: 2 })))}
        name="sh"
      />,
    );

    expect(container.textContent).toContain('$ seq 1 2');
    expect(container.textContent).toContain('sidebar.tool.stdout');
    expect(container.textContent).toContain('1\n2');
    expect(container.textContent).toContain('sidebar.tool.stderr');
    expect(container.textContent).toContain('boom');
    expect(container.textContent).toContain('sidebar.tool.exitCode:2');
    // The exit code is the only signal that the command failed; the header must
    // not claim the call "completed" while the script exited non-zero.
    expect(container.textContent).toContain('sidebar.tool.error');
    expect(container.textContent).not.toContain('sidebar.tool.completed');
  });

  it('keeps a successful call collapsed, then shows output without an exit badge', () => {
    const { container } = render(
      <Tool part={shellPart('echo hi', result(summary({ stdout: 'hi\n' })))} name="sh" />,
    );

    expect(container.textContent).not.toContain('sidebar.tool.stdout');

    fireEvent.click(container.querySelector('button')!);

    expect(container.textContent).toContain('sidebar.tool.stdout');
    expect(container.textContent).toContain('hi');
    expect(container.textContent).not.toContain('sidebar.tool.exitCode');
    expect(container.textContent).toContain('sidebar.tool.completed');
  });

  it('reports truncated output together with the spill path', () => {
    const { container } = render(
      <Tool
        part={shellPart(
          'seq 1 3000',
          result(
            summary({
              stdout: '1\n2\n',
              truncated: true,
              fullOutputPath: '/tmp/sh-1.txt',
            }),
          ),
        )}
        name="sh"
      />,
    );

    fireEvent.click(container.querySelector('button')!);

    expect(container.textContent).toContain('sidebar.tool.outputTruncated');
    expect(container.textContent).toContain('/tmp/sh-1.txt');
  });

  it('opens the spilled output file when its path is clicked', () => {
    const { container } = render(
      <Tool
        part={shellPart(
          'seq 1 3000',
          result(
            summary({
              stdout: '1\n2\n',
              truncated: true,
              fullOutputPath: '/tmp/sh-1.txt',
            }),
          ),
        )}
        name="sh"
      />,
    );

    fireEvent.click(container.querySelector('button')!);

    const pathButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('/tmp/sh-1.txt'),
    );
    expect(pathButton).toBeTruthy();
    fireEvent.click(pathButton!);

    // The preview addresses the library by store path, without the shell slash.
    expect(openPreview).toHaveBeenCalledWith('tmp/sh-1.txt');
  });

  it('renders an image the script produced', () => {
    const { container } = render(
      <Tool
        part={shellPart(
          'mcp call page.screenshot',
          result(summary({ exitCode: 0 }), [{ data: 'cG5n', mimeType: 'image/png' }]),
        )}
        name="sh"
      />,
    );

    fireEvent.click(container.querySelector('button')!);

    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,cG5n');
  });

  it('reads the SDK JSON wrapper as well as the raw result', () => {
    const output = {
      type: 'json',
      value: result(summary({ stdout: 'wrapped\n' })),
    };
    const { container } = render(<Tool part={shellPart('echo wrapped', output)} name="sh" />);

    fireEvent.click(container.querySelector('button')!);

    expect(container.textContent).toContain('wrapped');
    expect(container.textContent).toContain('sidebar.tool.stdout');
  });

  it('falls back to the generic rendering for an unparsable result', () => {
    const { container } = render(
      <Tool
        part={shellPart('echo hi', {
          content: [{ type: 'text', text: 'not json' }],
          isError: false,
        })}
        name="sh"
      />,
    );

    fireEvent.click(container.querySelector('button')!);

    expect(container.textContent).toContain('not json');
    expect(container.textContent).not.toContain('sidebar.tool.stdout');
  });

  it('keeps the generic error path for a call that threw', () => {
    const { container } = render(<Tool part={shellPart('echo hi', undefined, 'output-error')} name="sh" />);

    expect(container.textContent).toContain('sidebar.tool.error');
    expect(container.textContent).toContain('boom');
  });
});
