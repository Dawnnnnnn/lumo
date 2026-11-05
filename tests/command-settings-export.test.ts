import { describe, it, expect } from 'vitest';
import { STORAGE_FIELDS, EXPORTABLE_KEYS, type StorageSchema } from '@/store/storage-schema';
import { DEFAULT_COMMAND_SETTINGS, normalizeCommandSettings } from '@/lib/slash-commands';

describe('commandSettings in the storage registry', () => {
  it('is exportable and normalized on import', () => {
    expect(EXPORTABLE_KEYS).toContain('commandSettings');
    const raw: unknown = {
      userCommands: [{ name: 'fy', phrase: 'x' }],
    };
    const normalized = normalizeCommandSettings(raw);
    expect(normalized.userCommands[0]?.name).toBe('fy');
  });

  it('carries the skill-command switch through export and import', () => {
    // A parked family has to survive a config round trip, or importing a backup
    // would silently re-enable shortcuts the user had turned off.
    const exported = STORAGE_FIELDS.commandSettings.normalize!({
      ...DEFAULT_COMMAND_SETTINGS,
      skillCommandsEnabled: false,
    });
    expect(exported.skillCommandsEnabled).toBe(false);
  });
});
