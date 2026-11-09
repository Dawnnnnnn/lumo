import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronUp,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { Reorder } from 'motion/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PROVIDER_TYPE_I18N_KEY, PROVIDER_VENDOR_I18N_KEY } from '@/lib/provider-type';
import type { ModelConfig, ProviderConfig } from '@/types';
import { ConfirmDeleteBar } from '@/entrypoints/options/components/ConfirmDeleteBar';
import { ModelRow } from './ModelRow';
import { moveModelById } from './reorder';

/**
 * One provider and its models.
 *
 * Two deliberate departures from the previous accordion:
 *
 * - **Collapsed by default.** With several providers configured, the closed
 *   state keeps the list a scan-friendly index — each card still shows the
 *   model count and key status, so no information is lost. Expanding is one
 *   click away and the models (the actual content) stay out of the way until
 *   someone is actually configuring them.
 * - **Actions in a menu.** Edit / reorder / delete previously sat as four
 *   always-visible icon buttons per card, competing with the provider name.
 *   Collapsed into one trigger, the card header reads as data again.
 */
export function ProviderCard({
  provider,
  isFirst,
  isLast,
  onEdit,
  onDelete,
  onAddModel,
  onEditModel,
  onDeleteModel,
  onMove,
  onReorderModels,
}: {
  provider: ProviderConfig;
  isFirst: boolean;
  isLast: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onAddModel: () => void;
  onEditModel: (model: ModelConfig) => void;
  onDeleteModel: (modelId: string) => void;
  onMove: (delta: number) => void;
  onReorderModels: (models: ModelConfig[]) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  /**
   * Working copy of the model order for the drag interaction.
   *
   * `Reorder.Group` needs to mutate its `values` on every pointer move, which
   * cannot be the persisted array. Keeping the draft here — rather than in the
   * page — scopes it to the card that is actually being dragged.
   *
   * The `syncedFrom` guard is the derived-state-during-render pattern: whenever
   * a new `provider.models` array arrives (an edit, an add, or another tab
   * writing storage), the draft is rebuilt from it. Comparing array identity
   * rather than contents is deliberate — `commit` always produces a fresh array,
   * so a committed drag re-syncs to an identical order and is a no-op, while a
   * genuine outside change still wins.
   */
  const [order, setOrder] = useState<ModelConfig[]>(provider.models);
  const [syncedFrom, setSyncedFrom] = useState(provider.models);
  if (provider.models !== syncedFrom) {
    setSyncedFrom(provider.models);
    setOrder(provider.models);
  }

  const typeLabel = t(
    `options.models.providerTypes.${PROVIDER_TYPE_I18N_KEY[provider.type]}.label`,
  );
  // Shown only for a real vendor: tagging every provider "Custom" would put a
  // badge with no distinguishing power on the default case.
  const vendorLabel =
    provider.vendor && provider.vendor !== 'custom'
      ? t(`options.models.vendors.${PROVIDER_VENDOR_I18N_KEY[provider.vendor]}.label`)
      : null;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex items-start gap-1.5 p-3">
        <CollapsibleTrigger className="min-w-0 flex-1 items-start gap-2.5 rounded-md">
          <ChevronDown
            className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${
              open ? '' : '-rotate-90'
            }`}
            aria-hidden
          />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-sm font-semibold text-foreground">
              {provider.name}
            </span>
            {/* Metadata wraps rather than truncating as a unit, so a narrow
                window drops these onto a second line instead of hiding them. */}
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">{typeLabel}</Badge>
              {vendorLabel && <Badge variant="accent">{vendorLabel}</Badge>}
              <Badge variant={provider.models.length > 0 ? 'default' : 'outline'}>
                {provider.models.length > 0
                  ? t('options.models.modelCount', { count: provider.models.length })
                  : t('options.models.noModels')}
              </Badge>
              {/* A provider without a key fails at request time with an opaque
                  auth error, so surface it here instead. */}
              {!provider.apiKey && (
                <Badge variant="destructive">
                  <KeyRound className="h-2.5 w-2.5" aria-hidden />
                  {t('options.models.apiKeyMissing')}
                </Badge>
              )}
            </span>
          </span>
        </CollapsibleTrigger>

        <Button
          variant="ghost"
          size="sm"
          onClick={onAddModel}
          className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="hidden md:inline">{t('options.models.addModel')}</span>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('options.models.moreActions')}
              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil />
              {t('common.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={isFirst} onSelect={() => onMove(-1)}>
              <ChevronUp />
              {t('options.models.moveUp')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={isLast} onSelect={() => onMove(1)}>
              <ChevronDown />
              {t('options.models.moveDown')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              destructive
              // Radix restores focus to the trigger on close; deferring lets the
              // confirmation bar mount and claim focus after that happens.
              onSelect={() => setTimeout(() => setConfirming(true), 0)}
            >
              <Trash2 />
              {t('common.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ConfirmDeleteBar
        open={confirming}
        message={t('options.models.deleteProviderConfirm', {
          name: provider.name,
          count: provider.models.length,
        })}
        onConfirm={() => {
          setConfirming(false);
          onDelete();
        }}
        onCancel={() => setConfirming(false)}
        className="border-t border-border"
      />

      <CollapsibleContent className="flex flex-col gap-1 border-t border-border p-2">
        {provider.models.length === 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onAddModel}
            className="h-auto justify-start gap-1.5 py-2 text-xs text-muted-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('options.models.addFirstModel')}
          </Button>
        ) : (
          <>
            <Reorder.Group
              axis="y"
              // Driven by local state, not `provider.models`: `onReorder` fires on
              // every frame of a drag, and writing storage that often would
              // thrash `chrome.storage` and every panel watching it. The commit
              // happens once on drag end.
              values={order}
              onReorder={setOrder}
              /*
                Scopes the rows' layout animation to this list.

                `ModelRow` is a `Reorder.Item` with `layout="position"`, and
                motion measures layout against the *viewport*
                (`getBoundingClientRect`). So any change that moved these rows on
                the page at all — adding or removing a model in an earlier
                provider card, which reflows every card below it — looked
                identical to a reorder: motion counter-translated every row by
                the full displacement and animated it back, so untouched cards
                visibly drifted into place.

                `layoutRoot` makes this group the reference frame, so its
                children compare their position *within the list* instead. Both
                props are required: `layoutRoot` is only consulted on a node that
                projects, which `layout` is what establishes. The group itself
                does not animate — motion forces `type: false` and `delay: 0` on
                a layout root, so it snaps to its new position while the rows
                keep sliding for a genuine reorder.
              */
              layout
              layoutRoot
              className="flex flex-col gap-1"
            >
              {order.map((model, index) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  index={index}
                  total={order.length}
                  onEdit={() => onEditModel(model)}
                  onDelete={() => onDeleteModel(model.id)}
                  onMove={(delta) => {
                    // Keyboard moves have no drag-end event, so they commit
                    // immediately.
                    const next = moveModelById(order, model.id, delta);
                    setOrder(next);
                    onReorderModels(next);
                  }}
                  onDragEnd={() => onReorderModels(order)}
                />
              ))}
            </Reorder.Group>
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
