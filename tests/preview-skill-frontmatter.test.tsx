// @vitest-environment jsdom
/**
 * A `SKILL.md` opened in the preview tab must not render its manifest as prose.
 *
 * The regression this pins is end-to-end: the YAML block used to reach the
 * markdown renderer, where the closing `---` acted as a setext underline and the
 * whole mapping became an `<h2>`. Here the streamdown renderer is stubbed, so the
 * assertion is about what was handed to it — no frontmatter, body intact — and
 * about the card that replaced it. The source pane keeps the raw file, since that
 * is where the user edits the manifest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const { FILE, SKILL_TEXT } = vi.hoisted(() => {
  const file = 'skills/ai-sdk/SKILL.md';
  return {
    FILE: file,
    SKILL_TEXT: [
      '---',
      'name: ai-sdk',
      'description: Build AI features with the AI SDK.',
      'license: MIT',
      'allowed-tools: Bash(git:*) Edit',
      'disable-model-invocation: true',
      '---',
      '# AI SDK',
      '',
      'Body text.',
    ].join('\n'),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => (
    <pre data-testid="streamdown">{children}</pre>
  ),
}));
vi.mock('@streamdown/code', () => ({ code: {} }));
vi.mock('@streamdown/cjk', () => ({ cjk: {} }));
vi.mock('@/entrypoints/preview/EditorView', () => ({
  CodeEditor: ({ content }: { content: string }) => (
    <textarea data-testid="source" readOnly value={content} />
  ),
}));
vi.mock('@/lib/theme', () => ({ ThemeInit: () => null }));
vi.mock('@/lib/font-size', () => ({ FontSizeInit: () => null }));
vi.mock('@/components/direction-provider', () => ({
  AppDirection: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/lib/event-bus', () => ({ useEvent: () => {} }));
vi.mock('@/lib/mcp', () => ({
  fileStorage: {
    getMetadata: async () => ({
      name: FILE,
      mimeType: 'text/markdown',
      size: SKILL_TEXT.length,
      createdAt: 0,
      updatedAt: 0,
    }),
    readFileAsText: async () => SKILL_TEXT,
    listFiles: async () => [],
    getObjectUrl: async () => null,
  },
  getPreviewCategory: () => 'text',
  getLanguageFromMime: () => 'markdown',
  isLikelyTextContent: async () => true,
}));

const { default: App } = await import('@/entrypoints/preview/App');

beforeEach(() => {
  window.history.replaceState(null, '', `/?file=${encodeURIComponent(FILE)}`);
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('preview of a SKILL.md', () => {
  it('renders the manifest as a card instead of a heading', async () => {
    render(<App />);

    const body = await screen.findByTestId('streamdown');

    // The body is all the markdown renderer sees.
    expect(body.textContent).not.toContain('name: ai-sdk');
    expect(body.textContent).not.toContain('disable-model-invocation');
    expect(body.textContent).not.toContain('---');
    expect(body.textContent).toContain('# AI SDK');
    expect(body.textContent).toContain('Body text.');

    // The manifest is readable above it, keys included.
    expect(screen.getByText('ai-sdk')).toBeTruthy();
    expect(screen.getByText('Build AI features with the AI SDK.')).toBeTruthy();
    expect(screen.getByText('license')).toBeTruthy();
    expect(screen.getByText('MIT')).toBeTruthy();
    expect(screen.getByText('allowed-tools')).toBeTruthy();
    expect(screen.getByText('Bash(git:*)')).toBeTruthy();
    expect(screen.getByTitle('skills.list.hiddenFromModel')).toBeTruthy();
    expect(screen.getByText('/skill:ai-sdk')).toBeTruthy();
  });

  it('keeps the raw frontmatter in the source pane', async () => {
    render(<App />);

    // The manifest stays editable where it lives; only rendering splits it.
    await waitFor(() => expect(screen.getByTestId('source')).toBeTruthy());
    const source = screen.getByTestId('source') as HTMLTextAreaElement;
    expect(source.value).toBe(SKILL_TEXT);
  });
});
