// @vitest-environment jsdom
/**
 * The review step is the only thing standing between a package and the user's
 * installed skills, so its defaults are the behaviour worth pinning:
 *
 * - a new skill starts selected (the common case is "install what I dropped");
 * - an already-installed one starts *unselected* (replacing a tuned capability
 *   must be an act, not a default) but stays selectable, which is how an update
 *   happens;
 * - a skill that cannot be installed is listed, disabled, and explains itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SkillCandidate, SkillInspection } from '@/lib/skills/import';
import type { Skill } from '@/lib/skills/validate';
import type { SkillPackage } from '@/lib/skills/import/types';
import { SkillImportDialog } from '@/entrypoints/options/files/SkillImportDialog';

afterEach(cleanup);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(',')}` : key }),
}));

function skill(name: string): Skill {
  return {
    name,
    description: `${name} does things`,
    disableModelInvocation: false,
    path: `skills/${name}/SKILL.md`,
    dir: `skills/${name}/`,
    updatedAt: 1_700_000_000_000,
  };
}

function candidate(
  name: string,
  overrides: { installed?: boolean; invalid?: boolean } = {},
): SkillCandidate {
  const pkg: SkillPackage | null = overrides.invalid
    ? null
    : {
        installName: name,
        skill: skill(name),
        files: [],
        manifestPath: `skills/${name}/SKILL.md`,
      };
  return {
    id: `pkg.zip::skills/${name}/SKILL.md`,
    sourceLabel: 'pkg.zip',
    discovered: {
      root: `skills/${name}/`,
      manifestPath: `skills/${name}/SKILL.md`,
      manifestText: '',
      files: [],
    },
    plan: {
      pkg,
      diagnostics: overrides.invalid
        ? [
            {
              level: 'error',
              code: 'description-missing',
              message: 'a skill requires a non-empty "description" to be routable',
              path: `skills/${name}/SKILL.md`,
            },
          ]
        : [],
    },
    files: [],
    fileCount: 2,
    size: 2048,
    installed: overrides.installed ?? false,
  };
}

function inspection(candidates: SkillCandidate[]): SkillInspection {
  return { candidates, diagnostics: [], empty: false };
}

function renderDialog(candidates: SkillCandidate[]) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <SkillImportDialog
      inspection={inspection(candidates)}
      importing={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, onCancel };
}

describe('SkillImportDialog', () => {
  it('shows the metadata of every skill in the package', () => {
    renderDialog([candidate('pdf-tools')]);

    expect(screen.getAllByText('pdf-tools').length).toBeGreaterThan(0);
    expect(screen.getByText('/skill:pdf-tools')).toBeTruthy();
    expect(screen.getByText('pdf-tools does things')).toBeTruthy();
    expect(screen.getByText('options.files.totalFiles:2')).toBeTruthy();
  });

  it('preselects a new skill', () => {
    const { onConfirm } = renderDialog([candidate('pdf-tools')]);

    // The dialog is a confirmation, not a form to fill in.
    fireEvent.click(screen.getByText('skills.review.confirm:1'));
    expect(onConfirm).toHaveBeenCalledWith([expect.objectContaining({ id: expect.any(String) })]);
  });

  it('leaves an installed skill unselected, but selectable for an update', () => {
    renderDialog([candidate('pdf-tools', { installed: true })]);

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
    expect(screen.getByText('skills.review.installed')).toBeTruthy();

    // The confirm button offers nothing to import until the choice is made.
    expect(
      (screen.getByText('skills.review.confirm:0') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('lists a skill it cannot install, disabled and with its reason', () => {
    renderDialog([candidate('broken', { invalid: true })]);

    expect(
      screen.getByText('a skill requires a non-empty "description" to be routable'),
    ).toBeTruthy();
    expect(screen.getByText('skills.review.skip')).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    // Nothing selectable means nothing to confirm.
    expect(
      (screen.getByText('skills.review.confirm:0') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('confirms only what was ticked', () => {
    const { onConfirm } = renderDialog([candidate('a'), candidate('b')]);

    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    fireEvent.click(checkboxes[1]!);

    fireEvent.click(screen.getByText('skills.review.confirm:1'));
    expect(onConfirm).toHaveBeenCalledWith([
      expect.objectContaining({ discovered: expect.objectContaining({ root: 'skills/a/' }) }),
    ]);
  });

  it('toggles when the card itself is clicked, not just the checkbox', () => {
    const { onConfirm } = renderDialog([candidate('a'), candidate('b')]);

    // The card is a label around its checkbox, so the browser forwards the click.
    fireEvent.click(screen.getByText('b does things'));
    fireEvent.click(screen.getByText('skills.review.confirm:1'));

    expect(onConfirm).toHaveBeenCalledWith([
      expect.objectContaining({ discovered: expect.objectContaining({ root: 'skills/a/' }) }),
    ]);
  });

  it('does not toggle a card that cannot be installed', () => {
    const { onConfirm } = renderDialog([candidate('broken', { invalid: true })]);

    fireEvent.click(screen.getByText('skills.review.skip'));

    expect(
      (screen.getByText('skills.review.confirm:0') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('can select everything installable at once', () => {
    const { onConfirm } = renderDialog([
      candidate('a'),
      candidate('b', { installed: true }),
      candidate('broken', { invalid: true }),
    ]);

    fireEvent.click(screen.getByText('skills.review.selectAll'));
    fireEvent.click(screen.getByText('skills.review.confirm:2'));

    const [selected] = onConfirm.mock.calls[0]!;
    expect(selected).toHaveLength(2);
  });

  it('cancels without importing anything', () => {
    const { onConfirm, onCancel } = renderDialog([candidate('a')]);

    fireEvent.click(screen.getByText('common.cancel'));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
