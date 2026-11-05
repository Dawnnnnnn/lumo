import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Pencil, Plus, Terminal, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ConfirmDeleteBar } from '@/entrypoints/options/components/ConfirmDeleteBar';
import { SettingsHeader } from '@/entrypoints/options/components/SettingsHeader';
import { CommandDialog } from '@/entrypoints/options/commands/CommandDialog';
import {
  BUILTIN_COMMANDS,
  builtinCommandDescriptionPath,
  conflictingCommandNames,
  createUserCommand,
  removeUserCommand,
  upsertUserCommand,
  withCommandEnabled,
  type UserCommand,
} from '@/lib/slash-commands';
import { useCommandSettings } from '@/store/useCommands';

/**
 * Options page for slash commands.
 *
 * Two sections, matching the mental model of the feature itself:
 * - Built-ins are shipped behaviour the user can only switch on or off.
 * - Custom commands are phrases the user authors, edits and deletes.
 *
 * Visual language mirrors the MCP page's server lists on purpose: the same
 * `text-sm font-medium` section titles, one rounded card per command, and the
 * same badge treatment (highlighted for built-ins, neutral for custom) so the
 * two settings pages read as one system.
 *
 * Enabling anything with a taken name silently disables the other holders —
 * that rule lives in `lib/slash-commands.ts` and is previewed as an inline note
 * so the toggle never feels like it rewrote a neighbour for no reason.
 */
