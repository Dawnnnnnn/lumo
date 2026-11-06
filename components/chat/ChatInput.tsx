import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Square, ImagePlus, X, FileText, Globe, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { SuggestionPopup } from '@/components/ui/suggestion-popup';
import { ContextUsageRing } from '@/components/chat/ContextUsageRing';
import { estimateDraftTokens, type ContextUsage } from '@/lib/context-usage';
import { attachmentLabel } from '@/lib/attachment-display';
import { LUMO_ATTACHMENT_MIME, LUMO_FILE_REF_MIME, LUMO_IMAGE_DRAG_MIME, LUMO_INPUT_CHIP_MIME } from '@/lib/constants';
import { DEFAULT_PASTE_THRESHOLD, shouldAttachPaste } from '@/lib/paste-threshold';
import { createTextAttachment } from '@/lib/text-attachment';
import { setFileRefDragData, parseFileRefContent } from '@/lib/file-drag';
import { findActiveTrigger, type ActiveTrigger } from '@/lib/input-trigger';
import {
  COMMAND_PREFIX,
  builtinCommandDescriptionPath,
  expandPhraseCommand,
  filterCommands,
  matchCommandInput,
  type BuiltinCommandAction,
} from '@/lib/slash-commands';
import { MENTION_PREFIX } from '@/lib/mention-commands';
import { loadSkillCommandText, withSkillCommands } from '@/lib/skills/commands';
import { useSuggestionMenu, type SuggestionOption } from '@/lib/use-suggestion-menu';
import { useMentionResolver } from '@/lib/use-mention-resolver';
import { storage } from '@/store/storage';
import { useEnabledCommands, useCommandSettings } from '@/store/useCommands';
import { useSkills } from '@/store/useSkills';
import { useMentionSettings } from '@/store/useMentions';
import { useStorageWatch } from '@/store/useStorageWatch';
import type { SendKey, TextAttachment, UISettings, QueuedUserInput } from '@/types';

/** Slash commands open only at the very start of the draft. */
const SLASH_TRIGGER = { char: COMMAND_PREFIX, placement: 'input-start' as const };
/** Mentions open at any position — no whitespace required before `@`. */
const MENTION_TRIGGER = { char: MENTION_PREFIX, placement: 'anywhere' as const };

/**
 * How tall the composer may grow before it scrolls instead, in lines.
 *
 * Only the line count is stated here; the pixel bound is derived at measure
 * time (see the auto-grow effect) because both of its inputs are dynamic. The
 * line height follows the user's font-size setting — `lib/font-size.ts` writes
 * `html { font-size }` and the composer is `text-sm`, so a hardcoded 20px gave
 * five lines at the default 16px but only 4.4 at 18px. The window height
 * follows the sidepanel being dragged, so a 10-line cap on a very short panel
 * would crowd out the messages.
 */
const MAX_INPUT_LINES = 10;
/** Ceiling on the growth above, as a fraction of the window height. */
const MAX_INPUT_VIEWPORT_FRACTION = 0.4;
/** Used only if the browser reports `line-height: normal` instead of a length. */
const FALLBACK_LINE_HEIGHT = 20;

export interface ChatInputHandle {
  focus: () => void;
  addImages: (dataUrls: string[]) => void;
  addTextAttachment: (attachment: TextAttachment) => void;
  /**
   * Whether the input holds anything the user would lose. Quick-action routing
   * uses this to avoid landing a generated prompt on top of a draft.
   */
  hasContent: () => boolean;
  /**
   * Writes `text` into the input. An existing draft is kept and the text is
   * appended on a new line, so a quick action can never silently discard what
   * the user typed.
   */
  prefill: (text: string) => void;
}
 
