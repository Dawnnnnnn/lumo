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
  CONTEXT_WINDOW_PRESETS,
  MIN_CONTEXT_WINDOW,
  formatContextTokens,
  isContextWindowPreset,
  normalizeContextWindow,
} from '@/lib/context-window';
import type { FieldControlProps } from '@/components/ui/field';

/** Sentinel select values; not token counts, so they cannot collide with one. */
const CUSTOM = 'custom';
const UNSET = 'unset';

interface ContextWindowFieldProps {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  /** Id/aria wiring injected by the surrounding `Field`. */
  controlProps?: Pick<FieldControlProps, 'id' | 'aria-describedby' | 'aria-invalid'>;
}

/**
 * Picks a model's declared context window: presets, a free-form count, or
 * nothing at all.
 *
 * The presets and a typed count share one optional number, so the dropdown
 * shows "Custom" exactly when a stored value is not a preset. "Not set" is a
 * first-class option rather than an empty custom box, because absence is
 * meaningful here — it is what hides the composer's context ring.
 *
 * A typed value is committed on blur or Enter rather than per keystroke: mid-way
 * through "128000" the box holds a much smaller number, and persisting it would
 * briefly draw the ring against a window the user never chose.
 */
export function ContextWindowField({ value, onChange, controlProps }: ContextWindowFieldProps) {
  const { t } = useTranslation();
  const isPreset = value !== undefined && isContextWindowPreset(value);
  const [isCustom, setIsCustom] = useState(value !== undefined && !isPreset);
  const [draft, setDraft] = useState(value === undefined ? '' : isPreset ? '' : String(value));

  // A custom value arrives asynchronously (a stored config, an import), so the
  // control has to switch into custom mode after the first render. Keyed on the
  // value rather than on the draft so it cannot fight the user mid-typing: a
  // half-typed number is never committed, hence never changes `value`.
  //
  // Synced both ways: the model dialog also replaces the value from outside
  // (prefilling from a fetched model list), and a custom box left open on the
  // previous model's count would contradict the preset now in effect.
  useEffect(() => {
    if (value !== undefined && !isPreset) {
      setIsCustom(true);
      setDraft(String(value));
    } else {
      setIsCustom(false);
      setDraft('');
    }
  }, [value, isPreset]);

  const handleSelect = (next: string) => {
    if (next === CUSTOM) {
      setIsCustom(true);
      // Seed the box with what is in effect, so leaving it untouched is a no-op.
      setDraft(value === undefined ? '' : String(value));
      return;
    }
    if (next === UNSET) {
      setIsCustom(false);
      setDraft('');
      onChange(undefined);
      return;
    }
    setIsCustom(false);
    onChange(Number(next));
  };

  /** Commits the typed window, ignoring anything that is not a usable count. */
  const commitDraft = () => {
    const parsed = Math.trunc(Number(draft));
    if (!Number.isFinite(parsed) || parsed < MIN_CONTEXT_WINDOW) {
      // Snap back to what is actually stored rather than keeping an unusable
      // number on screen as if it had taken effect.
      setDraft(value === undefined ? '' : String(value));
      return;
    }
    const normalized = normalizeContextWindow(parsed)!;
    setDraft(String(normalized));
    if (normalized !== value) onChange(normalized);
  };

  return (
    <div className="flex items-center gap-2">
      {isCustom && (
        <Input
          type="number"
          min={MIN_CONTEXT_WINDOW}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitDraft();
            }
          }}
          placeholder="128000"
          aria-label={t('options.models.contextWindowCustom')}
          className="w-28 font-mono text-xs"
        />
      )}
      <Select
        value={isCustom ? CUSTOM : value === undefined ? UNSET : String(value)}
        onValueChange={handleSelect}
      >
        <SelectTrigger {...controlProps} className="flex-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CONTEXT_WINDOW_PRESETS.map((preset) => (
            <SelectItem key={preset} value={String(preset)} className="font-mono text-xs">
              {formatContextTokens(preset)}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM}>{t('options.models.contextWindowCustom')}</SelectItem>
          <SelectItem value={UNSET}>{t('options.models.contextWindowUnset')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
