import { useEffect, useState } from 'react';
import { useEvent } from '@/lib/event-bus';
import {
  affectsSkillIndex,
  refreshSkillIndex,
  type Skill,
  type SkillDiagnostic,
} from '@/lib/skills';

/** What the index knows: routable skills, plus everything it refused to route. */
export interface SkillIndexState {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}

const EMPTY: SkillIndexState = { skills: [], diagnostics: [] };

/**
 * Live view of the installed skills.
 *
 * The composer needs the routable half to offer `/skill:<name>`; the options page
 * needs the diagnostics too, because "this skill exists but does nothing" is
 * exactly what someone opens a management screen to find out. One hook serves
 * both and `useSkills` keeps the composer's narrower contract.
 *
 * Reading never blocks the UI: an empty list is a valid state (nothing installed,
 * or storage not readable yet), and the index arrives on the next tick.
 */
export function useSkillIndex(): SkillIndexState {
  const [index, setIndex] = useState<SkillIndexState>(EMPTY);

  const apply = (next: SkillIndexState) => setIndex(next);

  useEffect(() => {
    let cancelled = false;
    void refreshSkillIndex()
      .then((result) => {
        if (!cancelled) apply(result);
      })
      .catch(() => {
        if (!cancelled) apply(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEvent('files:changed', (payload) => {
    if (!affectsSkillIndex(payload.names)) return;
    void refreshSkillIndex()
      .then(apply)
      .catch(() => apply(EMPTY));
  });

  return index;
}

/** The routable skills only. */
export function useSkills(): Skill[] {
  return useSkillIndex().skills;
}
