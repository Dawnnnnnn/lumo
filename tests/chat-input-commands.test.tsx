// @vitest-environment jsdom
/**
 * Slash commands in the composer: the picker, the keyboard, and send-time
 * expansion. Built on the same render helper shape as the paste tests so the
 * two suites stay interchangeable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { ChatInput } from '@/components/chat/ChatInput';
import type { CommandSettings, UISettings } from '@/types';
import { DEFAULT_COMMAND_SETTINGS } from '@/lib/slash-commands';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const uiSettings = { pasteThreshold: 500, sendKey: 'enter' } as UISettings;
let commandSettings: CommandSettings = { ...DEFAULT_COMMAND_SETTINGS };

vi.mock('@/store/storage', () => ({
  storage: {
    getUISettings: async () => uiSettings,
    getCommandSettings: async () => commandSettings,
    getMentionSettings: async () => ({ enabled: true, tabsEnabled: true, filesEnabled: true }),
  },
}));

vi.mock('@/store/useStorageWatch', () => ({
  useStorageWatch: () => {},
}));

/**
 * Installed skills are read from storage, which this suite does not run. The
 * hook is stubbed at the boundary the composer uses, and the skill file is
 * served from an in-memory map.
 */
let mockSkills: Array<{
  name: string;
  description: string;
  disableModelInvocation: boolean;
  path: string;
  dir: string;
  updatedAt: number;
}> = [];

vi.mock('@/store/useSkills', () => ({
  useSkills: () => mockSkills,
}));

const skillFiles = new Map<string, string>();

vi.mock('@/lib/mcp/file-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp/file-storage')>();
  return {
    ...actual,
    fileStorage: {
      readFileAsText: async (name: string) => skillFiles.get(name) ?? null,
    },
  };
});

const baseProps = {
  isStreaming: false,
  canAcceptImages: false,
  onSend: vi.fn(),
  onStop: vi.fn(),
  onCommand: vi.fn(),
  isInternalDrag: false,
};

async function renderInput(props: Partial<typeof baseProps> = {}) {
  const view = render(<ChatInput {...baseProps} {...props} />);
  const textarea = view.container.querySelector('textarea')!;
  await waitFor(() => expect(textarea).toBeTruthy());
  // Let the async command-settings read settle.
  await act(async () => {
    await Promise.resolve();
  });
  return { ...view, textarea };
}

function typeValue(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
  // `onChange` reads selectionStart off the element; jsdom does not update it
  // from the event target, so set it explicitly and re-sync via select.
  textarea.setSelectionRange(value.length, value.length);
  fireEvent.select(textarea);
}

beforeEach(() => {
  mockSkills = [
    {
      name: 'pdf-tools',
      description: 'Extract text and tables from PDFs.',
      disableModelInvocation: false,
      path: 'skills/pdf-tools/SKILL.md',
      dir: 'skills/pdf-tools/',
      updatedAt: 1,
    },
  ];
  skillFiles.clear();
  skillFiles.set(
    'skills/pdf-tools/SKILL.md',
    '---\nname: pdf-tools\ndescription: Extract text.\n---\n\nSTEER: read references/formats.md first.\n',
  );
  commandSettings = {
    enabled: true,
    applyTiming: 'send',
    skillCommandsEnabled: true,
    disabledBuiltins: [],
    userCommands: [
      { id: 'fy', name: 'fy', phrase: '翻译此页面', enabled: true },
    ],
  };
  baseProps.onSend = vi.fn();
  baseProps.onCommand = vi.fn();
  baseProps.onStop = vi.fn();
});

describe('slash command picker', () => {
  it('opens above the input when the draft starts with /', async () => {
    const { textarea, container } = await renderInput();
    typeValue(textarea, '/');

    await waitFor(() => {
      expect(container.textContent).toContain('/new');
      expect(container.textContent).toContain('/exit');
      expect(container.textContent).toContain('/fy');
    });
  });

  it('filters as the user types', async () => {
    const { textarea, container } = await renderInput();
    typeValue(textarea, '/n');

    await waitFor(() => {
      expect(container.textContent).toContain('/new');
      expect(container.textContent).not.toContain('/exit');
      expect(container.textContent).not.toContain('/fy');
    });
  });

  it('completes on Enter without sending', async () => {
    const onSend = vi.fn();
    const { textarea } = await renderInput({ onSend });
    typeValue(textarea, '/n');

    await waitFor(() => expect(textarea.value).toBe('/n'));
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(textarea.value).toBe('/new '));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('moves with ArrowDown and Tab', async () => {
    const { textarea, container } = await renderInput();
    typeValue(textarea, '/');

    await waitFor(() => expect(container.textContent).toContain('/new'));
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(textarea.value).toBe('/compact '));
  });
});

