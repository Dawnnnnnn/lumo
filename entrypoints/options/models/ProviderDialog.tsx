import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  PROVIDER_TYPES,
  PROVIDER_TYPE_I18N_KEY,
  PROVIDER_VENDORS,
  PROVIDER_VENDOR_I18N_KEY,
  providerBaseUrlPlaceholder,
} from '@/lib/provider-type';
import type { ProviderConfig, ProviderType, ProviderVendor } from '@/types';
import {
  hasErrors,
  normalizeProviderDraft,
  validateProvider,
  type ProviderField,
  type ValidationErrors,
} from './validation';

interface ProviderDialogProps {
  /** The draft to edit. `null` closes the dialog. */
  draft: ProviderConfig | null;
  /** Whether `draft` already exists in storage, which selects the title copy. */
  isExisting: boolean;
  /** Persisted providers, for the duplicate-name check. */
  providers: ProviderConfig[];
  onSave: (provider: ProviderConfig) => Promise<void>;
  onClose: () => void;
}

export function ProviderDialog({
  draft,
  isExisting,
  providers,
  onSave,
  onClose,
}: ProviderDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState<ProviderConfig | null>(draft);
  const [errors, setErrors] = useState<ValidationErrors<ProviderField>>({});
  const [revealKey, setRevealKey] = useState(false);
  const [saving, setSaving] = useState(false);

  // Re-seed the local draft whenever a different provider is opened, and reset
  // the transient bits so a previous attempt's errors or a revealed key never
  // leak into the next session.
  useEffect(() => {
    setValue(draft);
    setErrors({});
    setRevealKey(false);
  }, [draft]);

  if (!value) return null;

  /** Patches the draft and clears the touched field's error as the user types. */
  const patch = (changes: Partial<ProviderConfig>, clears?: ProviderField) => {
    setValue({ ...value, ...changes });
    if (clears && errors[clears]) setErrors((prev) => ({ ...prev, [clears]: undefined }));
  };

  const handleSave = async () => {
    const normalized = normalizeProviderDraft(value);
    const found = validateProvider(normalized, providers);
    if (hasErrors(found)) {
      setErrors(found);
      return;
    }
    setSaving(true);
    try {
      await onSave(normalized);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const vendor = value.vendor ?? 'custom';

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        // Radix autofocuses the first focusable node, which would be the close
        // button; aim at the name field instead so typing starts immediately.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const dialog = event.currentTarget as HTMLElement;
          dialog.querySelector<HTMLInputElement>('input')?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {isExisting ? t('options.models.editProvider') : t('options.models.addProvider')}
          </DialogTitle>
          <DialogDescription>{t('options.models.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field
            label={t('options.models.providerName')}
            error={errors.name && t(errors.name)}
            required
          >
            {(props) => (
              <Input
                {...props}
                value={value.name}
                onChange={(e) => patch({ name: e.target.value }, 'name')}
                placeholder={t('options.models.providerNamePlaceholder')}
              />
            )}
          </Field>

          {/* Vendor first: it decides which paths and request headers the
              protocol choice below will actually be spoken to. */}
          <Field label={t('options.models.providerVendor')}>
            {({ id, 'aria-describedby': describedBy }) => (
              <Select
                value={vendor}
                onValueChange={(next) => patch({ vendor: next as ProviderVendor })}
              >
                <SelectTrigger id={id} aria-describedby={describedBy}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_VENDORS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`options.models.vendors.${PROVIDER_VENDOR_I18N_KEY[option]}.label`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>

          {/* The two OpenAI variants hit different endpoints, so the choice
              itself has to distinguish them; the labels do. */}
          <Field label={t('options.models.providerProtocol')}>
            {({ id, 'aria-describedby': describedBy }) => (
              <Select
                value={value.type}
                onValueChange={(next) => patch({ type: next as ProviderType })}
              >
                <SelectTrigger id={id} aria-describedby={describedBy}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(`options.models.providerTypes.${PROVIDER_TYPE_I18N_KEY[type]}.label`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>

          <Field
            label={t('options.models.baseUrl')}
            hint={
              vendor === 'opencode'
                ? t('options.models.baseUrlHintOpencode')
                : vendor === 'magpie'
                  ? t('options.models.baseUrlHintMagpie')
                  : t('options.models.baseUrlHint')
            }
            error={errors.baseUrl && t(errors.baseUrl)}
          >
            {(props) => (
              <Input
                {...props}
                value={value.baseUrl ?? ''}
                onChange={(e) => patch({ baseUrl: e.target.value }, 'baseUrl')}
                placeholder={providerBaseUrlPlaceholder(vendor, value.type)}
                dir="ltr"
                spellCheck={false}
                className="font-mono text-xs"
              />
            )}
          </Field>

          <Field
            label={t('options.models.apiKey')}
            error={errors.apiKey && t(errors.apiKey)}
            required
          >
            {(props) => (
              <div className="relative">
                <Input
                  {...props}
                  type={revealKey ? 'text' : 'password'}
                  value={value.apiKey}
                  onChange={(e) => patch({ apiKey: e.target.value }, 'apiKey')}
                  placeholder={t('options.models.apiKeyPlaceholder')}
                  dir="ltr"
                  spellCheck={false}
                  autoComplete="off"
                  className="pe-9 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setRevealKey((prev) => !prev)}
                  aria-label={t('options.models.apiKey')}
                  aria-pressed={revealKey}
                  className="absolute end-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {revealKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            )}
          </Field>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
