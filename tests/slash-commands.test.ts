import { describe, it, expect } from 'vitest';
import {
  BUILTIN_COMMANDS,
  DEFAULT_COMMAND_SETTINGS,
  commandKey,
  conflictingCommandNames,
  createUserCommand,
  expandPhraseCommand,
  filterCommands,
  matchCommandInput,
  normalizeCommandName,
  normalizeCommandSettings,
  removeUserCommand,
  resolveEnabledCommands,
  upsertUserCommand,
  validateCommandName,
  withCommandEnabled,
  type CommandSettings,
  type UserCommand,
} from '@/lib/slash-commands';

const user = (overrides: Partial<UserCommand> & Pick<UserCommand, 'name'>): UserCommand => ({
  id: overrides.id ?? `u-${overrides.name}`,
  name: overrides.name,
  phrase: overrides.phrase ?? 'phrase',
  enabled: overrides.enabled ?? true,
});

describe('command names', () => {
  it('strips a leading slash the user may have typed', () => {
    expect(normalizeCommandName('/fy')).toBe('fy');
    expect(normalizeCommandName('  /FY  ')).toBe('FY');
  });

  it('rejects empty, spaced, slashed and overlong names', () => {
    expect(validateCommandName('')).toBe('nameRequired');
    expect(validateCommandName('hello world')).toBe('nameWhitespace');
    expect(validateCommandName('a/b')).toBe('nameSlash');
    expect(validateCommandName('x'.repeat(33))).toBe('nameTooLong');
    expect(validateCommandName('fy')).toBeUndefined();
  });

  it('matches case-insensitively', () => {
    expect(commandKey('New')).toBe('new');
  });
});

describe('resolveEnabledCommands', () => {
  it('ships both built-ins enabled by default', () => {
    const resolved = resolveEnabledCommands(DEFAULT_COMMAND_SETTINGS);
    expect(resolved.map((c) => c.name)).toEqual(['new', 'compact', 'exit']);
  });

  it('returns nothing when the master switch is off', () => {
    const settings: CommandSettings = {
      enabled: false,
      applyTiming: 'send',
      skillCommandsEnabled: true,
      disabledBuiltins: [],
      userCommands: [user({ name: 'fy' })],
    };
    expect(resolveEnabledCommands(settings)).toEqual([]);
  });

  it('honours disabledBuiltins and skips disabled user commands', () => {
    const settings: CommandSettings = {
      enabled: true,
      applyTiming: 'send',
      skillCommandsEnabled: true,
      disabledBuiltins: ['exit'],
      userCommands: [user({ name: 'fy' }), user({ name: 'off', enabled: false })],
    };
    const resolved = resolveEnabledCommands(settings);
    expect(resolved.map((c) => c.name)).toEqual(['new', 'compact', 'fy']);
  });

  it('drops a colliding user command in favour of the built-in already listed', () => {
    const settings: CommandSettings = {
      enabled: true,
      applyTiming: 'send',
      skillCommandsEnabled: true,
      disabledBuiltins: [],
      userCommands: [user({ name: 'new', phrase: 'should not win' })],
    };
    const resolved = resolveEnabledCommands(settings);
    expect(resolved).toHaveLength(3);
    expect(resolved[0]).toMatchObject({ kind: 'builtin', name: 'new' });
  });
});

describe('enabled-name uniqueness', () => {
  it('disables a built-in when a user command of the same name is enabled', () => {
    const next = upsertUserCommand(DEFAULT_COMMAND_SETTINGS, user({ name: 'new', phrase: 'hi' }));
    expect(next.disabledBuiltins).toContain('new');
    expect(resolveEnabledCommands(next).map((c) => c.name)).toEqual(['compact', 'exit', 'new']);
    expect(resolveEnabledCommands(next).find((c) => c.name === 'new')).toMatchObject({
      kind: 'user',
      phrase: 'hi',
    });
  });

  it('disables a sibling user command when another of the same name is enabled', () => {
    let settings = upsertUserCommand(DEFAULT_COMMAND_SETTINGS, user({ id: 'a', name: 'fy', phrase: 'A' }));
    settings = upsertUserCommand(settings, user({ id: 'b', name: 'fy', phrase: 'B', enabled: false }));
    settings = withCommandEnabled(settings, { kind: 'user', id: 'b' }, true);
    expect(settings.userCommands.find((c) => c.id === 'a')?.enabled).toBe(false);
    expect(settings.userCommands.find((c) => c.id === 'b')?.enabled).toBe(true);
  });

  it('reports conflicts without mutating', () => {
    const settings = upsertUserCommand(DEFAULT_COMMAND_SETTINGS, user({ name: 'new' }));
    // `new` user command is enabled, so the built-in is already disabled — no
    // further conflict when re-enabling the user one.
    expect(conflictingCommandNames(settings, 'new', { kind: 'user', id: 'u-new' })).toEqual([]);
    // Enabling the built-in would collide with the user command.
    expect(conflictingCommandNames(settings, 'new', { kind: 'builtin', id: 'new' })).toEqual([
      'new',
    ]);
  });

  it('removeUserCommand drops only the named entry', () => {
    let settings = upsertUserCommand(DEFAULT_COMMAND_SETTINGS, user({ id: 'a', name: 'fy' }));
    settings = upsertUserCommand(settings, user({ id: 'b', name: 'sum' }));
    settings = removeUserCommand(settings, 'a');
    expect(settings.userCommands.map((c) => c.id)).toEqual(['b']);
  });
});

