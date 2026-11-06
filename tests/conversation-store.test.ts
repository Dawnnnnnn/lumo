/**
 * @vitest-environment jsdom
 *
 * Behaviour of the conversation store against a real IndexedDB implementation.
 *
 * These exercise the properties that motivated moving history out of
 * `chrome.storage.local`: writes are per-record, the history list never loads
 * message bodies, and screenshots are held outside the JSON record.
 *
 * One environment caveat: `fake-indexeddb`'s structured clone does not preserve
 * `Blob` instances — a stored Blob reads back as a plain object. Real IndexedDB
 * (verified against Node's implementation) round-trips it correctly. So these
 * tests assert on *what reaches storage* and on reference integrity, and leave
 * the `URL.createObjectURL` step, which needs a genuine Blob, out of scope.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearConversations,
  deleteConversation,
  exportConversationData,
  getConversation,
  importConversationData,
  listConversationMeta,
  saveConversation,
  resolveBlobUrl,
} from '@/lib/conversation-store';
import { getChatDB, request, BLOBS_STORE } from '@/lib/chat-db';
import { parseBlobRef } from '@/lib/blob-ref';
import type { ChatMessagePart, Conversation } from '@/types';

const RED_PNG_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A tool part carrying a screenshot, shaped as the registry produces it. */
function screenshotPart(toolCallId: string): ChatMessagePart {
  return {
    type: 'tool-page_screenshot',
    toolCallId,
    state: 'output-available',
    input: {},
    output: {
      content: [
        { type: 'image', data: RED_PNG_DATA, mimeType: 'image/png' },
        { type: 'text', text: 'Screenshot captured (png)' },
      ],
      isError: false,
    },
  } as unknown as ChatMessagePart;
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    title: 'First chat',
    messages: [
      {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: 'take a screenshot', state: 'done' }],
        timestamp: 1,
      },
      {
        id: 'm2',
        role: 'assistant',
        parts: [screenshotPart('call-1')],
        timestamp: 2,
      },
    ],
    modelId: 'gpt-4o',
    providerId: 'openai',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

/** Read the image entry out of the first tool part of the last message. */
function imageEntry(conv: Conversation): Record<string, unknown> {
  const part = conv.messages[conv.messages.length - 1]!.parts![0] as {
    output: { content: Array<Record<string, unknown>> };
  };
  return part.output.content.find((entry) => entry.type === 'image')!;
}

/** Whether a blob record exists for `ref`, bypassing Blob reconstruction. */
async function blobExists(ref: string): Promise<boolean> {
  const id = parseBlobRef(ref);
  if (!id) return false;
  const db = await getChatDB();
  const tx = db.transaction(BLOBS_STORE, 'readonly');
  const found = await request(tx.objectStore(BLOBS_STORE).get(id));
  return found !== undefined;
}

beforeEach(async () => {
  await clearConversations();
});

describe('conversation persistence', () => {
  it('round-trips a conversation', async () => {
    await saveConversation(conversation());
    const loaded = await getConversation('conv-1');

    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe('First chat');
    expect(loaded!.messages).toHaveLength(2);
  });

  it('returns null for a conversation that was never saved', async () => {
    expect(await getConversation('nope')).toBeNull();
  });

  it('refuses to resurrect a deleted conversation', async () => {
    // A stream settling after the user deleted its conversation must not bring
    // it back.
    const written = await saveConversation(conversation(), { insertIfMissing: false });
    expect(written).toBeNull();
    expect(await getConversation('conv-1')).toBeNull();
  });

  it('updates an existing conversation in place', async () => {
    await saveConversation(conversation());
    await saveConversation(conversation({ title: 'Renamed', updatedAt: 99 }));

    const list = await listConversationMeta();
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe('Renamed');
  });
});

describe('history list summaries', () => {
  it('exposes a preview without carrying message bodies', async () => {
    await saveConversation(
      conversation({
        messages: [
          {
            id: 'm1',
            role: 'user',
            parts: [{ type: 'text', text: 'hello   there', state: 'done' }],
            timestamp: 1,
          },
        ],
      }),
    );

    const [meta] = await listConversationMeta();
    expect(meta!.preview).toBe('hello there');
    expect(meta!.messageCount).toBe(1);
    // The summary is the whole point: no message array to walk.
    expect(meta).not.toHaveProperty('messages');
  });

  it('orders the list most recently updated first', async () => {
    await saveConversation(conversation({ id: 'older', updatedAt: 10 }));
    await saveConversation(conversation({ id: 'newer', updatedAt: 20 }));

    expect((await listConversationMeta()).map((m) => m.id)).toEqual(['newer', 'older']);
  });
});

