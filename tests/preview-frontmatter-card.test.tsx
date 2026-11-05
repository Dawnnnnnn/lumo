// @vitest-environment jsdom
/**
 * The frontmatter card is the rendered view of a manifest that used to leak into
 * the markdown body as a heading.
 *
 * What matters: the fields a skill actually declares are readable without
 * opening the source, the labels stay the YAML keys the user edits, and a plain
 * markdown file with frontmatter gets the same treatment. The `/skill:` chip is
 * only offered where the skill index would actually route it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { FrontmatterCard, isSkillManifest } = await import('@/entrypoints/preview/FrontmatterCard');

const SKILL_PATH = 'skills/ai-sdk/SKILL.md';

const writeText = vi.fn(async () => {});

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  writeText.mockClear();
});

afterEach(() => {
  cleanup();
});

function renderCard(data: Record<string, unknown>, path = SKILL_PATH) {
  return render(<FrontmatterCard data={data} path={path} />);
}

describe('isSkillManifest', () => {
  it('recognises the spec path and nothing else', () => {
    expect(isSkillManifest('skills/ai-sdk/SKILL.md')).toBe(true);
    expect(isSkillManifest('skills/ai-sdk/references/SKILL.md')).toBe(true);
    expect(isSkillManifest('notes/SKILL.md')).toBe(false);
    expect(isSkillManifest('skills/ai-sdk/README.md')).toBe(false);
  });
});

describe('FrontmatterCard', () => {
  it('shows the routing fields, license and the command trigger', async () => {
    renderCard({
      name: 'ai-sdk',
      description: 'Build AI features with the AI SDK.',
      license: 'MIT',
    });

    expect(screen.getByText('ai-sdk')).toBeTruthy();
    expect(screen.getByText('Build AI features with the AI SDK.')).toBeTruthy();
    expect(screen.getByText('MIT')).toBeTruthy();

    const command = screen.getByText('/skill:ai-sdk');
    fireEvent.click(command);
    expect(writeText).toHaveBeenCalledWith('/skill:ai-sdk');
  });

  it('keeps the YAML field names as labels', () => {
    renderCard({
      name: 'pdf-tools',
      compatibility: 'Requires poppler',
      'allowed-tools': 'Bash(git:*) Edit',
    });

    expect(screen.getByText('compatibility')).toBeTruthy();
    expect(screen.getByText('Requires poppler')).toBeTruthy();
    expect(screen.getByText('allowed-tools')).toBeTruthy();
    // The spec allows one whitespace-separated string; both tools become chips.
    expect(screen.getByText('Bash(git:*)')).toBeTruthy();
    expect(screen.getByText('Edit')).toBeTruthy();
  });

  it('flags a skill that is hidden from model invocation', () => {
    renderCard({ name: 'quiet', 'disable-model-invocation': true });

    expect(screen.getByTitle('skills.list.hiddenFromModel')).toBeTruthy();
  });

  it('shows arbitrary metadata and unknown keys by the same rules', () => {
    renderCard({
      name: 'notes',
      metadata: { author: 'Ada', version: 2 },
      tags: ['writing', 'draft'],
      title: 'ignored because name wins',
    });

    expect(screen.getByText('metadata')).toBeTruthy();
    expect(screen.getByText('author')).toBeTruthy();
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.getByText('version')).toBeTruthy();
    expect(screen.getByText('tags')).toBeTruthy();
    expect(screen.getByText('writing')).toBeTruthy();
    // `title` is an alias of `name`, not a second field.
    expect(screen.queryByText('ignored because name wins')).toBeNull();
  });

  it('offers no command outside a skill manifest', () => {
    renderCard({ name: 'ai-sdk', description: 'A note.' }, 'notes/ai-sdk.md');

    expect(screen.queryByText('/skill:ai-sdk')).toBeNull();
  });

  it('renders nothing for an empty mapping', () => {
    const { container } = renderCard({});
    expect(container.innerHTML).toBe('');
  });
});