describe('send-time resolution', () => {
  it('expands a user command and keeps the trailing text', async () => {
    const onSend = vi.fn();
    const { textarea } = await renderInput({ onSend });
    typeValue(textarea, '/fy 这一段');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('翻译此页面 这一段', [], []);
    });
    expect(textarea.value).toBe('');
  });

  it('dispatches a built-in action and keeps the rest of the draft', async () => {
    const onCommand = vi.fn();
    const onSend = vi.fn();
    const { textarea } = await renderInput({ onCommand, onSend });
    typeValue(textarea, '/new keep me');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(onCommand).toHaveBeenCalledWith('new-chat');
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('keep me');
  });

  it('dispatches close-panel for /exit', async () => {
    const onCommand = vi.fn();
    const { textarea } = await renderInput({ onCommand });
    typeValue(textarea, '/exit');
    // First Enter completes the trigger (the picker is open); the second,
    // with the menu closed, sends the resolved command.
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(textarea.value).toBe('/exit '));
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(onCommand).toHaveBeenCalledWith('close-panel');
    });
  });

  it('sends ordinary text unchanged', async () => {
    const onSend = vi.fn();
    const { textarea } = await renderInput({ onSend });
    typeValue(textarea, 'hello');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('hello', [], []);
    });
  });

  it('does not expand a slash that is not at the very start', async () => {
    const onSend = vi.fn();
    const { textarea } = await renderInput({ onSend });
    // Leading space turns the slash into prose: the picker never opened, so
    // send must agree and deliver the draft verbatim.
    typeValue(textarea, ' /fy');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('/fy', [], []);
    });
  });

  it('does nothing at all when the master switch is off', async () => {
    commandSettings = {
      enabled: false,
      applyTiming: 'send',
      skillCommandsEnabled: true,
      disabledBuiltins: [],
      userCommands: [],
    };
    const onSend = vi.fn();
    const onCommand = vi.fn();
    const { textarea, container } = await renderInput({ onSend, onCommand });

    // No picker despite the /:
    typeValue(textarea, '/');
    await waitFor(() => expect(textarea.value).toBe('/'));
    expect(container.textContent).not.toContain('/new');

    // And no resolution on send — the slash is delivered verbatim.
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('/', [], []);
    });
    expect(onCommand).not.toHaveBeenCalled();
  });
});

describe('select timing', () => {
  beforeEach(() => {
    commandSettings = {
      enabled: true,
      applyTiming: 'select',
      skillCommandsEnabled: true,
      disabledBuiltins: [],
      userCommands: [
        { id: 'fy', name: 'fy', phrase: '翻译此页面', enabled: true },
      ],
    };
  });

  it('runs a built-in action the moment the row is picked', async () => {
    const onCommand = vi.fn();
    const onSend = vi.fn();
    const { textarea } = await renderInput({ onCommand, onSend });
    typeValue(textarea, '/n');

    await waitFor(() => expect(textarea.value).toBe('/n'));
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(onCommand).toHaveBeenCalledWith('new-chat');
    });
    // Nothing was sent — the action consumed the row.
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('');
  });

  it('keeps text after the trigger when the built-in acts', async () => {
    const onCommand = vi.fn();
    const { textarea } = await renderInput({ onCommand });
    // A space after the trigger closes the picker, so Enter travels the send
    // path — which must still resolve the built-in and keep the trailing text.
    typeValue(textarea, '/new keep me');

    await waitFor(() => expect(textarea.value).toBe('/new keep me'));
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(onCommand).toHaveBeenCalledWith('new-chat');
    });
    expect(textarea.value).toBe('keep me');
  });

  it('expands a phrase command in place when picked', async () => {
    const onSend = vi.fn();
    const { textarea } = await renderInput({ onSend });
    // Caret sits right after the trigger, so the picker is open and Enter
    // selects — which expands the phrase immediately instead of completing
    // the trigger.
    typeValue(textarea, '/fy');

    await waitFor(() => expect(textarea.value).toBe('/fy'));
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(textarea.value).toBe('翻译此页面'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('still expands through the send path once the picker is closed', async () => {
    const onSend = vi.fn();
    const { textarea } = await renderInput({ onSend });
    typeValue(textarea, '/fy 这一段');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('翻译此页面 这一段', [], []);
    });
  });
});

describe('skill commands', () => {
  it('offers installed skills in the picker', async () => {
    const { textarea, container } = await renderInput();
    typeValue(textarea, '/skill');

    await waitFor(() => {
      expect(container.textContent).toContain('/skill:pdf-tools');
      expect(container.textContent).toContain('Extract text and tables from PDFs.');
    });
  });

  it('sends the skill instructions ahead of the request', async () => {
    const onSend = vi.fn();
    const { textarea } = await renderInput({ onSend });
    typeValue(textarea, '/skill:pdf-tools extract a.pdf');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const [text] = (onSend as unknown as { mock: { calls: string[][] } }).mock.calls[0]!;
    expect(text).toContain('STEER: read references/formats.md first.');
    expect(text).toContain('</skill>');
    expect(text).toContain('extract a.pdf');
    // The frontmatter is metadata, not instructions.
    expect(text).not.toContain('description: Extract text.');
    expect(textarea.value).toBe('');
  });

  it('hides skill commands when the family switch is off, keeping the rest', async () => {
    commandSettings = { ...commandSettings, skillCommandsEnabled: false };
    const onSend = vi.fn();
    const { textarea, container } = await renderInput({ onSend });

    typeValue(textarea, '/skill');
    await waitFor(() => expect(textarea.value).toBe('/skill'));
    expect(container.textContent).not.toContain('/skill:pdf-tools');

    // Built-ins and the user's phrases are untouched by the family switch.
    typeValue(textarea, '/new');
    await waitFor(() => expect(container.textContent).toContain('/new'));

    // And a typed skill trigger is ordinary text on send.
    typeValue(textarea, '/skill:pdf-tools extract a.pdf');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('/skill:pdf-tools extract a.pdf', [], []);
    });
  });

  it('sends the text as typed when the skill disappeared under the draft', async () => {
    skillFiles.clear();
    const onSend = vi.fn();
    const { textarea } = await renderInput({ onSend });
    typeValue(textarea, '/skill:pdf-tools extract a.pdf');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('/skill:pdf-tools extract a.pdf', [], []);
    });
  });
});
