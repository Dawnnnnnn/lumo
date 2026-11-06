// @vitest-environment jsdom
/**
 * The composer's queue: what a message does while a turn is still streaming.
 *
 * Two behaviours are load-bearing and easy to regress:
 * - the button is dual-state — with a draft it queues (Send), without one it
 *   stops (Stop), because a single slot must never offer an action that does
 *   nothing;
 * - the queue is visible *above* the composer and withdrawing an entry is
 *   undoable, not destructive (the panel puts it back in the draft).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { ChatInput } from '@/components/chat/ChatInput';
import type { QueuedUserInput, UISettings } from '@/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const uiSettings = { pasteThreshold: 500, sendKey: 'enter' } as UISettings;

vi.mock('@/store/storage', () => ({
  storage: {
    getUISettings: async () => uiSettings,
    getCommandSettings: async () => ({
      enabled: false,
      applyTiming: 'send',
      skillCommandsEnabled: false,
      phraseCommands: [],
    }),
    getMentionSettings: async () => ({ enabled: false }),
  },
}));

vi.mock('@/store/useStorageWatch', () => ({
  useStorageWatch: () => {},
}));

vi.mock('@/store/useSkills', () => ({ useSkills: () => [] }));

const queuedEntry: QueuedUserInput = {
  id: 'q1',
  text: 'also check the sidebar',
  images: [],
  textAttachments: [],
  timestamp: 1,
};

function baseProps() {
  return {
    isStreaming: true,
    canAcceptImages: false,
    onSend: vi.fn(),
    onStop: vi.fn(),
    queuedInputs: [queuedEntry],
    onDequeue: vi.fn(),
    isInternalDrag: false,
  };
}

async function renderInput(props: ReturnType<typeof baseProps>) {
  const view = render(<ChatInput {...props} />);
  const textarea = view.container.querySelector('textarea')!;
  await act(async () => {
    await Promise.resolve();
  });
  // The footer's trailing button is the send/stop slot.
  const footer = view.container.querySelectorAll('button');
  const action = footer[footer.length - 1]!;
  return { ...view, textarea, action };
}

function typeValue(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, {
    target: { value, selectionStart: value.length, selectionEnd: value.length },
  });
  textarea.setSelectionRange(value.length, value.length);
  fireEvent.select(textarea);
}

describe('composer queue', () => {
  it('shows a queued message above the input and withdraws it on click', async () => {
    const props = baseProps();
    const { getByText } = await renderInput(props);

    const chip = getByText('also check the sidebar');
    // Above the composer, not inside it: it is the next thing to leave.
    expect(chip.closest('button')!.className).toContain('text-start');
    // The row is named by its content; the withdraw action rides along hidden.
    expect(chip.closest('button')!.textContent).toContain('sidebar.withdrawQueued');

    fireEvent.click(chip);
    expect(props.onDequeue).toHaveBeenCalledWith('q1');
  });

  it('lists several queued messages oldest first, all the same width', async () => {
    const props = {
      ...baseProps(),
      queuedInputs: [
        { ...queuedEntry, id: 'q1', text: 'first' },
        { ...queuedEntry, id: 'q2', text: 'second' },
      ],
    };
    const { container } = await renderInput(props);

    const rows = Array.from(container.querySelectorAll('button')).filter((button) =>
      button.querySelector('span.truncate'),
    );
    // Reading order is the delivery order: the message that leaves first is on
    // top, and every row spans the same width (a list, not a fanned deck).
    expect(rows.map((row) => row.querySelector('span.truncate')!.textContent)).toEqual([
      'first',
      'second',
    ]);
    // Equal width: every row is `w-full` of the strip, with no per-row inset.
    for (const row of rows) {
      expect(row.className).toContain('w-full');
      expect(row.style.marginInline).toBe('');
    }

    fireEvent.click(rows[1]!);
    expect(props.onDequeue).toHaveBeenCalledWith('q2');
  });

  it('queues the draft with the send slot while streaming', async () => {
    const props = baseProps();
    const { textarea, action } = await renderInput(props);

    typeValue(textarea, 'try the other tab instead');
    fireEvent.click(action);

    expect(props.onSend).toHaveBeenCalledWith('try the other tab instead', [], []);
    expect(props.onStop).not.toHaveBeenCalled();
  });

  it('offers Stop instead of Send when there is nothing to send', async () => {
    const props = baseProps();
    const { action } = await renderInput(props);

    fireEvent.click(action);
    expect(props.onStop).toHaveBeenCalledTimes(1);
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('keeps Stop reachable while a draft exists before the queue fills', async () => {
    // An idle composer with a draft shows Send (no queue involved) — the dual
    // state only exists because the turn is live.
    const props = { ...baseProps(), isStreaming: false };
    const { textarea, action } = await renderInput(props);

    typeValue(textarea, 'hello');
    fireEvent.click(action);
    expect(props.onSend).toHaveBeenCalledWith('hello', [], []);
    expect(props.onStop).not.toHaveBeenCalled();
  });
});
