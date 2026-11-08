/**
 * Safety and consistency of the shell's environment after the programmatic-mode
 * review: `--check` must not execute, archives must not overwrite silently or
 * escape their target, the VFS must notice external writes and enforce its
 * quota, and tool name resolution must refuse ambiguity.
 */
import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Bash } from 'just-bash/browser';
import { zipSync } from 'fflate';
import { fileStorage } from '@/lib/mcp/file-storage';
import { mcpRegistry } from '@/lib/mcp/registry';
import type { AnyTool, IMcpServer } from '@/lib/mcp/types';
import { LumoFileSystem } from '@/lib/shell/vfs';
import { createNodeCommand } from '@/lib/shell/node-command';
import { createArchiveCommands } from '@/lib/shell/archive-command';
import { createMcpCommand } from '@/lib/shell/mcp-command';
import { executeShell } from '@/lib/shell/runtime/execute';
import { withKeyLock, resetKeyLocksForTests } from '@/lib/shell/lock';
import { buildConversionToolSet } from '@/lib/tools/catalog';
import { SHELL_TOOL_NAME } from '@/lib/shell/descriptor';

const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('.wasm')) {
      const path = url.startsWith('/node_modules/') ? `.${url}` : url;
      return new Response(await readFile(path), { status: 200 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

async function shellWith(commands: unknown[]): Promise<Bash> {
  const fs = new LumoFileSystem();
  await fs.refresh();
  return new Bash({
    fs,
    cwd: '/',
    customCommands: commands as never,
    executionLimits: { maxExecutionTimeMs: 6_000 },
  });
}

afterEach(async () => {
  await fileStorage.clearFiles();
  mcpRegistry.unregister('review-test');
  resetKeyLocksForTests();
});

describe('node --check', () => {
  it('does not execute the script', async () => {
    await fileStorage.writeFile('check.js', "await fs.writeFile('/check-effect.txt', 'x')\n");
    const bash = await shellWith([createNodeCommand()]);
    const result = await bash.exec('node --check /check.js');
    expect(result.exitCode).toBe(0);
    expect(await fileStorage.readFileAsText('check-effect.txt')).toBeNull();
  });

  it('does not block on an infinite loop', async () => {
    await fileStorage.writeFile('loop.js', 'while (true) {}\n');
    const bash = await shellWith([createNodeCommand()]);
    const started = Date.now();
    const result = await bash.exec('node --check /loop.js');
    expect(result.exitCode).toBe(0);
    // Compiling is immediate; evaluating used to burn the whole shell budget.
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('execution budget', () => {
  it('honours an explicit timeout without an implicit default', async () => {
    const result = await executeShell(
      {},
      { command: "node -e 'while (true) {}'", timeoutMs: 1_000 },
    );
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('deadline');
  });

  it('honours a sub-second deadline instead of widening it', async () => {
    // A caller that asks for 200ms must get 200ms: the shell used to raise any
    // positive value to one second, so a short guard silently outlived itself.
    const started = Date.now();
    const result = await executeShell(
      {},
      { command: 'while true; do :; done', timeoutMs: 200 },
    );
    const elapsed = Date.now() - started;
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('deadline');
    expect(elapsed).toBeLessThan(900);
  });

  it('keeps the preview when the spill file cannot be written', async () => {
    await fileStorage.writeFile('big.txt', 'x'.repeat(60_000));
    const original = fileStorage.writeFile.bind(fileStorage);
    const spy = vi.spyOn(fileStorage, 'writeFile').mockImplementation(async (name, data, options) => {
      if (name.startsWith('tmp/sh-')) throw new Error('quota exceeded');
      return original(name, data, options);
    });

    try {
      const result = await executeShell({}, { command: 'cat big.txt', timeoutMs: 5_000 });
      // The command itself succeeded; only the spill failed. The model must keep
      // the truncated preview instead of losing the whole result.
      expect(result.exitCode).toBe(0);
      expect(result.truncated).toBe(true);
      expect(result.fullOutputPath).toBeUndefined();
      expect(result.stderr).toContain('could not be written');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('archive extraction', () => {
  it('keeps an existing file unless -o is given', async () => {
    const bash = await shellWith(createArchiveCommands());
    const skipped = await bash.exec(
      "printf 'from archive' > src.txt; zip a.zip src.txt >/dev/null; echo kept > src.txt; unzip a.zip; cat src.txt",
    );
    expect(skipped.exitCode).toBe(0);
    expect(skipped.stdout).toContain('skipping:');
    expect(skipped.stdout).toContain('kept');

    const forced = await bash.exec('unzip -o a.zip; cat src.txt');
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain('from archive');
  });

  it('rejects entries that would escape the target directory', async () => {
    const evil = zipSync({ '../escaped.txt': new TextEncoder().encode('pwned') });
    await fileStorage.writeFile('evil.zip', new Blob([evil]));
    const bash = await shellWith(createArchiveCommands());
    const result = await bash.exec('unzip evil.zip -d /safe/dir');
    expect(result.stderr).toContain('unsafe');
    expect(await fileStorage.readFileAsText('safe/escaped.txt')).toBeNull();
    expect(await fileStorage.readFileAsText('escaped.txt')).toBeNull();
  });
});

describe('LumoFileSystem consistency', () => {
  it('sees a file written by another tool after its refresh', async () => {
    const fs = new LumoFileSystem();
    await fs.refresh();
    expect(await fs.exists('/external.txt')).toBe(false);

    await fileStorage.writeFile('external.txt', 'x');
    expect(await fs.exists('/external.txt')).toBe(true);
    expect(await fs.readFile('/external.txt')).toBe('x');
  });

  it('serialises work for the same conversation key', async () => {
    const order: string[] = [];
    const first = withKeyLock('conv', async () => {
      order.push('a:start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('a:end');
    });
    const second = withKeyLock('conv', async () => {
      order.push('b:start');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });
});

describe('mcp resolution', () => {
  const tool = {
    description: 'echo',
    inputSchema: { type: 'object' },
    execute: async (input: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(input) }] }),
  } as unknown as AnyTool;

  function register(tools: Record<string, AnyTool>, name = 'Review Test'): IMcpServer {
    const server: IMcpServer = {
      getInfo: () => ({
        id: 'review-test',
        name,
        description: 'test',
        transport: 'builtin',
        builtin: true,
        enabled: true,
      }),
      connect: async () => undefined,
      disconnect: async () => undefined,
      getStatus: () => 'connected',
      getTools: () =>
        Object.entries(tools).map(([toolName, definition]) => ({
          name: toolName,
          description: typeof definition.description === 'string' ? definition.description : '',
          inputSchema: { type: 'object' },
        })),
      getAITools: () => tools,
      getError: () => undefined,
    };
    mcpRegistry.register(server);
    return server;
  }

  it('refuses a prefix that does not name a server', async () => {
    register({ echo: tool });
    const bash = await shellWith([createMcpCommand()]);
    const result = await bash.exec('mcp call review.echo {}');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown server');
  });

  it('refuses an ambiguous tool name instead of picking one', async () => {
    register({ page_read: tool, pageread: tool });
    const bash = await shellWith([createMcpCommand()]);
    const result = await bash.exec('mcp call --server review-test --tool page.read');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Ambiguous');
  });
});

describe('conversion catalogue', () => {
  it('contains the shell descriptor without an executor', () => {
    const tools = buildConversionToolSet();
    const shell = tools[SHELL_TOOL_NAME] as { toModelOutput?: unknown; execute?: unknown };
    expect(shell).toBeDefined();
    expect(typeof shell.toModelOutput).toBe('function');
    // Declarations only: a conversion must never be able to run a tool.
    expect(shell.execute).toBeUndefined();
  });
});
