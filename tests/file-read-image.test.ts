/**
 * `file_read` returns decodable images as image content, and everything else —
 * including SVG, which is text — as text.
 *
 * The distinction matters twice: SVG source is what a model can actually read,
 * and an `image/svg+xml` content part is rejected by the provider APIs.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { FileMcpServer } from '@/lib/mcp/file-server';
import { normalizeToCallToolResult } from '@/lib/mcp/registry';
import { fileStorage } from '@/lib/mcp/file-storage';

afterEach(async () => {
  await fileStorage.clearFiles();
});

function fileRead() {
  const tool = new FileMcpServer().getAITools().file_read as unknown as {
    execute: (input: { name: string }) => Promise<unknown>;
  };
  return {
    // The registry is what turns a tool's raw return into the CallToolResult
    // the model and the shell both consume.
    execute: async (input: { name: string }) =>
      normalizeToCallToolResult(await tool.execute(input)),
  };
}

describe('file_read image handling', () => {
  it('returns a PNG as an image content part', async () => {
    await fileStorage.writeFile(
      'shot.png',
      new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
      { mimeType: 'image/png' },
    );

    const result = await fileRead().execute({ name: 'shot.png' });
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  });

  it('returns SVG source as text rather than an image block', async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
    await fileStorage.writeFile('icon.svg', source);

    const result = await fileRead().execute({ name: 'icon.svg' });
    expect(result.isError).toBe(false);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(result.content[0]!.text).toContain('<svg');
  });

  it('keeps the paging shape for text files', async () => {
    await fileStorage.writeFile('notes.txt', 'hello');

    const result = await fileRead().execute({ name: 'notes.txt' });
    expect(result.isError).toBe(false);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.parse(String(result.content[0]!.text))).toMatchObject({ content: 'hello' });
  });

  it('reports a missing file as an error', async () => {
    const result = await fileRead().execute({ name: 'missing.txt' });
    expect(result.isError).toBe(true);
  });
});
