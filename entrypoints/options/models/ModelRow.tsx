import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, GripVertical, Image, Pencil, Trash2 } from 'lucide-react';
import { Reorder, useDragControls } from 'motion/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { resolveReasoningEffort } from '@/lib/reasoning-effort';
import type { ModelConfig } from '@/types';
import { ConfirmDeleteBar } from '@/entrypoints/options/components/ConfirmDeleteBar';

/**
 * A single, reorderable model inside a provider card.
 *
 * Dragging is bound to an explicit handle via `useDragControls` rather than to
 * the whole row. The row is a `button` that opens the edit dialog, and making it
 * draggable too would mean every click had to be disambiguated from a drag by
 * distance or time — the usual source of "I clicked and it did nothing" and
 * "I dragged and it opened the editor" complaints.
 *
 * The handle is pointer-only, so ordering is also exposed to the keyboard
 * through arrow keys on the handle itself (`onMove`), keeping the feature usable
 * without a mouse.
 */
export function ModelRow({
  model,
  index,
  total,
  onEdit,
  onDelete,
  onMove,
  onDragEnd,
}: {
  model: ModelConfig;
  /** Position in the list, for the screen-reader announcement. */
  index: number;
  total: number;
  onEdit: () => void;
  onDelete: () => void;
  /** Keyboard reordering: shifts this model by `delta` slots. */
  onMove: (delta: number) => void;
  /** Commits the order once the pointer is released. */
  onDragEnd: () => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragControls = useDragControls();
  // Only a level that actually changes the request is worth a badge: the default
  // is what most rows carry, and labelling every one of them would say nothing.
  const effort = resolveReasoningEffort(model.reasoningEffort);

  return (
    <Reorder.Item
      value={model}
      dragListener={false}
      dragControls={dragControls}
      onDragStart={() => setDragging(true)}
      onDragEnd={() => {
        setDragging(false);
        onDragEnd();
      }}
      // `position` only: animating size would make the row breathe as the list
      // reflows around the dragged item.
      layout="position"
      /*
        The lift is expressed as a CSS class toggled by React state, *not* via
        `whileDrag`.

        `whileDrag` values are animated back to `baseTarget`, which motion seeds
        from `style`/`initial` only. A `boxShadow` that lives in `className` is
        invisible to that mechanism, so `getBaseTarget('boxShadow')` returns
        undefined and the inline shadow motion applied during the drag is left
        on the element — a permanent shadow on any row that was picked up, even
        if it was dropped without moving.

        `zIndex` is omitted for a different reason: `Reorder.Item` already drives
        it internally (`useTransform` → 1 while offset, `unset` at rest), so
        setting it here just fights the primitive.
      */
      className={cn(
        'group/row list-none overflow-hidden rounded-lg border bg-muted/40',
        'transition-[box-shadow,border-color]',
        dragging
          ? 'border-border shadow-lg'
          : 'border-transparent shadow-none hover:border-border',
      )}
    >
      <div className="flex items-center gap-1 pe-1.5">
        <button
          type="button"
          // `onPointerDown` starts the drag; `touch-none` stops the browser from
          // claiming the gesture for scrolling on touch devices first.
          onPointerDown={(event) => dragControls.start(event)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp' && index > 0) {
              event.preventDefault();
              onMove(-1);
            } else if (event.key === 'ArrowDown' && index < total - 1) {
              event.preventDefault();
              onMove(1);
            }
          }}
          aria-label={`${t('options.models.dragToReorder')} — ${model.displayName} (${index + 1}/${total})`}
          className="shrink-0 cursor-grab touch-none rounded-md p-1.5 text-muted-foreground/50 transition-colors hover:text-foreground active:cursor-grabbing group-hover/row:text-muted-foreground"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          onClick={onEdit}
          // `min-w-0` lets the truncating children actually shrink; without it
          // the flex item keeps its content width and pushes the row wider than
          // the narrow layouts allow.
          className="flex min-w-0 flex-1 items-center gap-2 py-2 pe-1 text-start"
        >
          <span className="truncate text-sm font-medium text-foreground">
            {model.displayName}
          </span>
          {/* Hidden below `sm` because the display name is the useful label at
              narrow widths and the raw id is the first thing worth dropping. */}
          <span className="hidden max-w-[45%] shrink-0 truncate font-mono text-[11px] text-muted-foreground sm:inline">
            {model.modelId}
          </span>
          {model.isVision && (
            <Badge variant="accent" title={t('options.models.isVisionDesc')}>
              <Image className="h-2.5 w-2.5" aria-hidden />
              {t('options.models.visionBadge')}
            </Badge>
          )}
          {effort && (
            <Badge title={t('options.models.reasoningEffort')} className="font-mono">
              <Brain className="h-2.5 w-2.5" aria-hidden />
              {effort}
            </Badge>
          )}
        </button>

        <Button
          variant="ghost"
          size="icon"
          aria-label={`${t('common.edit')} ${model.displayName}`}
          onClick={onEdit}
          className="hidden h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 sm:inline-flex"
        >
          <Pencil className="h-3 w-3" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          aria-label={`${t('common.delete')} ${model.displayName}`}
          onClick={() => setConfirming(true)}
          // Always rendered (never `hidden`) so it stays in the tab order;
          // opacity alone hides it visually until the row is engaged.
          className="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <ConfirmDeleteBar
        open={confirming}
        message={t('options.models.deleteModelConfirm', { name: model.displayName })}
        onConfirm={() => {
          setConfirming(false);
          onDelete();
        }}
        onCancel={() => setConfirming(false)}
      />
    </Reorder.Item>
  );
}
