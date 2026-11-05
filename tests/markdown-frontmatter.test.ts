/**
 * The preview must not hand a `SKILL.md` manifest to the markdown renderer.
 *
 * A leading `---` block is YAML frontmatter, but a markdown parser reads the
 * closing delimiter as a setext heading underline: the mapping becomes an `<h2>`
 * and the manifest leaks into the document. Splitting happens before rendering,
 * and these tests pin the policy — including the two cases where stripping would
 * be wrong (no block, malformed block).
 */
import { describe, expect, it } from 'vitest';
import { splitMarkdownFrontmatter } from '@/lib/markdown-frontmatter';

describe('splitMarkdownFrontmatter', () => {
  it('separates a skill manifest from its body', () => {
    const text = [
      '---',
      'name: ai-sdk',
      'description: Build AI features with the AI SDK.',
      'license: MIT',
      '---',
      '# AI SDK',
      '',
      'Body text.',
    ].join('\n');

    const { data, body } = splitMarkdownFrontmatter(text);

    expect(data).toEqual({
      name: 'ai-sdk',
      description: 'Build AI features with the AI SDK.',
      license: 'MIT',
    });
    // No delimiter survives into the rendered document, so no setext heading.
    expect(body).not.toContain('---');
    expect(body.startsWith('# AI SDK')).toBe(true);
    expect(body).toContain('Body text.');
  });

  it('leaves a file without frontmatter untouched', () => {
    const text = '# Notes\n\n---\n\nSeparator, not metadata.\n';

    expect(splitMarkdownFrontmatter(text)).toEqual({ data: null, body: text });
  });

  it('strips an empty block without pretending it is metadata', () => {
    const { data, body } = splitMarkdownFrontmatter('---\n---\n# Title\n');

    expect(data).toBeNull();
    expect(body).toBe('# Title\n');
  });

  it('renders malformed frontmatter verbatim instead of hiding it', () => {
    // A parser error must never cost the user the first lines of their file.
    const text = '---\nname: [unclosed\n---\n# Title\n';

    expect(splitMarkdownFrontmatter(text)).toEqual({ data: null, body: text });
  });
});
