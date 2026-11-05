import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Inline destructive-action confirmation.
 *
 * Replaces `window.confirm`, which rendered an unthemed native dialog and
 * yanked focus out of the page. Collapsing in place keeps the row the user
 * clicked visible, so there is no doubt about what is being deleted. Matches
 * the pattern already used by `McpSettings`.
 */
export function ConfirmDeleteBar({
  open,
  message,
  onConfirm,
  onCancel,
  className,
  style,
}: {
  open: boolean;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
  /** Inline style, used by nested rows to align the message with their name. */
  style?: CSSProperties;
}) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="overflow-hidden"
        >
          <div
            // `role="alert"` rather than `alertdialog`: the bar is non-modal and
            // does not trap focus, so claiming dialog semantics would mislead a
            // screen reader about how to escape it. `alert` still announces the
            // message the moment it appears.
            role="alert"
            className={cn(
              'flex flex-wrap items-center justify-between gap-2 bg-destructive/10 px-3 py-2',
              className,
            )}
          >
            <span className="min-w-0 flex-1 break-words text-xs text-destructive" style={style}>
          {message}
        </span>
            <ConfirmActions onConfirm={onConfirm} onCancel={onCancel} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ConfirmActions({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex shrink-0 gap-1.5">
      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
      <Button
        variant="destructive"
        size="sm"
        className="h-6 px-2 text-xs"
        onClick={onConfirm}
        // Focused on mount so Enter confirms and Tab reaches Cancel — the
        // keyboard affordance the native confirm() provided.
        autoFocus
      >
        {t('common.delete')}
      </Button>
    </div>
  );
}
