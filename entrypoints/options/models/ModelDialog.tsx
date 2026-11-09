import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldToggleRow } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { isOpenAIProvider, resolveModelsUrl } from '@/lib/provider-type';
import type { ModelConfig, ProviderType, ProviderVendor } from '@/types';
import { ContextWindowField } from '@/entrypoints/options/components/ContextWindowField';
import {
  isWireEffort,
  normalizeReasoningEffort,
  reasoningEffortsFor,
} from '@/lib/reasoning-effort';
import { cn } from '@/lib/utils';
import {
  hasErrors,
  normalizeModelDraft,
  validateModel,
  type ModelField,
  type ValidationErrors,
} from './validation';

interface ModelDialogProps {
  /** The draft to edit. `null` closes the dialog. */
  draft: ModelConfig | null;
  /** Whether `draft` already exists, which selects the title copy. */
  isExisting: boolean;
  providerName: string;
  /** API base URL and key of the owning provider. */
  providerBaseUrl: string;
  providerApiKey: string;
  /** Wire protocol of the owning provider. */
  providerType: ProviderType;
  /** Vendor of the owning provider, which decides the model-list endpoint. */
  providerVendor: ProviderVendor;
  /** Models already on this provider, for the duplicate-id check. */
  siblings: ModelConfig[];
  onSave: (model: ModelConfig) => Promise<void>;
  onClose: () => void;
}

