import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  RESERVE_PRESETS,
  formatReserveAmount,
  isReservePreset,
  parseReserveKey,
  reserveKey,
} from '@/lib/compaction';
import type { ReserveAmount } from '@/types';

interface ReserveFieldProps {
  value: ReserveAmount;
  onChange: (value: ReserveAmount) => void;
}

/**
 * Picks the compaction reserve: a fixed token count or a share of the window.
 *
 * A percentage is the default because it adapts to every model, so the same
 * setting is sensible on a 32K window and on a 1M one. Absolute values pin a
 * fixed headroom when that is what the user wants. A stored value outside the
 * curated list is still shown, so an imported config is never silently rewritten.
 */
export function ReserveField({ value, onChange }: ReserveFieldProps) {
  const { t } = useTranslation();
  const isPreset = isReservePreset(value);

  return (
    <Select
      value={reserveKey(value)}
      onValueChange={(key) => {
        const next = parseReserveKey(key);
        if (next) onChange(next);
      }}
    >
      <SelectTrigger className="w-36" aria-label={t('options.execution.compactionReserve')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {RESERVE_PRESETS.map((preset) => (
          <SelectItem
            key={reserveKey(preset)}
            value={reserveKey(preset)}
            className="font-mono text-xs"
          >
            {formatReserveAmount(preset)}
          </SelectItem>
        ))}
        {!isPreset && (
          <SelectItem value={reserveKey(value)} className="font-mono text-xs">
            {formatReserveAmount(value)}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}
