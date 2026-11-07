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
import { formatContextTokens } from '@/lib/context-window';

/** Sentinel select value; not a token count, so it cannot collide with one. */
const CUSTOM = 'custom';

interface TokenBudgetFieldProps {
  value: number;
  onChange: (value: number) => void;
  /** Offered values, displayed as compact labels (`20K`, `64K`). */
  presets: readonly number[];
  /** Lower bound for a custom value; anything less is treated as a typo. */
  min: number;
  /** Upper clamp, shared with the context-window ceiling. */
  max: number;
  ariaLabel: string;
  /** Placeholder shown in the custom box. */
  placeholder?: string;
}

/**
 * Picks a token budget from presets or a free-form count.
 *
 * Shared by the compaction reserve and keep-recent rows: both are "one stored
 * number, a handful of sensible presets, and a custom escape hatch", and
 * duplicating the commit-on-blur logic twice is how the two would drift.
 * A typed value commits on blur or Enter rather than per keystroke — mid-way
 * through "20000" the box holds a much smaller budget, and persisting it would
 * briefly compact against a number the user never chose.
 */
export function TokenBudgetField({
  value,
  onChange,
  presets,
  min,
  max,
  ariaLabel,
  placeholder,
}: TokenBudgetFieldProps) {
  const { t } = useTranslation();
  const isPreset = presets.includes(value);
  const [isCustom, setIsCustom] = useState(!isPreset);
  const [draft, setDraft] = useState(isPreset ? '' : String(value));

  // A custom value arrives asynchronously (a stored config, an import), so the
  // control has to switch into custom mode after the first render. Keyed on
  // `isPreset` rather than on `value` so it cannot fight the draft mid-typing.
  useEffect(() => {
    if (!isPreset) {
      setIsCustom(true);
      setDraft(String(value));
    }
  }, [isPreset, value]);

  const handleSelect = (next: string) => {
    if (next === CUSTOM) {
      setIsCustom(true);
      // Seed the box with what is in effect, so leaving it untouched is a no-op.
      setDraft(String(value));
      return;
    }
    setIsCustom(false);
    onChange(Number(next));
  };

  /** Commits the typed budget, ignoring anything that is not a usable count. */
  const commitDraft = () => {
    const parsed = Math.trunc(Number(draft));
    if (!Number.isFinite(parsed) || parsed < min) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(parsed, max);
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <div className="flex items-center gap-2">
      {isCustom && (
        <Input
          type="number"
          min={min}
          max={max}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitDraft();
            }
          }}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className="w-24 font-mono text-xs"
        />
      )}
      <Select value={isCustom ? CUSTOM : String(value)} onValueChange={handleSelect}>
        <SelectTrigger className="w-36" aria-label={ariaLabel}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {presets.map((preset) => (
            <SelectItem key={preset} value={String(preset)} className="font-mono text-xs">
              {formatContextTokens(preset)}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM}>{t('options.execution.tokenBudgetCustom')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