describe('match + expand', () => {
  const commands = resolveEnabledCommands({
    enabled: true,
    applyTiming: 'send',
    skillCommandsEnabled: true,
    disabledBuiltins: [],
    userCommands: [user({ name: 'fy', phrase: '翻译此页面' })],
  });

  it('matches a bare built-in', () => {
    expect(matchCommandInput('/new', commands)).toMatchObject({
      command: { kind: 'builtin', action: 'new-chat' },
      rest: '',
    });
  });

  it('keeps trailing text after a user command', () => {
    const hit = matchCommandInput('/fy 这一段', commands);
    expect(hit?.command).toMatchObject({ kind: 'user', name: 'fy' });
    expect(hit?.rest).toBe('这一段');
    expect(expandPhraseCommand('翻译此页面', hit!.rest)).toBe('翻译此页面 这一段');
  });

  it('preserves a leading newline after the trigger', () => {
    const hit = matchCommandInput('/fy\nline', commands);
    expect(hit?.rest).toBe('\nline');
    expect(expandPhraseCommand('翻译此页面', hit!.rest)).toBe('翻译此页面\nline');
  });

  it('ignores a slash that is not at the start', () => {
    expect(matchCommandInput('see /new', commands)).toBeNull();
  });

  it('ignores an unknown trigger', () => {
    expect(matchCommandInput('/nope', commands)).toBeNull();
  });

  it('filters by prefix then infix', () => {
    const list = resolveEnabledCommands({
      enabled: true,
      applyTiming: 'send',
      skillCommandsEnabled: true,
      disabledBuiltins: [],
      userCommands: [
        user({ name: 'note' }),
        user({ name: 'translate' }),
        user({ name: 'renote' }),
      ],
    });
    expect(filterCommands(list, 'no').map((c) => c.name)).toEqual(['note', 'renote']);
    // 't' also infix-matches exit/note/renote; only the prefix match is asserted.
    expect(filterCommands(list, 'trans').map((c) => c.name)).toEqual(['translate']);
  });
});

describe('normalizeCommandSettings', () => {
  it('drops invalid entries and unknown built-in ids', () => {
    const normalized = normalizeCommandSettings({
      disabledBuiltins: ['new', 'ghost', 1],
      userCommands: [
        { id: 'ok', name: 'fy', phrase: 'x', enabled: true },
        { name: '', phrase: 'no' },
        { name: 'bad name', phrase: 'no' },
        { name: 'empty', phrase: '   ' },
        null,
      ],
    });
    expect(normalized.disabledBuiltins).toEqual(['new']);
    expect(normalized.userCommands).toEqual([
      { id: 'ok', name: 'fy', phrase: 'x', enabled: true },
    ]);
  });

  it('mints ids and defaults enabled', () => {
    const normalized = normalizeCommandSettings({
      userCommands: [{ name: 'fy', phrase: 'x' }],
    });
    expect(normalized.userCommands[0]?.id).toBeTruthy();
    expect(normalized.userCommands[0]?.enabled).toBe(true);
  });

  it('defaults apply timing to send and coerces stray values', () => {
    expect(normalizeCommandSettings({}).applyTiming).toBe('send');
    expect(normalizeCommandSettings({ applyTiming: 'select' }).applyTiming).toBe('select');
    expect(normalizeCommandSettings({ applyTiming: 'immediately' }).applyTiming).toBe('send');
  });

  it('keeps the skill-command switch, defaulting to on for older configs', () => {
    // A config written before the switch existed means "as before", which was on.
    expect(normalizeCommandSettings({}).skillCommandsEnabled).toBe(true);
    expect(normalizeCommandSettings({ skillCommandsEnabled: true }).skillCommandsEnabled).toBe(true);
    expect(normalizeCommandSettings({ skillCommandsEnabled: false }).skillCommandsEnabled).toBe(false);
    // Anything that is not `false` is on, so a hand-edited export cannot park
    // the family by accident.
    expect(
      normalizeCommandSettings({ skillCommandsEnabled: 'no' as unknown as boolean })
        .skillCommandsEnabled,
    ).toBe(true);
  });

  it('createUserCommand returns a usable blank', () => {
    const blank = createUserCommand();
    expect(blank.id).toBeTruthy();
    expect(blank.enabled).toBe(true);
    expect(validateCommandName(blank.name)).toBe('nameRequired');
  });

  it('knows every shipped built-in', () => {
    expect(BUILTIN_COMMANDS.map((c) => c.id).sort()).toEqual(['compact', 'exit', 'new']);
  });
});
