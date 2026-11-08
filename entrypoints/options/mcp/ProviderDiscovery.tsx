import { useId, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus } from 'lucide-react';
import type { DiscoveredProvider } from './useProviderDiscovery';

/**
 * Providers the catalog recognised as already installed.
 *
 * No radar, no phases, no "nothing found" shell: a probe answers in
 * milliseconds, so this is a list that appears when it has something to say and
 * renders nothing at all when it does not. The whole block disappears once every
 * catalog entry is configured (the dialog decides that), leaving the plain id
 * field behind.
 *
 * The whole row is the action — picking a discovered provider is one click, like
 * picking a device — and it is the only thing in that corner, so there is no
 * second glyph competing with the plus.
 *
 * The list carries its own caption ("ready to connect") rather than leaving the
 * rows to be read as configured servers: everything here is still one click away
 * from existing, which is exactly what the card list cannot say. The caption is
 * also the region's accessible name, so the block is announced once.
 */
export function ProviderDiscovery({
  found,
  onAdd,
}: {
  found: readonly DiscoveredProvider[];
  onAdd: (extensionId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const captionId = useId();

  const add = async (entry: DiscoveredProvider) => {
    if (pendingKey) return;
    setPendingKey(entry.key);
    try {
      // The row does not remove itself: the parent stores the id, and the dialog
      // closes. If the write fails the row simply stays, which is the truthful
      // state — it is still not configured.
      await onAdd(entry.extensionId);
    } catch {
      // Settings writes are local; the row is unchanged, so there is nothing to
      // report.
    } finally {
      setPendingKey(null);
    }
  };

  if (found.length === 0) return null;

  return (
    <section className="flex flex-col gap-2" aria-labelledby={captionId}>
      <h3 id={captionId} className="text-xs font-medium text-muted-foreground">
        {t('options.mcp.extensions.discovery.label')}
      </h3>
      {/* No inner padding: the rows are the block, so the hover tint reaches the
          border on every side instead of stopping at an invisible inset edge. */}
      <div className="group relative overflow-hidden rounded-lg border border-border/70 bg-muted/20">
        <AnimatePresence initial={false}>
          {found.map((entry) => {
            const pending = pendingKey === entry.key;
            return (
              <motion.button
                key={entry.key}
                type="button"
                layout="position"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                disabled={pendingKey !== null}
                onClick={() => void add(entry)}
                aria-label={t('options.mcp.extensions.discovery.add', { name: entry.provider.name })}
                className="flex w-full items-center gap-2 overflow-hidden px-3 py-2 text-start transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none disabled:opacity-60"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <span className="truncate text-xs font-medium text-foreground">
                  {entry.provider.name}
                </span>
                <span className="ms-auto flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground">
                  {pending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5 opacity-50 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" />
                  )}
                </span>
              </motion.button>
            );
          })}
        </AnimatePresence>
      </div>
    </section>
  );
}