export function ModelDialog({
  draft,
  isExisting,
  providerName,
  providerBaseUrl,
  providerApiKey,
  providerType,
  providerVendor,
  siblings,
  onSave,
  onClose,
}: ModelDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState<ModelConfig | null>(draft);
  const [errors, setErrors] = useState<ValidationErrors<ModelField>>({});
  const [saving, setSaving] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[] | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    setValue(draft);
    setErrors({});
  }, [draft]);

  useEffect(() => {
    setModelOptions(null);
    setFetchError(null);
  }, [providerType, providerVendor, providerBaseUrl]);

  const fetchModels = async () => {
    // Resolved rather than composed here: OpenCode serves its list outside the
    // protocol path, so `${baseUrl}/models` would 404 for it.
    const url = resolveModelsUrl({
      vendor: providerVendor,
      type: providerType,
      baseUrl: providerBaseUrl,
    });
    if (!url || !providerApiKey.trim()) {
      setFetchError(t('options.models.fetchModelsConfigError'));
      return;
    }
    setFetchingModels(true);
    setFetchError(null);
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${providerApiKey.trim()}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: unknown = await response.json();
      const data = payload && typeof payload === 'object' && 'data' in payload
        ? (payload as { data?: unknown }).data : undefined;
      const models = Array.isArray(data)
        ? data.map((item) => typeof item === 'string' ? item : item && typeof item === 'object' && 'id' in item
          ? (item as { id?: unknown }).id : item && typeof item === 'object' && 'model_name' in item
            ? (item as { model_name?: unknown }).model_name : undefined)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
      if (!models.length) throw new Error('empty model list');
      setModelOptions([...new Set(models)].sort());
    } catch {
      setFetchError(t('options.models.fetchModelsError'));
      setModelOptions(null);
    } finally {
      setFetchingModels(false);
    }
  };

  if (!value) return null;

  const patch = (changes: Partial<ModelConfig>, clears?: ModelField) => {
    setValue({ ...value, ...changes });
    if (clears && errors[clears]) setErrors((prev) => ({ ...prev, [clears]: undefined }));
  };

  const handleSave = async () => {
    const normalized = normalizeModelDraft(value);
    const found = validateModel(normalized, siblings);
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

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const dialog = event.currentTarget as HTMLElement;
          dialog.querySelector<HTMLInputElement>('input')?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {isExisting ? t('options.models.editModel') : t('options.models.addModel')}
          </DialogTitle>
          {/* Not a DialogDescription: the provider name is an identifier, and
              wiring it to aria-describedby would read as prose guidance. */}
          <p className="truncate text-xs text-muted-foreground">{providerName}</p>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field
            label={t('options.models.modelId')}
            hint={t('options.models.modelIdHint')}
            error={errors.modelId && t(errors.modelId)}
            required
          >
            {(props) => (
              <div className="flex gap-2">
                {modelOptions ? (
                  <Select value={value.modelId} onValueChange={(modelId) => patch({ modelId, displayName: (!value.displayName || value.displayName === value.modelId) ? modelId : value.displayName }, 'modelId')}>
                    <SelectTrigger {...props} className="font-mono text-xs"><SelectValue placeholder={t('options.models.modelIdPlaceholder')} /></SelectTrigger>
                    <SelectContent>{modelOptions.map((model) => <SelectItem key={model} value={model} className="font-mono text-xs">{model}</SelectItem>)}</SelectContent>
                  </Select>
                ) : (
                  <Input
                    {...props}
                    value={value.modelId}
                    onChange={(e) => {
                      const modelId = e.target.value;
                      const shouldMirror = !value.displayName || value.displayName === value.modelId;
                      patch(shouldMirror ? { modelId, displayName: modelId } : { modelId }, 'modelId');
                      if (shouldMirror && errors.displayName) setErrors((prev) => ({ ...prev, displayName: undefined }));
                    }}
                    placeholder={t('options.models.modelIdPlaceholder')}
                    dir="ltr"
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                )}
                {(isOpenAIProvider(providerType) || providerVendor === 'opencode') && (
                  <Button type="button" variant="outline" size="default" onClick={() => void fetchModels()} disabled={fetchingModels} className="h-10 shrink-0 gap-1.5 px-3">
                    {fetchingModels ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    {t('options.models.fetchModels')}
                  </Button>
                )}
              </div>
            )}
          </Field>

          <Field
            label={t('options.models.modelName')}
            error={errors.displayName && t(errors.displayName)}
            required
          >
            {(props) => (
              <Input
                {...props}
                value={value.displayName}
                onChange={(e) => patch({ displayName: e.target.value }, 'displayName')}
                placeholder={t('options.models.modelNamePlaceholder')}
              />
            )}
          </Field>

          <Field label={t('options.models.reasoningEffort')}>
            {({ id, 'aria-describedby': describedBy }) => {
              const selected = normalizeReasoningEffort(value.reasoningEffort);
              const offered = reasoningEffortsFor(providerType);
              // A stored level this provider does not offer is still the user's
              // setting — it becomes valid again if the provider type is switched
              // back — so it is listed rather than dropped. Omitting it would also
              // leave Radix with a value it cannot match and a blank trigger.
              const levels = offered.includes(selected) ? offered : [...offered, selected];
              return (
                <Select
                  // A stored `undefined` means the default, but Radix reads an
                  // undefined value as "uncontrolled" and would show a blank
                  // trigger, so the default is materialised for display only.
                  value={selected}
                  onValueChange={(effort) =>
                    patch({ reasoningEffort: normalizeReasoningEffort(effort) })
                  }
                >
                  {/* Monospace only while a wire value is selected: the default
                      row is prose, and rendering prose in the code face would
                      make it read as something the API accepts. */}
                  <SelectTrigger
                    id={id}
                    aria-describedby={describedBy}
                    className={cn(isWireEffort(selected) && 'font-mono text-xs')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {levels.map((effort) =>
                      isWireEffort(effort) ? (
                        // Shown verbatim: these are the provider's own values, so
                        // a translated label would only obscure what is sent.
                        <SelectItem key={effort} value={effort} className="font-mono text-xs">
                          {effort}
                        </SelectItem>
                      ) : (
                        // The one level that is *not* a wire value — it means
                        // "omit the field" — so it is the one that needs words.
                        <SelectItem key={effort} value={effort}>
                          {t('options.models.reasoningEffortDefault')}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              );
            }}
          </Field>

          <Field label={t('options.models.contextWindow')}>
            {(props) => (
              <ContextWindowField
                value={value.contextWindow}
                onChange={(contextWindow) => patch({ contextWindow })}
                controlProps={props}
              />
            )}
          </Field>

          <FieldToggleRow
            label={t('options.models.isVision')}
            description={t('options.models.isVisionDesc')}
            className="rounded-lg border border-border bg-muted/40 p-3"
          >
            {({ id }) => (
              <Switch
                id={id}
                checked={value.isVision}
                onCheckedChange={(isVision) => patch({ isVision })}
              />
            )}
          </FieldToggleRow>
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