export function CommandSettingsPage() {
  const { t } = useTranslation();
  const { settings, isLoaded, setSettings } = useCommandSettings();
  const [draft, setDraft] = useState<UserCommand | null>(null);
  const [isExisting, setIsExisting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const disabledBuiltins = useMemo(
    () => new Set(settings.disabledBuiltins),
    [settings.disabledBuiltins],
  );

  const handleToggleEnabled = async (enabled: boolean) => {
    await setSettings({ ...settings, enabled });
  };

  const handleApplyTimingChange = async (value: string) => {
    await setSettings({
      ...settings,
      applyTiming: value === 'select' ? 'select' : 'send',
    });
  };

  const handleToggleBuiltin = async (id: string, enabled: boolean) => {
    await setSettings(withCommandEnabled(settings, { kind: 'builtin', id }, enabled));
  };

  const handleToggleUser = async (id: string, enabled: boolean) => {
    await setSettings(withCommandEnabled(settings, { kind: 'user', id }, enabled));
  };

  const handleSave = async (command: UserCommand) => {
    await setSettings(upsertUserCommand(settings, command));
  };

  const handleDelete = async (id: string) => {
    await setSettings(removeUserCommand(settings, id));
    setDeletingId(null);
  };

  const openCreate = () => {
    setDraft(createUserCommand());
    setIsExisting(false);
  };

  const openEdit = (command: UserCommand) => {
    setDraft({ ...command });
    setIsExisting(true);
  };

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        <span>{t('common.loading')}</span>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <SettingsHeader
        title={t('options.commands.title')}
        description={t('options.commands.description')}
      />

      {/* Master switch, following the system-prompt page's shape: the setting
          that gates the whole feature sits first, above the two lists. The
          lists stay editable while off (arranging commands while parked is
          legitimate), but the composer stops recognising `/` the moment the
          switch flips. */}
      <div className="mb-8 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label className="text-sm">{t('options.commands.enableCommands')}</Label>
          <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
            {t('options.commands.enableCommandsDesc')}
          </p>
        </div>
        <Switch
          checked={settings.enabled}
          onCheckedChange={handleToggleEnabled}
          className="mt-0.5 shrink-0"
          aria-label={t('options.commands.enableCommands')}
        />
      </div>

      {/* When a picked command takes effect. No description, so the label and
          the control sit on one line, vertically centred — same rule as
          `SettingRow` on the other options pages. */}
      <div className="mb-8 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label className="text-sm">{t('options.commands.applyTiming')}</Label>
        </div>
        <Select
          value={settings.applyTiming}
          onValueChange={handleApplyTimingChange}
        >
          <SelectTrigger className="w-40" aria-label={t('options.commands.applyTiming')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="send">{t('options.commands.applyTimingSend')}</SelectItem>
            <SelectItem value="select">{t('options.commands.applyTimingSelect')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Built-in commands — same title treatment as the MCP built-in list. */}
      <section className="mb-8">
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">
          {t('options.commands.builtinSection')}
        </h3>
        <div className="space-y-2">
          {BUILTIN_COMMANDS.map((builtin) => {
            const enabled = !disabledBuiltins.has(builtin.id);
            const conflicts = enabled
              ? []
              : conflictingCommandNames(settings, builtin.name, {
                  kind: 'builtin',
                  id: builtin.id,
                });
            return (
              <CommandCard
                key={builtin.id}
                name={builtin.name}
                description={t(builtinCommandDescriptionPath(builtin.id))}
                badgeHighlighted
                enabled={enabled}
                onToggle={(next) => handleToggleBuiltin(builtin.id, next)}
                conflictNames={conflicts}
              />
            );
          })}

          {/* The `/skill:*` family, listed with the other shipped commands
              because that is what it is: behaviour the user can only switch on
              or off. It sits at the end because it gates a family rather than a
              single action; its row already shows the trigger, so the description
              says what the family is for instead of restating the syntax. */}
          <CommandCard
            name="skill:*"
            description={t('options.commands.skillCommandsDesc')}
            badgeHighlighted
            enabled={settings.skillCommandsEnabled}
            onToggle={(enabled) => void setSettings({ ...settings, skillCommandsEnabled: enabled })}
            conflictNames={[]}
            switchLabel={t('options.commands.skillCommands')}
          />
        </div>
      </section>

      {/* Custom commands — the add button lives on the section header row,
          exactly where the MCP page keeps its "Add server" button. */}
      <section className="mb-6">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium text-muted-foreground">
            {t('options.commands.userSection')}
          </h3>
          <Button size="sm" variant="outline" onClick={openCreate} className="gap-1">
            <Plus className="h-3.5 w-3.5" />
            {t('options.commands.addCommand')}
          </Button>
        </div>

        {settings.userCommands.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
            {t('options.commands.emptyUser')}
          </p>
        ) : (
          <div className="space-y-2">
            {settings.userCommands.map((command) => {
              const conflicts = command.enabled
                ? []
                : conflictingCommandNames(settings, command.name, {
                    kind: 'user',
                    id: command.id,
                  });
              return (
                <div key={command.id} className="overflow-hidden rounded-lg border border-border">
                  <CommandCard
                    name={command.name}
                    description={command.phrase}
                    enabled={command.enabled}
                    onToggle={(next) => handleToggleUser(command.id, next)}
                    conflictNames={conflicts}
                    actions={
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                          onClick={() => openEdit(command)}
                          aria-label={t('common.edit')}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setDeletingId(command.id)}
                          aria-label={t('common.delete')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    }
                  />
                  <ConfirmDeleteBar
                    open={deletingId === command.id}
                    message={t('options.commands.deleteConfirm', { name: command.name })}
                    onConfirm={() => handleDelete(command.id)}
                    onCancel={() => setDeletingId(null)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </section>

      {draft && (
        <CommandDialog
          draft={draft}
          isExisting={isExisting}
          settings={settings}
          onSave={handleSave}
          onClose={() => setDraft(null)}
        />
      )}
    </div>
  );
}

/**
 * One command row, laid out like an MCP server card: leading icon, name and
 * description stacked, a badge, then the switch (and per-row actions for
 * custom commands). Font sizes match the MCP lists verbatim — `text-sm
 * font-medium` for the name, `text-xs` for every piece of metadata.
 */
function CommandCard({
  name,
  description,
  badgeHighlighted,
  enabled,
  onToggle,
  conflictNames,
  actions,
  switchLabel,
}: {
  name: string;
  description: string;
  /** Built-ins get the highlighted icon; custom commands the neutral one. */
  badgeHighlighted?: boolean;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  conflictNames: string[];
  actions?: React.ReactNode;
  /** Accessible name for this row's switch; defaults to the generic "Enabled". */
  switchLabel?: string;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-3">
      <Terminal
        className={`h-4 w-4 shrink-0 ${badgeHighlighted ? 'text-primary' : 'text-muted-foreground'}`}
      />
      <div className="min-w-0 flex-1">
        <span className="block truncate font-medium text-sm text-foreground">/{name}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {description}
        </span>
        {!enabled && conflictNames.length > 0 && (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground/80">
            {t('options.commands.conflictHint', {
              names: conflictNames.map((n) => `/${n}`).join(', '),
            })}
          </span>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        className="shrink-0"
        aria-label={switchLabel ?? t('options.commands.enabled')}
      />
    </div>
  );
}