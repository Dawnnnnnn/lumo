/**
 * File tool surface contract.
 *
 * `getTools()` (settings UI) and `getAITools()` (what the model sees) were two
 * hand-written lists and had already drifted — `file_read`'s two descriptions
 * disagreed about whether it took paging parameters. `getTools()` is now derived
 * from the same zod schemas, and these tests keep it that way.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FileMcpServer } from '@/lib/mcp/file-server';

const server = new FileMcpServer();
const aiTools = server.getAITools();
const uiTools = server.getTools();

describe('FileMcpServer tool surface', () => {
  it('exposes the same tool names to the UI and the model', () => {
    expect(uiTools.map((t) => t.name).sort()).toEqual(Object.keys(aiTools).sort());
  });

  it('derives UI schemas from the same zod schema the model sees', () => {
    for (const tool of uiTools) {
      const expected = z.toJSONSchema(
        (aiTools[tool.name] as { inputSchema?: unknown }).inputSchema as z.ZodType,
        { io: 'input' },
      ) as Record<string, unknown>;
      delete expected.$schema;
      expect(tool.inputSchema).toEqual(expected);
    }
  });

  it('gives every tool a non-empty description', () => {
    for (const tool of uiTools) {
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it('offers a line-number-free edit tool, since models cannot supply line numbers', () => {
    expect(Object.keys(aiTools)).toContain('file_edit');
  });

  it('steers the model away from whole-file overwrites for partial changes', () => {
    expect((aiTools.file_write as { description: string }).description).toMatch(/file_edit/);
  });

  it('tells the model that patch line numbers are ignored', () => {
    expect((aiTools.file_patch as { description: string }).description).toMatch(/IGNORED/);
  });

  it('lets the model list one directory, which is how it finds bundled skill resources', () => {
    const schema = (aiTools.file_list as { inputSchema: z.ZodType }).inputSchema;
    const json = z.toJSONSchema(schema, { io: 'input' }) as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(json.properties)).toEqual(['path']);
    expect((aiTools.file_list as { description: string }).description).toMatch(/directory/i);
  });

  it('offers a move tool so a skill directory can be renamed as a unit', () => {
    expect(Object.keys(aiTools)).toContain('file_move');
    const schema = (aiTools.file_move as { inputSchema: z.ZodType }).inputSchema;
    const json = z.toJSONSchema(schema, { io: 'input' }) as {
      required?: string[];
    };
    expect(json.required?.sort()).toEqual(['from', 'to']);
  });

  it('exposes paging on file_read so a large file cannot blow the context window', () => {
    const schema = (aiTools.file_read as { inputSchema: z.ZodType }).inputSchema;
    const json = z.toJSONSchema(schema, { io: 'input' }) as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(json.properties)).toEqual(
      expect.arrayContaining(['name', 'maxChars', 'offset']),
    );
  });
});
