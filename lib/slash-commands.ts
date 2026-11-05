/**
 * Slash commands — the `/` vocabulary of the chat composer.
 *
 * A command is a *typing shortcut*, not a message: it is recognised in the
 * composer, resolved at send time, and then either expands into text or runs a
 * panel action. Two kinds exist and they are deliberately different in kind:
 *
 * - **Built-in** commands (`/new`, `/exit`) name an action the UI can perform.
 *   They ship with the extension, so their names and behaviour are code, not
 *   data — only whether they are enabled is the user's to store.
 * - **User** commands are phrases. `/fy` → "translate this page" is nothing more
 *   than a text substitution the composer performs on the way out, which is why
 *   they need no runtime hook of any kind.
 *
 * ## Why names are unique only among *enabled* commands
 *
 * A disabled command is inert: it never appears in the picker and never resolves,
 * so two disabled `/fy` entries cannot confuse anything. Enforcing global
 * uniqueness would instead force the user to rename or delete an entry they are
 * merely parking, and would make importing a config fail on a collision with
 * something switched off. So the invariant is narrower and enforced on *write*:
 * enabling a name disables every other holder of it (see `withCommandEnabled`
 * and `upsertUserCommand`). `resolveEnabledCommands` still de-duplicates on read,
 * because a hand-edited or older config can violate the invariant and the picker
 * must never show the same trigger twice.
 *
 * This module is deliberately data-only — no React, no `chrome.*` — so the
 * options page, the composer and the tests all agree on one set of rules.
 */

import { v4 as uuidv4 } from 'uuid';

/** The character that opens a command in the composer. */
export const COMMAND_PREFIX = '/';

/**
 * Upper bound on a trigger's length. Not a technical limit: a trigger long
 * enough to wrap in the picker has stopped being a shortcut.
 */
export const MAX_COMMAND_NAME_LENGTH = 32;

/** Upper bound on a stored phrase, so one entry cannot dominate the quota. */
export const MAX_COMMAND_PHRASE_LENGTH = 4000;

// ---------------------------------------------------------------------------
// Built-in commands
// ---------------------------------------------------------------------------

/**
 * What a built-in command does. The composer never performs these itself — it
 * reports the action and the panel carries it out, because both targets (the
 * conversation, the side panel document) are outside the input box's reach.
 */
export type BuiltinCommandAction = 'new-chat' | 'close-panel' | 'compact';

export interface BuiltinCommandDefinition {
  /** Stable id. Also the i18n key suffix and the default trigger. */
  id: string;
  /** Trigger the user types, without the leading `/`. */
  name: string;
  action: BuiltinCommandAction;
}

/** Shipped commands, in picker order. */
export const BUILTIN_COMMANDS: readonly BuiltinCommandDefinition[] = [
  { id: 'new', name: 'new', action: 'new-chat' },
  { id: 'compact', name: 'compact', action: 'compact' },
  { id: 'exit', name: 'exit', action: 'close-panel' },
];

/** Full i18n path for a built-in command's description. */
export function builtinCommandDescriptionPath(id: string): string {
  return `commands.builtin.${id}`;
}

// ---------------------------------------------------------------------------
// Stored shape
// ---------------------------------------------------------------------------

export interface UserCommand {
  id: string;
  /** Trigger without the leading `/`. */
  name: string;
  /** Text the trigger expands into at send time. */
  phrase: string;
  enabled: boolean;
}

/**
 * When a command's effect happens.
 * - `'send'`: selecting a candidate only completes the trigger; the command
 *   runs when the draft is sent.
 * - `'select'`: selecting a candidate runs it immediately — built-ins act
 *   (new chat, close panel), custom commands expand into the input.
 */
export type CommandApplyTiming = 'send' | 'select';

export interface CommandSettings {
  /**
   * Master switch. When off, no command is recognised: the picker never opens
   * and send-time resolution is a no-op. The lists stay editable so the user
   * can arrange commands while parked.
   */
  enabled: boolean;
  /** When a picked command takes effect. Defaults to `'send'`. */
  applyTiming: CommandApplyTiming;
  /**
   * Whether `/skill:<name>` commands exist at all.
   *
   * A family switch, not a master switch: turning it off leaves `/new`, the
   * user's own phrases and everything else working, and it never touches the
   * skills index the model reads — the shortcut disappears, the capability does
   * not.
   */
  skillCommandsEnabled: boolean;
  /** User-authored phrase commands, in the order the options page shows them. */
  userCommands: UserCommand[];
  /**
   * Built-in ids the user (or a name collision) switched off.
   *
   * Stored as the *exception* rather than as a full record per built-in so a
   * command added in a later release is enabled by default without a migration —
   * the same reasoning as `McpSettings.disabledBuiltins`.
   */
  disabledBuiltins: string[];
}

