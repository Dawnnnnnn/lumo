import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  MAX_STEPS_PRESETS,
  MIN_MAX_STEPS,
  STEPS_NEVER,
  isMaxStepsPreset,
} from '@/lib/max-steps';

/** Sentinel select value; not a step count, so it cannot collide with one. */
const CUSTOM = 'custom';

/**
 * Picks how many tool-loop steps one reply may run before it stops.
 *
 * The presets and a free-form count share one stored number, so the dropdown
 * shows "Custom" exactly when the stored value is not a preset. A typed value is
 * committed on blur or Enter rather than per keystroke: mid-typing "1" of "150"
 * is a valid but wildly different cap, and persisting it would leave a cap the
 * user never asked for in effect if they navigated away right then.
 */
export function MaxStepsField({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  const isPreset = isMaxStepsPreset(value);
  const [isCustom, setIsCustom] = useState(!isPreset);
  const [draft, setDraft] = useState(isPreset ? '' : String(value));

  // The stored value arrives asynchronously, so a custom one has to switch the
  // control into custom mode after the first render. Keyed on `isPreset` rather
  // than on `value` so it cannot fight the draft while the user types: a
  // half-typed number is never committed, hence never changes `value`.
  useEffect(() => {
    if (!isPreset) {
      setIsCustom(true);
      setDraft(String(value));
    }
  }, [isPreset]);

  const handleSelect = (next: string) => {
    if (next === CUSTOM) {
      setIsCustom(true);
      // Seed the box with what is in effect, so leaving it untouched is a no-op.
      // "Never" is stored as 0, which is not a legal custom cap, so seed the
      // lower bound instead of a number the input would immediately reject.
      setDraft(String(value === STEPS_NEVER ? MIN_MAX_STEPS : value));
      return;
    }
    setIsCustom(false);
    onChange(Number(next));
  };

  /** Commits the typed cap, ignoring anything that is not a usable step count. */
  const commitDraft = () => {
    const parsed = Math.trunc(Number(draft));
    if (!Number.isFinite(parsed) || parsed < MIN_MAX_STEPS) {
      // Snap back to what is actually stored rather than silently keeping an
      // unusable number on screen as if it had taken effect.
      setDraft(String(value === STEPS_NEVER ? MIN_MAX_STEPS : value));
      return;
    }
    setDraft(String(parsed));
    if (parsed !== value) onChange(parsed);
  };

  return (
    <div className="flex items-center gap-2">
      {isCustom && (
        <Input
          type="number"
          min={MIN_MAX_STEPS}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitDraft();
            }
          }}
          aria-label={t('options.execution.maxStepsCustom')}
          className="w-24 text-sm"
        />
      )}
      <Select value={isCustom ? CUSTOM : String(value)} onValueChange={handleSelect}>
        <SelectTrigger className="w-40" aria-label={t('options.execution.maxSteps')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MAX_STEPS_PRESETS.map((preset) => (
            <SelectItem key={preset} value={String(preset)}>
              {preset === STEPS_NEVER
                ? t('options.execution.maxStepsNever')
                : t('options.execution.maxStepsCount', { steps: preset })}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM}>{t('options.execution.maxStepsCustom')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
