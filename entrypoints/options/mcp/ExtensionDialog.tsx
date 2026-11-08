import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ProviderDiscovery } from './ProviderDiscovery';
import { useProviderDiscovery } from './useProviderDiscovery';
import { validateExtension, type ExtensionField, type ValidationErrors } from './validation';

interface ExtensionDialogProps {
  /** The draft to add. `null` closes the dialog. */
  draft: { id: string } | null;
  /** Providers already configured, so a double add is rejected up front. */
  configured: readonly string[];
  onSave: (id: string) => Promise<void>;
  onClose: () => void;
}

/**
 * Add-extension-service dialog.
 *
 * Two ways in, in the order they are most likely to be used: whatever the scan
 * found already installed (one click, no typing), then the id field for
 * everything the curated catalog does not know about. Both end by closing the
 * dialog, because the card list is the only place that shows what happened —
 * a provider that still needs its own approval says so there, with the button
 * that asks for it.
 *
 * The catalog block disappears entirely once every entry is configured, leaving
 * just the field — no permanently empty recommendation strip.
 */
export function ExtensionDialog({ draft, configured, onSave, onClose }: ExtensionDialogProps) {
  const { t } = useTranslation();
  const [id, setId] = useState('');
  const [errors, setErrors] = useState<ValidationErrors<ExtensionField>>({});
  const [saving, setSaving] = useState(false);

  const discovery = useProviderDiscovery({ open: Boolean(draft), configured });

  useEffect(() => {
    setId(draft?.id ?? '');
    setErrors({});
  }, [draft]);

  if (!draft) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const found = validateExtension(id, configured);
    if (found.id) {
      setErrors(found);
      return;
    }

    setSaving(true);
    try {
      await onSave(id.trim());
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        // Wider than the other add dialog: the discovery block is a full-width
        // field, and a 28rem panel turns its rows into ellipses.
        className="max-w-lg"
        // Title-only dialog: state that instead of shipping filler copy.
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).querySelector<HTMLInputElement>('input')?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('options.mcp.extensions.add')}</DialogTitle>
        </DialogHeader>

        {discovery.found.length > 0 && (
          <ProviderDiscovery
            found={discovery.found}
            onAdd={async (extensionId) => {
              await onSave(extensionId);
              // Same ending as the form below: adding is a single outcome, not a
              // batch. The new card is where the provider's real state appears
              // (including "approval needed"), so closing reveals it instead of
              // leaving the user staring at a list that no longer contains the
              // row they just used.
              onClose();
            }}
          />
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Field
            label={t('options.mcp.extensions.idLabel')}
            error={errors.id && t(errors.id)}
            required
          >
            {(props) => (
              <Input
                {...props}
                value={id}
                onChange={(event) => {
                  setId(event.target.value);
                  if (errors.id) setErrors({});
                }}
                placeholder={t('options.mcp.extensions.idPlaceholder')}
                dir="ltr"
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs"
              />
            )}
          </Field>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('options.mcp.extensions.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
