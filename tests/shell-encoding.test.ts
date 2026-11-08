/**
 * Encoding at the `IFileSystem` write boundary.
 *
 * just-bash hands `writeFile`/`appendFile` two different string shapes and says
 * which one with the encoding argument: `"utf8"` for text (an `echo` argument)
 * and `"binary"` for a pipe payload, which is a latin1 byte string — one char
 * per byte (see `ByteString` in just-bash's `encoding.d.ts`).
 *
 * Ignoring that argument fed byte strings through `TextEncoder`, which
 * double-encoded every heredoc (`需要` was stored as `é\u009c\u0080`) and
 * corrupted every binary redirect (`0x89` became `0xc2 0x89`). These cases pin
 * both directions at the boundary so a future refactor cannot re-break the
 * redirect path silently — the damage is invisible until the file is opened.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bash } from 'just-bash/browser';
import { fileStorage } from '@/lib/mcp/file-storage';
import { mcpRegistry } from '@/lib/mcp/registry';
import type { AnyTool, IMcpServer } from '@/lib/mcp/types';
import { createMcpCommand } from '@/lib/shell/mcp-command';
import { LumoFileSystem } from '@/lib/shell/vfs';

/** Bytes that are invalid UTF-8 on their own, so any decode is lossy. */
const BINARY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x80, 0x00]);

const SERVER_ID = 'encoding-test';

/** Records what the tool actually received, so a mangled argument is visible. */
const seen: unknown[] = [];
const echoTool = {
  description: 'echo input',
  inputSchema: { type: 'object' },
  execute: async (input: unknown) => {
    seen.push(input);
    return { content: [{ type: 'text', text: JSON.stringify(input) }] };
  },
} as unknown as AnyTool;

function fakeServer(tools: Record<string, AnyTool>): IMcpServer {
  return {
    getInfo: () => ({
      id: SERVER_ID,
      name: 'Encoding Test',
      description: 'test server',
      transport: 'builtin',
      builtin: true,
      enabled: true,
    }),
    connect: async () => undefined,
    disconnect: async () => undefined,
    getStatus: () => 'connected' as const,
    getTools: () =>
      Object.entries(tools).map(([name, definition]) => ({
        name,
        description: (definition as { description?: string }).description ?? '',
        inputSchema: { type: 'object' },
      })),
    getAITools: () => tools,
    getError: () => undefined,
  };
}

async function shell(options: { withMcp?: boolean } = {}) {
  const fs = new LumoFileSystem();
  await fs.refresh();
  const bash = new Bash({
    fs,
    cwd: '/',
    executionLimitProfile: 'normal',
    ...(options.withMcp ? { customCommands: [createMcpCommand()] } : {}),
  });
  return { fs, bash };
}

beforeEach(async () => {
  seen.length = 0;
  await fileStorage.clearFiles();
});

afterEach(() => {
  mcpRegistry.unregister(SERVER_ID);
});

describe('shell write encoding', () => {
  it('stores a quoted heredoc as UTF-8 text', async () => {
    const { fs, bash } = await shell();
    await bash.exec(`cat > /a.txt <<'EOF'\n需要\nEOF`, { rawScript: true });
    expect(await fs.readFile('/a.txt', 'utf8')).toBe('需要\n');
  });

  it('stores an expanding heredoc as UTF-8 text', async () => {
    const { fs, bash } = await shell();
    await bash.exec(`NAME=需要\ncat > /b.txt <<EOF\n$NAME\nEOF`, { rawScript: true });
    expect(await fs.readFile('/b.txt', 'utf8')).toBe('需要\n');
  });

  it('appends piped heredoc text without re-encoding', async () => {
    const { fs, bash } = await shell();
    await bash.exec(`echo "需要" > /c.txt\ncat >> /c.txt <<'EOF'\n需要\nEOF`, { rawScript: true });
    expect(await fs.readFile('/c.txt', 'utf8')).toBe('需要\n需要\n');
  });

  it('keeps binary bytes through a redirect', async () => {
    const { fs, bash } = await shell();
    await fs.writeFile('/src.png', BINARY);
    await bash.exec('cat /src.png > /copy.png', { rawScript: true });
    expect(await fs.readFileBuffer('/copy.png')).toEqual(BINARY);
  });

  it('keeps binary bytes through tee', async () => {
    const { fs, bash } = await shell();
    await fs.writeFile('/src.png', BINARY);
    await bash.exec('cat /src.png | tee /tee.png > /dev/null', { rawScript: true });
    expect(await fs.readFileBuffer('/tee.png')).toEqual(BINARY);
  });

  it('round-trips binary through base64 -d', async () => {
    const { fs, bash } = await shell();
    await fs.writeFile('/src.png', BINARY);
    await bash.exec('base64 /src.png > /src.b64\nbase64 -d /src.b64 > /decoded.png', { rawScript: true });
    expect(await fs.readFileBuffer('/decoded.png')).toEqual(BINARY);
  });

  it('honours an explicit binary encoding', async () => {
    const { fs } = await shell();
    await fs.writeFile('/explicit.bin', String.fromCharCode(...BINARY), 'binary');
    expect(await fs.readFileBuffer('/explicit.bin')).toEqual(BINARY);
  });

  it('treats utf8 writes as text, not as latin1 bytes', async () => {
    const { fs } = await shell();
    await fs.writeFile('/text.txt', '需要', { encoding: 'utf8' });
    expect(await fs.readFile('/text.txt', 'utf8')).toBe('需要');
    expect(await fs.readFile('/text.txt', 'binary')).toBe(
      String.fromCharCode(...new TextEncoder().encode('需要')),
    );
  });

  it('decodes base64 and hex writes into the same bytes as textFromBytes reads', async () => {
    const { fs } = await shell();
    await fs.writeFile('/b64.txt', 'aVD/AA==', 'base64');
    expect(await fs.readFile('/b64.txt', 'base64')).toBe('aVD/AA==');
    await fs.writeFile('/hex.txt', '89504eff', 'hex');
    expect(await fs.readFile('/hex.txt', 'hex')).toBe('89504eff');
  });

  // The original report: a heredoc JSON argument delivered to a tool as
  // mojibake, because the payload was double-encoded on the way to disk and
  // then read back as UTF-8.
  it('delivers a heredoc JSON argument to a tool as intact text', async () => {
    mcpRegistry.register(fakeServer({ echo: echoTool }));
    const { bash } = await shell({ withMcp: true });
    await bash.exec(`cat > /args.json <<'EOF'
{"text":"需要"}
EOF`, { rawScript: true });
    const result = await bash.exec(`mcp call encoding-test.echo < /args.json`, { rawScript: true });
    expect(result.stderr).toBe('');
    expect(seen).toEqual([{ text: '需要' }]);
  });

  it('still sniffs extensionless text writes as text', async () => {
    const { fs, bash } = await shell();
    await bash.exec(`echo "需要" > /noext`, { rawScript: true });
    const meta = await fileStorage.getMetadata('noext');
    expect(meta?.mimeType).toBe('text/plain');
    expect(await fs.readFile('/noext', 'utf8')).toBe('需要\n');
  });
});
