/**
 * How the preview splits a markdown document into metadata and body.
 *
 * A `SKILL.md` opens with a YAML frontmatter block — and that block *is* the
 * skill's manifest. Handing it to a markdown renderer is not harmless: the
 * closing `---` is read as a setext heading underline, so the whole mapping turns
 * into an `<h2>` and the manifest leaks into the document. The block is removed
 * before rendering and shown as metadata instead.
 *
 * The split is deliberately forgiving. A file whose frontmatter does not parse is
 * rendered exactly as it is: the preview's job is to show the file, so losing its
 * first lines to a parser error would be worse than showing them as markdown.
 * An empty block (`---\n---`) is still stripped — its delimiters were never
 * content — but contributes no card.
 */
import { parseFrontmatter } from '@/lib/skills/frontmatter';

export interface MarkdownDocument {
  /** Parsed frontmatter mapping, or `null` when there is nothing to show. */
  data: Record<string, unknown> | null;
  /** The markdown to render: everything after the frontmatter block. */
  body: string;
}

export function splitMarkdownFrontmatter(text: string): MarkdownDocument {
  const parsed = parseFrontmatter(text);
  if (!parsed.ok) return { data: null, body: text };

  const { data, body } = parsed.document;
  return {
    data: Object.keys(data).length > 0 ? data : null,
    body,
  };
}
