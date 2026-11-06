import { cn } from '@/lib/utils';

/** One selectable data source in the export and import dialogs. */
export function BackupGroupRow({
  icon,
  label,
  detail,
  checked,
  onToggle,
}: {
  icon: React.ReactNode;
  label: string;
  detail?: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors',
        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
        checked ? 'border-primary/60 bg-primary/5' : 'border-border bg-card hover:bg-accent/40',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
        aria-label={label}
      />
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {detail && (
          <span className="mt-0.5 block text-xs text-muted-foreground">{detail}</span>
        )}
      </span>
    </label>
  );
}