interface ChatInputProps {
  isStreaming: boolean;
  /**
   * Whether this panel can accept image inputs — `true` when the model is a
   * vision model **or** OCR is enabled.  Controls the upload button, paste
   * handler, and drag-and-drop acceptance.
   */
  canAcceptImages: boolean;
  /**
   * Current context-window occupancy for the composer's ring. `null` (or
   * absent) hides the ring — the model has no declared window.
   */
  contextUsage?: ContextUsage | null;
  onSend: (input: string, images: string[], textAttachments: TextAttachment[]) => void;
  onStop: () => void;
  /**
   * Messages waiting to be delivered to the running turn. They stick above the
   * composer — the place the next message would leave from — until the loop
   * takes them.
   */
  queuedInputs?: QueuedUserInput[];
  /**
   * Withdraws one queued message. The panel puts it back in the draft, so the
   * click is undoable rather than destructive.
   */
  onDequeue?: (id: string) => void;
  /**
   * Built-in slash command the composer recognised at send time.
   * The panel owns the actual behaviour (new chat, close panel) because both
   * targets live outside the input box.
   */
  onCommand?: (action: BuiltinCommandAction) => void;
  /** Whether the current drag originates from within the sidebar */
  isInternalDrag: boolean;
  onInternalFileDrop?: (fileName: string) => void;
  onInternalTextDrop?: (text: string) => void;
  /** Receives a re-attached `TextAttachment` drag that carried a full attachment payload. */
  onInternalAttachmentDrop?: (attachment: TextAttachment) => void;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  { isStreaming, canAcceptImages, contextUsage, onSend, onStop, queuedInputs = [], onDequeue, onCommand, isInternalDrag, onInternalFileDrop, onInternalTextDrop, onInternalAttachmentDrop },
  ref,
) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [caret, setCaret] = useState(0);
  const [images, setImages] = useState<string[]>([]);
  const [textAttachments, setTextAttachments] = useState<TextAttachment[]>([]);
  const [isInternalDragOver, setIsInternalDragOver] = useState(false);
  const [sendKey, setSendKey] = useState<SendKey>('enter');
  const [pasteThreshold, setPasteThreshold] = useState(DEFAULT_PASTE_THRESHOLD);
  const internalDragCounterRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Re-measures the composer from outside the auto-grow effect, for the changes
  // that effect cannot observe: a font-size setting that re-scales the line
  // height while the draft is untouched.
  const resizeRef = useRef<(() => void) | null>(null);
  const { settings: commandSettings } = useCommandSettings();
  // Installed skills contribute `/skill:<name>` commands. They are merged here
  // rather than in `resolveEnabledCommands` because they come from storage, not
  // from the command settings the options page edits — but they are still
  // commands, so the master switch gates them too: with commands off, `/` is
  // just a slash and nothing expands.
  const builtinAndUserCommands = useEnabledCommands();
  const skills = useSkills();
  const commands = useMemo(() => {
    // The master switch empties the vocabulary; the skill switch only removes
    // the `/skill:*` family, which is why they are two conditions rather than a
    // third list passed down into `withSkillCommands`.
    if (!commandSettings.enabled) return [];
    if (!commandSettings.skillCommandsEnabled) return builtinAndUserCommands;
    return withSkillCommands(builtinAndUserCommands, skills);
  }, [
    builtinAndUserCommands,
    skills,
    commandSettings.enabled,
    commandSettings.skillCommandsEnabled,
  ]);
  const { settings: mentionSettings } = useMentionSettings();
  const applyTiming = commandSettings.applyTiming;
  // `onCommand` is summoned from inside `resolveSuggestions`' `apply` closures
  // (select-timing), which outlive the render that created them, so it is read
  // through a ref rather than captured.
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;

  useEffect(() => {
    storage.getUISettings().then((settings) => {
      setSendKey(settings.sendKey ?? 'enter');
      setPasteThreshold(settings.pasteThreshold);
    });
  }, []);

  // React live to input-behaviour changes made in the options page.
  useStorageWatch<UISettings>('uiSettings', (newVal) => {
    if (!newVal) return;
    setSendKey(newVal.sendKey ?? 'enter');
    setPasteThreshold(newVal.pasteThreshold);
    // A font-size change moves the line height, and with it the cap, even
    // though the draft did not change.
    resizeRef.current?.();
  });

  // Auto-grow the textarea to fit content, up to MAX_INPUT_LINES rows, after
  // which a scrollbar appears instead of expanding further.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    const resize = () => {
      // Measured, never assumed: the composer is `text-sm`, so its line height
      // scales with the font-size setting and the cap has to move with it.
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || FALLBACK_LINE_HEIGHT;
      const cap = Math.min(
        MAX_INPUT_LINES * lineHeight,
        window.innerHeight * MAX_INPUT_VIEWPORT_FRACTION,
      );

      el.style.maxHeight = `${cap}px`;
      el.style.height = 'auto';
      const next = Math.min(el.scrollHeight, cap);
      if (el.clientHeight !== next) {
        el.style.height = `${next}px`;
      }
    };
    resizeRef.current = resize;

    // Re-measure whenever the content (input) changes.
    resize();

    // Re-measure when the element resizes too. This matters because the chat
    // panel animates in from width 0 on open — the first measurement taken
    // then can be wrong (the placeholder wraps → height pinned at max). It
    // also keeps the height correct when the sidebar/panel width changes and
    // the text re-wraps.
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    // The viewport can get shorter without the textarea's own width changing
    // (dragging the sidepanel's bottom edge), which the observer would not see.
    window.addEventListener('resize', resize);
    return () => {
      resizeRef.current = null;
      observer.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [input]);
 
  // The handle closes over `input`/`images`/`textAttachments`, so it must be
  // rebuilt when they change — otherwise `hasContent` reports a stale draft and
  // quick-action routing would overwrite text the user just typed.
  useImperativeHandle(ref, () => ({
    focus: () => {
      textareaRef.current?.focus();
    },
    addImages: (dataUrls: string[]) => {
      setImages((prev) => [...prev, ...dataUrls]);
    },
    addTextAttachment: (attachment: TextAttachment) => {
      setTextAttachments((prev) => [...prev, attachment]);
    },
    hasContent: () =>
      input.trim().length > 0 || images.length > 0 || textAttachments.length > 0,
    prefill: (text: string) => {
      setInput((prev) => (prev.trim() ? `${prev.trimEnd()}\n${text}` : text));
    },
  }), [input, images, textAttachments]);
 
  /**
   * Paste handling has two independent jobs.
   *
   * An image on the clipboard is read into an image attachment when the model
   * can see images. Text is separate: past `pasteThreshold` characters it
   * becomes a text attachment chip instead of landing in the textarea, so a
   * pasted document does not bury the question the user is still writing. The
   * content still reaches the model — it travels as its own text part.
   *
   * The two never both fire for one event: an image paste carries no meaningful
   * `text/plain` payload, and once an image is consumed the default is already
   * prevented.
   */
  const handlePaste = (e: React.ClipboardEvent) => {
    let handledImage = false;
    if (canAcceptImages) {
      for (const item of e.clipboardData.items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          handledImage = true;
          const file = item.getAsFile();
          if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => {
              const base64 = ev.target?.result as string;
              setImages((prev) => [...prev, base64]);
            };
            reader.readAsDataURL(file);
          }
        }
      }
    }
    if (handledImage) return;

    const text = e.clipboardData.getData('text/plain');
    if (!shouldAttachPaste(text, pasteThreshold)) return;
    e.preventDefault();
    setTextAttachments((prev) => [
      ...prev,
      createTextAttachment(text, 'text/plain', { label: t('sidebar.pastedAttachment') }),
    ]);
  };
 
  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };
 
  const removeTextAttachment = (id: string) => {
    setTextAttachments((prev) => prev.filter((a) => a.id !== id));
  };
 
  /** Hands a finished draft to the turn and clears the composer. */
  const sendDraft = useCallback(
    (text: string) => {
      if (!text && images.length === 0 && textAttachments.length === 0) return;
      onSend(text, images, textAttachments);
      setInput('');
      setCaret(0);
      setImages([]);
      setTextAttachments([]);
    },
    [images, textAttachments, onSend],
  );

  /**
   * Set while a skill command is being expanded. The expansion is a storage
   * read, so without this a second Enter would send the same skill twice.
   */
  const expandingSkillRef = useRef(false);

  /**
   * Resolves a leading slash command before the draft leaves the composer.
   *
   * - Phrase commands expand in place and continue as an ordinary send.
   * - Built-in commands report their action to the panel and leave any trailing
   *   text (and every attachment) in the box, so `/new hello` starts a new chat
   *   with "hello" still ready to edit rather than silently dropping it.
   * - Skill commands load the skill's own instructions and send them ahead of
   *   the user's request, which is how a skill can be used in a conversation
   *   that is already running.
   */
  const handleSend = () => {
    // Commands are recognised only when the draft *starts* with the trigger —
    // the same rule the picker uses, so send-time and the popup can never
    // disagree about whether a `/` means something. Leading whitespace turns
    // the slash into prose and the whole draft is sent verbatim.
    const invocation = matchCommandInput(input, commands);

    if (invocation?.command.kind === 'builtin') {
      onCommand?.(invocation.command.action);
      // Keep the rest of the draft (and every attachment) — only the trigger is
      // consumed. `/exit` with trailing text still closes the panel; the text is
      // moot either way, but preserving it costs nothing and keeps the rule one.
      setInput(invocation.rest);
      setCaret(invocation.rest.length);
      return;
    }

    if (invocation?.command.kind === 'skill') {
      if (expandingSkillRef.current) return;
      expandingSkillRef.current = true;
      const { command, rest } = invocation;
      void loadSkillCommandText(command, rest)
        .then(sendDraft)
        .finally(() => {
          expandingSkillRef.current = false;
        });
      return;
    }

    const text =
      invocation?.command.kind === 'user'
        ? expandPhraseCommand(invocation.command.phrase, invocation.rest)
        : input.trim();

    sendDraft(text);
  };

  // ─── Mention resolver ──────────────────────────────────────────────────
  const addMentionAttachment = useCallback((attachment: TextAttachment) => {
    setTextAttachments((prev) => [...prev, attachment]);
  }, []);

  // Detect whether a `@` trigger is currently active so the resolver knows
  // when to fetch fresh data (inactive → active = new session).
  const mentionTriggerActive = useMemo(
    () => {
      if (!mentionSettings.enabled) return false;
      const trigger = findActiveTrigger(input, caret, [MENTION_TRIGGER]);
      return trigger !== null;
    },
    [input, caret, mentionSettings.enabled],
  );

  const resolveMentions = useMentionResolver({
    settings: mentionSettings,
    addAttachment: addMentionAttachment,
    triggerActive: mentionTriggerActive,
  });

  // ─── Slash-command suggestion menu ──────────────────────────────────────
  const resolveSuggestions = useCallback(
    (trigger: ActiveTrigger): SuggestionOption[] => {
      if (trigger.char === MENTION_PREFIX) return resolveMentions(trigger);
      if (trigger.char !== COMMAND_PREFIX) return [];
      return filterCommands(commands, trigger.query).map((command) => {
        const base = {
          id: `${command.kind}:${command.id}`,
          label: `${COMMAND_PREFIX}${command.name}`,
          description:
            command.kind === 'builtin'
              ? t(builtinCommandDescriptionPath(command.id))
              : command.kind === 'skill'
                ? command.description
                : command.phrase,
          badge:
            command.kind === 'builtin'
              ? t('commands.badge.builtin')
              : command.kind === 'skill'
                ? t('commands.badge.skill')
                : t('commands.badge.user'),
        };

        // 'select' timing: picking the row runs the command right away. The
        // built-in acts immediately; the phrase command expands in place,
        // keeping whatever the user typed after the trigger. The `apply`
        // closure receives the live value because the query is not enough to
        // know the trailing text at resolve time.
        // A skill expands to a storage read, so it can never run inside this
        // synchronous `apply`. Selecting the row completes the trigger and the
        // expansion happens on send, exactly like 'send' timing.
        if (applyTiming === 'select' && command.kind !== 'skill') {
          return {
            ...base,
            insertText: '',
            apply: (value, active) => {
              const rest = value.slice(active.end);
              if (command.kind === 'builtin') {
                onCommandRef.current?.(command.action);
                return { value: rest, caret: rest.length };
              }
              const text = expandPhraseCommand(command.phrase, rest);
              return { value: text, caret: text.length };
            },
          };
        }

        // 'send' timing: the row only completes the trigger; the command is
        // resolved when the draft is sent.
        return {
          ...base,
          // Trailing space so the user can keep typing the rest of the message.
          insertText: `${COMMAND_PREFIX}${command.name} `,
        };
      });
    },
    [commands, t, applyTiming, resolveMentions],
  );

  const applySuggestion = useCallback((next: { value: string; caret: number }) => {
    setInput(next.value);
    setCaret(next.caret);
    // Programmatic value writes do not move the native caret; place it after
    // React has committed the new value so the next keystroke lands correctly.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  }, []);

  // Build triggers array: always include slash; include mention if enabled.
  const triggers = useMemo(
    () =>
      mentionSettings.enabled
        ? [SLASH_TRIGGER, MENTION_TRIGGER]
        : [SLASH_TRIGGER],
    [mentionSettings.enabled],
  );

  const suggestions = useSuggestionMenu({
    value: input,
    caret,
    triggers,
    resolve: resolveSuggestions,
    onApply: applySuggestion,
  });

  const syncCaret = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    setCaret(el.selectionStart ?? 0);
  }, []);
 
  /**
   * Send key behavior follows the `sendKey` UI setting:
   * - `'enter'`: Enter (no modifier) sends; any modifier+Enter inserts a newline.
   * - `'meta-enter'`: any modifier+Enter sends (Ctrl/Alt/Shift on Windows,
   *   ⌘/⌥/⇧ on macOS); plain Enter inserts a newline.
   *
   * FIX: Ignore Enter while an IME (input method) is composing.
   * - e.nativeEvent.isComposing === true  -> IME composition is in progress
   * - e.nativeEvent.keyCode === 229       -> legacy browsers that don't expose isComposing
   *
   * When composing, the Enter key is used to confirm/commit the candidate word and
   * should ONLY commit the composition to the input, not trigger a send.
   */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Skip if the event originates from an IME composition session
    const nativeEvent = e.nativeEvent;
    if (nativeEvent.isComposing || nativeEvent.keyCode === 229) {
      return;
    }

    // Suggestion navigation owns the shared keys while the menu is open, so
    // bare Enter selects a candidate instead of sending the draft.
    if (suggestions.onKeyDown(e)) return;

    if (e.key !== 'Enter') return;

    const hasModifier = e.shiftKey || e.ctrlKey || e.altKey || e.metaKey;

    if (sendKey === 'enter') {
      // Enter sends; any modifier+Enter inserts a newline.
      // We must explicitly insert \n at cursor for Ctrl/Alt+Enter since the
      // browser default only guarantees a newline for Shift+Enter.
      if (hasModifier) {
        e.preventDefault();
        const el = textareaRef.current;
        if (!el) return;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const newValue = input.slice(0, start) + '\n' + input.slice(end);
        // Direct DOM mutation first so the browser applies native scroll to cursor.
        el.value = newValue;
        el.selectionStart = el.selectionEnd = start + 1;
        // Sync React state so it stays in control.
        setInput(newValue);
        // Programmatic value assignment doesn't trigger native auto-scroll,
        // so we manually scroll to keep the cursor visible.
        const cursorRatio = (start + 1) / newValue.length;
        el.scrollTop = cursorRatio * (el.scrollHeight - el.clientHeight);
        return;
      }
      e.preventDefault();
      handleSend();
      return;
    }

    // meta-enter mode: any modifier+Enter sends; plain Enter inserts a newline.
    if (!hasModifier) return;
    e.preventDefault();
    handleSend();
  };
 
  const handleImageUpload = () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.multiple = true;
    inp.onchange = (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files) {
        Array.from(files).forEach((file) => {
          const reader = new FileReader();
          reader.onload = (ev) => {
            setImages((prev) => [...prev, ev.target?.result as string]);
          };
          reader.readAsDataURL(file);
        });
      }
    };
    inp.click();
  };

  const hasAttachments = images.length > 0 || textAttachments.length > 0;
  /**
   * Anything the send button would hand over. Also the button's dual state: an
   * empty draft during a turn means the only useful action is Stop, so that slot
   * becomes Stop; with a draft there is something to queue, so it stays Send.
   */
  const hasDraft = hasAttachments || input.trim().length > 0;

  const queueScrollRef = useRef<HTMLDivElement>(null);
  /**
   * The newest row lands at the bottom of the strip, which may be scrolled out of
   * view once the queue exceeds its cap. Follow it, so the message the user just
   * wrote is always the one they can see.
   */
  useEffect(() => {
    const el = queueScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [queuedInputs.length]);

  // ─── Drag sources (attachment chips → another panel's input) ─────────────
  // A chip picked up here can land in any visible panel's input box (or the
  // same one), mirroring the payloads `MessageBubble` writes so the receiving
  // `handleInputDrop` re-attaches it exactly as it was.
  const handleImageDragStart = useCallback((e: React.DragEvent, img: string) => {
    e.dataTransfer.setData(LUMO_IMAGE_DRAG_MIME, img);
    e.dataTransfer.setData(LUMO_INPUT_CHIP_MIME, '1');
    e.dataTransfer.setData('text/html', `<img src="${img}" />`);
    e.dataTransfer.setData('text/plain', img);
    // copyMove so an input-box drop can relocate the chip (dropEffect 'move')
    // while a drop to the OS or another tab still copies.
    e.dataTransfer.effectAllowed = 'copyMove';
  }, []);

  const handleAttachmentDragStart = useCallback(
    (e: React.DragEvent, attachment: TextAttachment) => {
      e.dataTransfer.setData(LUMO_ATTACHMENT_MIME, JSON.stringify(attachment));
      e.dataTransfer.setData(LUMO_INPUT_CHIP_MIME, '1');
      if (attachment.kind === 'file-ref') {
        setFileRefDragData(
          e.dataTransfer,
          parseFileRefContent(attachment.content) ?? attachment.preview,
        );
      } else {
        if (attachment.mediaType === 'text/html') {
          e.dataTransfer.setData('text/html', attachment.content);
        }
        e.dataTransfer.setData('text/plain', attachment.content);
      }
      // Overrides the 'copy' set inside setFileRefDragData; see handleImageDragStart.
      e.dataTransfer.effectAllowed = 'copyMove';
    },
    [],
  );

  // ─── Internal drag-and-drop (from within the sidebar) ────────────────────
  const handleInputDragEnter = useCallback((e: React.DragEvent) => {
    if (!isInternalDrag) return;
    e.preventDefault();
    e.stopPropagation();
    internalDragCounterRef.current += 1;
    if (internalDragCounterRef.current === 1) {
      setIsInternalDragOver(true);
    }
  }, [isInternalDrag]);
 
  const handleInputDragLeave = useCallback((e: React.DragEvent) => {
    if (!isInternalDrag) return;
    e.preventDefault();
    e.stopPropagation();
    internalDragCounterRef.current -= 1;
    if (internalDragCounterRef.current === 0) {
      setIsInternalDragOver(false);
    }
  }, [isInternalDrag]);
 
  const handleInputDragOver = useCallback((e: React.DragEvent) => {
    if (!isInternalDrag) return;
    e.preventDefault();
    e.stopPropagation();
    // A drag that starts from an input-box chip is a *move*: the source chip is
    // removed on dragend when the drop is accepted, so dragging an attachment
    // between panels relocates it rather than duplicating it. Everything else
    // (a transcript card, a file-list row) stays a copy — the source survives.
    // Only chips advertise the marker, so the two coexist without the browser
    // cancelling a drop over an effectAllowed/dropEffect mismatch.
    const types = Array.from(e.dataTransfer.types);
    const isInputChip = types.includes(LUMO_INPUT_CHIP_MIME);
    const hasImage = types.includes(LUMO_IMAGE_DRAG_MIME);
    // An image can only be accepted by a vision panel; otherwise degrade to a
    // copy so the source chip does not vanish without landing anywhere.
    const degradeToCopy = hasImage && !canAcceptImages;
    e.dataTransfer.dropEffect = isInputChip && !degradeToCopy ? 'move' : 'copy';
  }, [isInternalDrag, canAcceptImages]);

  /** Removes the source chip once a move-drop has been accepted by a target. */
  const handleChipDragEnd = useCallback((e: React.DragEvent, onRemove: () => void) => {
    if (e.dataTransfer.dropEffect === 'move') onRemove();
  }, []);
 
  const handleInputDrop = useCallback((e: React.DragEvent) => {
    if (!isInternalDrag) return;
    e.preventDefault();
    e.stopPropagation();
    internalDragCounterRef.current = 0;
    setIsInternalDragOver(false);
 
    // Check for image drag (from chat history image attachments) first
    const imageDataUrl = e.dataTransfer.getData(LUMO_IMAGE_DRAG_MIME);
    if (imageDataUrl) {
      if (canAcceptImages) {
        setImages((prev) => [...prev, imageDataUrl]);
      }
      return;
    }

    // Check for a full attachment payload next. Any `TextAttachment.kind`
    // (page-context, file-ref, plain text, html, ...) round-trips through this
    // single path with kind/label/mediaType preserved.
    const attachmentJson = e.dataTransfer.getData(LUMO_ATTACHMENT_MIME);
    if (attachmentJson && onInternalAttachmentDrop) {
      try {
        const attachment = JSON.parse(attachmentJson) as TextAttachment;
        if (attachment && typeof attachment.content === 'string') {
          onInternalAttachmentDrop(attachment);
          return;
        }
      } catch {
        // Malformed payload: fall through to the legacy text handling below.
      }
    }

    // Check for file reference next
    const fileName = e.dataTransfer.getData(LUMO_FILE_REF_MIME);
    if (fileName && onInternalFileDrop) {
      onInternalFileDrop(fileName);
      return;
    }

    // Otherwise treat as text drop
    const text = e.dataTransfer.getData('text/plain');
    if (text?.trim() && onInternalTextDrop) {
      onInternalTextDrop(text.trim());
    }
  }, [isInternalDrag, canAcceptImages, onInternalFileDrop, onInternalTextDrop, onInternalAttachmentDrop]);
 
  return (
    <div
      className="p-3 shrink-0"
      onDragEnter={handleInputDragEnter}
      onDragLeave={handleInputDragLeave}
      onDragOver={handleInputDragOver}
      onDrop={handleInputDrop}
    >
      {/*
        Queued messages rest on the composer the way a tab rests on a folder:
        flush against the box (no gap), a few pixels narrower than it, and open
        at the bottom so the composer's own border closes the shape.

        Rows read oldest → newest top → bottom, which is also the order they are
        delivered in, so the list never has to explain itself. The strip is
        capped and scrolls instead of growing: a long queue must not eat the
        transcript, and the newest entries are the ones the user just wrote.
      */}
      <AnimatePresence initial={false}>
        {queuedInputs.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="relative z-0 overflow-hidden"
          >
            <div className="mx-2 overflow-hidden rounded-t-lg border border-b-0 border-border bg-muted">
              <div ref={queueScrollRef} className="max-h-[5.5rem] overflow-y-auto scrollbar-lumo">
                <AnimatePresence initial={false}>
                  {queuedInputs.map((item, index) => {
                    // Attachments-only messages have no text to show; the label
                    // names what will be sent so the row is never blank.
                    const label =
                      item.text ||
                      (item.images.length > 0
                        ? t('sidebar.imageAttachment')
                        : t('sidebar.textAttachment'));
                    return (
                      <motion.button
                        key={item.id}
                        type="button"
                        layout
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
                        onClick={() => onDequeue?.(item.id)}
                        // The tooltip carries the full message, because the row
                        // truncates; the action is announced by the visually
                        // hidden text below so the name stays the content.
                        title={label}
                        className={`group flex w-full items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground text-start transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:bg-background/60 focus-visible:text-foreground ${
                          index > 0 ? 'border-t border-border/60' : ''
                        }`}
                      >
                        {/* Waiting its turn — the fact the list order alone does not
                            spell out for the row the model is not looking at yet. */}
                        <Clock
                          aria-hidden
                          className="h-3 w-3 shrink-0 opacity-40 group-hover:opacity-70 transition-opacity"
                        />
                        <span className="truncate flex-1 min-w-0">{label}</span>
                        <span className="sr-only">{t('sidebar.withdrawQueued')}</span>
                        <X
                          aria-hidden
                          className="h-3 w-3 shrink-0 -me-0.5 opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60 transition-opacity"
                        />
                      </motion.button>
                    );
                  })}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/*
        Relative wrapper so the suggestion popup can sit above the composer
        without being clipped by the composer's own `overflow-hidden` (which
        rounds the attachment strip). The popup is a sibling of the chrome,
        not a child of it.
      */}
      <div className="relative">
        <SuggestionPopup
          open={suggestions.open}
          items={suggestions.items}
          activeIndex={suggestions.activeIndex}
          onHover={suggestions.setActiveIndex}
          onSelect={suggestions.select}
        />
        <div
          className={`rounded-xl border-2 overflow-hidden transition-all duration-150 focus-within:border-chat-user/50 ${
            isInternalDragOver
              ? 'border-chat-user border-dashed bg-chat-user/15 shadow-[0_0_8px_0_var(--color-chat-user)/20] scale-[1.01]'
              : isInternalDrag
                ? 'border-chat-user/50 border-dashed bg-chat-user/5'
                : 'border-border bg-muted/50 border'
          }`}
        >
        {/* Attachment previews inside the input box */}
        <AnimatePresence>
          {hasAttachments && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="px-3 pt-3 flex gap-2 overflow-x-auto scrollbar-lumo"
            >
              {/* Image attachments */}
              {images.map((img, i) => (
                <div
                  key={`img-${i}`}
                  className="relative shrink-0 group cursor-grab active:cursor-grabbing"
                  draggable
                  onDragStart={(e) => handleImageDragStart(e, img)}
                  onDragEnd={(e) => handleChipDragEnd(e, () => removeImage(i))}
                >
                  <img src={img} className="h-14 w-14 object-cover rounded-lg" alt="" />
                  <button
                    onClick={() => removeImage(i)}
                    className="absolute -top-1.5 -end-1.5 bg-foreground/80 text-background rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {/* Text attachments */}
              {textAttachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="relative shrink-0 group flex items-center gap-1.5 h-14 px-2.5 rounded-lg bg-muted border border-border max-w-[180px] cursor-grab active:cursor-grabbing"
                  title={attachment.preview}
                  draggable
                  onDragStart={(e) => handleAttachmentDragStart(e, attachment)}
                  onDragEnd={(e) =>
                    handleChipDragEnd(e, () => removeTextAttachment(attachment.id))
                  }
                >
                  {attachment.kind === 'page-context' ? (
                    <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="flex flex-col overflow-hidden min-w-0">
                    <span className="text-[10px] text-muted-foreground leading-tight">
                      {attachmentLabel(attachment, t)}
                    </span>
                    <span className="text-xs truncate leading-tight">{attachment.preview}</span>
                  </div>
                  <button
                    onClick={() => removeTextAttachment(attachment.id)}
                    className="absolute -top-1.5 -end-1.5 bg-foreground/80 text-background rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
 
        {/* Textarea body */}
        <div className="px-3 pt-3 pb-1">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={syncCaret}
            onClick={syncCaret}
            onKeyUp={syncCaret}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={t('sidebar.placeholder')}
            className="min-h-[36px] resize-none overflow-y-auto text-sm border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-muted-foreground/60 scrollbar-lumo"
            rows={1}
          />
        </div>
 
        {/* Footer toolbar */}
        <div className="flex items-center justify-between px-2 pb-2">
          <div className="flex items-center gap-0.5">
            {canAcceptImages && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground"
                onClick={handleImageUpload}
                title={t('sidebar.pasteImage')}
              >
                <ImagePlus className="h-4 w-4" />
              </Button>
            )}
          </div>
          <div className="flex items-center gap-1">
            {contextUsage && (
              <ContextUsageRing
                usage={contextUsage}
                pendingTokens={estimateDraftTokens({
                  text: input,
                  images,
                  attachments: textAttachments,
                })}
              />
            )}
            {isStreaming && !hasDraft ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-lg text-destructive hover:text-destructive"
                onClick={onStop}
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground disabled:opacity-30"
                onClick={handleSend}
                disabled={!hasDraft}
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
});