export const DEFAULT_COMMAND_SETTINGS: CommandSettings = {
  enabled: true,
  applyTiming: 'send',
  skillCommandsEnabled: true,
  userCommands: [],
  disabledBuiltins: [],
};

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Cleans a typed trigger: drops the prefix the user may have typed along with
 * it, and any surrounding whitespace. Casing is preserved for display; matching
 * goes through `commandKey`.
 */
export function normalizeCommandName(raw: string): string {
  return raw.trim().replace(/^\/+/, '').trim();
}

/** Case-insensitive identity of a trigger, for matching and de-duplication. */
export function commandKey(name: string): string {
  return normalizeCommandName(name).toLowerCase();
}

export type CommandNameError =
  | 'nameRequired'
  | 'nameWhitespace'
  | 'nameSlash'
  | 'nameTooLong';

/** i18n key suffix for the first problem with `name`, or `undefined` if valid. */
export function validateCommandName(name: string): CommandNameError | undefined {
  const normalized = normalizeCommandName(name);
  if (normalized.length === 0) return 'nameRequired';
  if (/\s/.test(normalized)) return 'nameWhitespace';
  if (normalized.includes('/')) return 'nameSlash';
  if (normalized.length > MAX_COMMAND_NAME_LENGTH) return 'nameTooLong';
  return undefined;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type ResolvedCommand =
  | {
      kind: 'builtin';
      id: string;
      name: string;
      action: BuiltinCommandAction;
    }
  | {
      kind: 'user';
      id: string;
      name: string;
      phrase: string;
    }
  | {
      /**
       * A skill command (`/skill:<name>`), derived from the installed skills
       * rather than from settings — see `lib/skills/commands.ts`.
       */
      kind: 'skill';
      /** Skill name, which is also the trigger suffix. */
      id: string;
      name: string;
      /** Storage path of the skill's `SKILL.md`. */
      path: string;
      /** Routing description, shown in the picker. */
      description: string;
    };

/**
 * Every command that is live right now, in picker order.
 *
 * Built-ins come first: they are the ones whose behaviour the user cannot read
 * off their own list, so they benefit most from a stable position. Duplicate
 * triggers are dropped rather than merged — see the note at the top of the file.
 */
export function resolveEnabledCommands(
  settings: CommandSettings | undefined,
): ResolvedCommand[] {
  // The master switch gates everything — the composer asks for the enabled
  // list and gets nothing back, so both the picker and send-time resolution
  // agree that `/` is just a slash.
  if (!settings?.enabled) return [];

  const disabled = new Set(settings.disabledBuiltins ?? []);
  const seen = new Set<string>();
  const resolved: ResolvedCommand[] = [];

  const push = (command: ResolvedCommand) => {
    const key = commandKey(command.name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    resolved.push(command);
  };

  for (const builtin of BUILTIN_COMMANDS) {
    if (disabled.has(builtin.id)) continue;
    push({
      kind: 'builtin',
      id: builtin.id,
      name: builtin.name,
      action: builtin.action,
    });
  }

  for (const command of settings?.userCommands ?? []) {
    if (!command.enabled) continue;
    push({
      kind: 'user',
      id: command.id,
      name: command.name,
      phrase: command.phrase,
    });
  }

  return resolved;
}

/**
 * Narrows the command list to what `query` (the text typed after `/`) can still
 * become. A prefix match ranks above a mere substring, so typing `n` offers
 * `/new` before `/translate-notes`; ties keep picker order.
 */
export function filterCommands(
  commands: ResolvedCommand[],
  query: string,
): ResolvedCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands;

  const prefix: ResolvedCommand[] = [];
  const infix: ResolvedCommand[] = [];
  for (const command of commands) {
    const key = commandKey(command.name);
    if (key.startsWith(needle)) prefix.push(command);
    else if (key.includes(needle)) infix.push(command);
  }
  return [...prefix, ...infix];
}

export interface CommandInvocation {
  command: ResolvedCommand;
  /** Everything the user typed after the trigger, verbatim. */
  rest: string;
}

/**
 * Reads the command an input *starts with*, if any.
 *
 * Only position 0 counts: a `/` mid-sentence is a slash, and treating it as a
 * command would silently rewrite ordinary messages. Text after the trigger is
 * returned untouched so `/fy this table` keeps "this table".
 */
export function matchCommandInput(
  text: string,
  commands: ResolvedCommand[],
): CommandInvocation | null {
  if (!text.startsWith(COMMAND_PREFIX)) return null;
  const token = /^\/(\S*)/.exec(text)?.[1] ?? '';
  if (!token) return null;

  const key = commandKey(token);
  const command = commands.find((candidate) => commandKey(candidate.name) === key);
  if (!command) return null;

  // Only spaces and tabs are eaten: a newline after the trigger is layout the
  // user typed on purpose, and swallowing it would reflow their message.
  const rest = text.slice(COMMAND_PREFIX.length + token.length).replace(/^[ \t]+/, '');
  return { command, rest };
}

/**
 * The text a phrase command actually sends: the stored phrase, followed by
 * whatever the user typed after the trigger.
 */
export function expandPhraseCommand(phrase: string, rest: string): string {
  const base = phrase.trim();
  if (!rest) return base;
  if (!base) return rest;
  // `rest` has already lost its leading spaces/tabs, so a leading newline is
  // intentional and joins without an extra space.
  if (/^\s/.test(rest)) return `${base}${rest}`;
  return `${base} ${rest}`;
}

// ---------------------------------------------------------------------------
// Mutations (the enabled-name invariant lives here)
// ---------------------------------------------------------------------------

/** Identifies one command in the settings record. */
export type CommandRef =
  | { kind: 'builtin'; id: string }
  | { kind: 'user'; id: string };

/** The trigger a ref currently holds, or `undefined` if it no longer exists. */
function refName(settings: CommandSettings, ref: CommandRef): string | undefined {
  if (ref.kind === 'builtin') {
    return BUILTIN_COMMANDS.find((builtin) => builtin.id === ref.id)?.name;
  }
  return settings.userCommands.find((command) => command.id === ref.id)?.name;
}

function isSameRef(a: CommandRef, b: CommandRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/**
 * Switches off every *other* enabled command holding `name`.
 *
 * This is the whole of the uniqueness rule: it runs on enable and on save, never
 * on read, so nothing the user is merely parking gets rewritten.
 */
function disableConflicts(
  settings: CommandSettings,
  name: string,
  keep: CommandRef,
): CommandSettings {
  const key = commandKey(name);
  if (!key) return settings;

  const disabledBuiltins = new Set(settings.disabledBuiltins);
  for (const builtin of BUILTIN_COMMANDS) {
    if (isSameRef(keep, { kind: 'builtin', id: builtin.id })) continue;
    if (commandKey(builtin.name) === key) disabledBuiltins.add(builtin.id);
  }

  return {
    ...settings,
    disabledBuiltins: [...disabledBuiltins],
    userCommands: settings.userCommands.map((command) =>
      !isSameRef(keep, { kind: 'user', id: command.id }) &&
      command.enabled &&
      commandKey(command.name) === key
        ? { ...command, enabled: false }
        : command,
    ),
  };
}

/**
 * Every enabled command that would be switched off by enabling `name` on `ref`.
 *
 * Exposed so the options page can say so *before* the toggle flips, rather than
 * silently rearranging a list the user is looking at.
 */
export function conflictingCommandNames(
  settings: CommandSettings,
  name: string,
  ref?: CommandRef,
): string[] {
  const key = commandKey(name);
  if (!key) return [];

  const disabled = new Set(settings.disabledBuiltins);
  const conflicts: string[] = [];

  for (const builtin of BUILTIN_COMMANDS) {
    if (ref && isSameRef(ref, { kind: 'builtin', id: builtin.id })) continue;
    if (disabled.has(builtin.id)) continue;
    if (commandKey(builtin.name) === key) conflicts.push(builtin.name);
  }
  for (const command of settings.userCommands) {
    if (ref && isSameRef(ref, { kind: 'user', id: command.id })) continue;
    if (!command.enabled) continue;
    if (commandKey(command.name) === key) conflicts.push(command.name);
  }

  return conflicts;
}

/** Enables or disables one command, upholding the enabled-name invariant. */
export function withCommandEnabled(
  settings: CommandSettings,
  ref: CommandRef,
  enabled: boolean,
): CommandSettings {
  const name = refName(settings, ref);
  if (name === undefined) return settings;

  let next: CommandSettings =
    ref.kind === 'builtin'
      ? {
          ...settings,
          disabledBuiltins: enabled
            ? settings.disabledBuiltins.filter((id) => id !== ref.id)
            : [...new Set([...settings.disabledBuiltins, ref.id])],
        }
      : {
          ...settings,
          userCommands: settings.userCommands.map((command) =>
            command.id === ref.id ? { ...command, enabled } : command,
          ),
        };

  if (enabled) next = disableConflicts(next, name, ref);
  return next;
}

/**
 * Adds or replaces a user command. An enabled one takes its name over from
 * whoever held it, matching the toggle behaviour exactly — the user should not
 * have to know whether they enabled or renamed to predict the outcome.
 */
export function upsertUserCommand(
  settings: CommandSettings,
  command: UserCommand,
): CommandSettings {
  const normalized: UserCommand = {
    ...command,
    name: normalizeCommandName(command.name),
    phrase: command.phrase.slice(0, MAX_COMMAND_PHRASE_LENGTH),
  };

  const exists = settings.userCommands.some((existing) => existing.id === normalized.id);
  let next: CommandSettings = {
    ...settings,
    userCommands: exists
      ? settings.userCommands.map((existing) =>
          existing.id === normalized.id ? normalized : existing,
        )
      : [...settings.userCommands, normalized],
  };

  if (normalized.enabled) {
    next = disableConflicts(next, normalized.name, { kind: 'user', id: normalized.id });
  }
  return next;
}

export function removeUserCommand(settings: CommandSettings, id: string): CommandSettings {
  return {
    ...settings,
    userCommands: settings.userCommands.filter((command) => command.id !== id),
  };
}

/** A blank user command, ready for the editor. */
export function createUserCommand(): UserCommand {
  return { id: uuidv4(), name: '', phrase: '', enabled: true };
}

// ---------------------------------------------------------------------------
// Normalisation (storage + import)
// ---------------------------------------------------------------------------

/**
 * Coerces a stored or imported record into usable settings.
 *
 * Entries that cannot be a command at all (no trigger, no phrase) are dropped
 * rather than repaired: a nameless command is unreachable, so keeping it would
 * only leave an untypeable row in the options list. Everything else is trimmed
 * and clamped, and a missing id is minted so React keys and refs stay stable.
 */
export function normalizeCommandSettings(raw: unknown): CommandSettings {
  const source = (raw ?? {}) as Partial<CommandSettings>;

  const seenIds = new Set<string>();
  const userCommands: UserCommand[] = [];
  for (const entry of Array.isArray(source.userCommands) ? source.userCommands : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Partial<UserCommand>;
    const name = normalizeCommandName(String(candidate.name ?? ''));
    const phrase = String(candidate.phrase ?? '');
    if (validateCommandName(name) || phrase.trim().length === 0) continue;

    let id = typeof candidate.id === 'string' && candidate.id ? candidate.id : uuidv4();
    if (seenIds.has(id)) id = uuidv4();
    seenIds.add(id);

    userCommands.push({
      id,
      name,
      phrase: phrase.slice(0, MAX_COMMAND_PHRASE_LENGTH),
      enabled: candidate.enabled !== false,
    });
  }

  const builtinIds = new Set(BUILTIN_COMMANDS.map((builtin) => builtin.id));
  const disabledBuiltins = [
    ...new Set(
      (Array.isArray(source.disabledBuiltins) ? source.disabledBuiltins : [])
        .filter((id): id is string => typeof id === 'string')
        // An id this build does not know cannot be re-enabled from the UI, so
        // keeping it would silently suppress a command if the name ever returned.
        .filter((id) => builtinIds.has(id)),
    ),
  ];

  return {
    enabled: source.enabled !== false,
    applyTiming: source.applyTiming === 'select' ? 'select' : 'send',
    // A config written before this switch existed means "as before", which was on.
    skillCommandsEnabled: source.skillCommandsEnabled !== false,
    userCommands,
    disabledBuiltins,
  };
}