describe('screenshot offloading', () => {
  it('keeps base64 out of the stored record and leaves a resolvable reference', async () => {
    const saved = await saveConversation(conversation());

    // The returned value is the copy the UI should hold: renderable, with a
    // sentinel URL instead of the bytes. Callers adopt it so memory matches
    // disk without a second read.
    expect(imageEntry(saved!).data).toBeDefined();
    expect(parseBlobRef(imageEntry(saved!).data as string)).toBeDefined();

    const loaded = await getConversation('conv-1');
    const entry = imageEntry(loaded!);

    // On read the payload is a reference, not the bytes — this is what keeps a
    // conversation record small no matter how many screenshots it contains.
    const ref = parseBlobRef(entry.data as string);
    expect(ref).toBeDefined();
    expect(entry.data).not.toContain(RED_PNG_DATA);

    // ...and the bytes really were written under that reference.
    expect(await blobExists(entry.data as string)).toBe(true);
  });

  it('reports a missing blob as null rather than throwing', async () => {
    // Lets the UI fall back to the tool's caption instead of a broken image.
    expect(await resolveBlobUrl('lumo-blob:does-not-exist')).toBeNull();
  });

  it('preserves the caption alongside the offloaded image', async () => {
    await saveConversation(conversation());
    const loaded = await getConversation('conv-1');
    const part = loaded!.messages[1]!.parts![0] as {
      output: { content: Array<{ type: string; text?: string }> };
    };
    expect(part.output.content).toContainEqual({
      type: 'text',
      text: 'Screenshot captured (png)',
    });
  });

  it('survives being read and saved again', async () => {
    // The regression that matters: continuing a conversation re-persists messages
    // already carrying `lumo-blob:` markers. Treating a marker as base64 threw
    // `InvalidCharacterError` on every turn after the first.
    await saveConversation(conversation());
    const first = await getConversation('conv-1');

    await expect(saveConversation(first!)).resolves.not.toBeNull();

    const second = await getConversation('conv-1');
    expect(parseBlobRef(imageEntry(second!).data as string)).toBeDefined();
    expect(await blobExists(imageEntry(second!).data as string)).toBe(true);
  });

  it('does not duplicate blobs when a conversation is saved repeatedly', async () => {
    await saveConversation(conversation());
    const first = await getConversation('conv-1');
    const firstRef = imageEntry(first!).data as string;

    await saveConversation(first!);
    const second = await getConversation('conv-1');

    // Re-saving an already-offloaded image must reuse its blob rather than
    // writing a second copy of the same bytes.
    expect(imageEntry(second!).data).toBe(firstRef);

    const db = await getChatDB();
    const tx = db.transaction(BLOBS_STORE, 'readonly');
    expect(await request(tx.objectStore(BLOBS_STORE).count())).toBe(1);
  });
});

describe('deletion', () => {
  it('drops the conversation, its summary and its screenshots', async () => {
    await saveConversation(conversation());
    const loaded = await getConversation('conv-1');
    const ref = imageEntry(loaded!).data as string;

    await deleteConversation('conv-1');

    expect(await getConversation('conv-1')).toBeNull();
    expect(await listConversationMeta()).toEqual([]);
    // Blobs are garbage collected with their conversation, so history cannot
    // grow forever through orphaned images.
    expect(await blobExists(ref)).toBe(false);
  });

  it('leaves other conversations untouched', async () => {
    await saveConversation(conversation({ id: 'keep' }));
    await saveConversation(conversation({ id: 'drop' }));

    await deleteConversation('drop');

    expect((await listConversationMeta()).map((m) => m.id)).toEqual(['keep']);
    expect(await getConversation('keep')).not.toBeNull();
  });

  it('clears everything', async () => {
    await saveConversation(conversation({ id: 'a' }));
    await saveConversation(conversation({ id: 'b' }));

    await clearConversations();

    expect(await listConversationMeta()).toEqual([]);
  });
});


describe('backup import and export', () => {
  it('round-trips raw records and screenshots', async () => {
    await saveConversation(conversation());
    const bundle = await exportConversationData();

    expect(bundle.conversations).toHaveLength(1);
    expect(bundle.blobs).toHaveLength(1);
    // The export must be the stored shape, not the render projection: records
    // carry blobId, while a `lumo-blob:` marker would be meaningless on import.
    expect(bundle.conversations[0]!.messages[1]!.parts![0]).toHaveProperty(
      'output.content.0.blobId',
    );

    await clearConversations();
    const result = await importConversationData(bundle.conversations, bundle.blobs);

    expect(result).toEqual({ imported: 1, skipped: 0 });
    const loaded = await getConversation('conv-1');
    expect(loaded?.title).toBe('First chat');
    expect(await blobExists(imageEntry(loaded!).data as string)).toBe(true);
  });

  it('skips an id that already exists unless overwrite is requested', async () => {
    await saveConversation(conversation());
    const bundle = await exportConversationData();

    expect(await importConversationData(bundle.conversations, bundle.blobs)).toEqual({
      imported: 0,
      skipped: 1,
    });
    expect(await importConversationData(bundle.conversations, bundle.blobs, { overwrite: true })).toEqual({
      imported: 1,
      skipped: 0,
    });
  });

  it('replaces the old screenshots when overwriting', async () => {
    await saveConversation(conversation());
    const bundle = await exportConversationData();

    // A different blob set for the same conversation: the old screenshot must
    // not survive as an orphan that no record can ever reach.
    const replacement = [
      {
        id: 'replacement',
        conversationId: 'conv-1',
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      },
    ];
    await importConversationData(bundle.conversations, replacement, { overwrite: true });

    const db = await getChatDB();
    const tx = db.transaction(BLOBS_STORE, 'readonly');
    expect(await request(tx.objectStore(BLOBS_STORE).count())).toBe(1);
  });
});
