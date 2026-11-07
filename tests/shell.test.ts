/**
 * Shell integration: VFS over the real file store, `mcp` command, and the
 * `sh` tool's output shape.
 *
 * The node environment uses `fake-indexeddb/auto`; the shell itself is the same
 * `just-bash` browser build the extension ships.
 */

import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Bash } from 'just-bash/browser';
import { fileStorage } from '@/lib/mcp/file-storage';
import { mcpRegistry } from '@/lib/mcp/registry';
import type { IMcpServer, McpServerStatus, AnyTool } from '@/lib/mcp/types';
import { LumoFileSystem } from '@/lib/shell/vfs';
import { createMcpCommand } from '@/lib/shell/mcp-command';
import { createShellTool, buildProgrammaticToolSet } from '@/lib/shell/tool';

const testServerId = 'shell-test';

// QuickJS loads its wasm through a relative dev-server URL under vitest.
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

/** Echo tool, used to exercise `exec` from JavaScript. */
const echoTool = {
  description: 'echo input',
  inputSchema: { type: 'object' },
  execute: async (input: unknown) => ({
    content: [{ type: 'text', text: JSON.stringify(input) }],
  }),
} as unknown as AnyTool;

/** Shared by the `mcp` command tests and the `sh` tool tests. */
const shotTool = {
  description: 'return an image',
  inputSchema: { type: 'object' },
  execute: async () => ({
    content: [{ type: 'image', data: btoa('png-bytes'), mimeType: 'image/png' }],
  }),
} as unknown as AnyTool;

/** Shared by the `mcp` command tests and the `sh` tool SVG test. */
const svgTool = {
  description: 'return an SVG',
  inputSchema: { type: 'object' },
  execute: async () => ({
    content: [
      {
        type: 'image',
        data: btoa('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        mimeType: 'image/svg+xml',
      },
    ],
  }),
} as unknown as AnyTool;

function fakeServer(options: {
  tools: Record<string, AnyTool>;
  status?: McpServerStatus;
}): IMcpServer {
  const status = options.status ?? 'connected';
  return {
    getInfo: () => ({
      id: testServerId,
      name: 'Shell Test',
      description: 'test server',
      transport: 'builtin',
      builtin: true,
      enabled: true,
    }),
    connect: async () => undefined,
    disconnect: async () => undefined,
    getStatus: () => status,
    getTools: () =>
      Object.entries(options.tools).map(([name, definition]) => ({
        name,
        description: (definition as { description?: string }).description ?? '',
        inputSchema: { type: 'object' },
      })),
    getAITools: () => options.tools,
    getError: () => undefined,
  };
}

async function shell(options?: { tools?: Record<string, AnyTool> }) {
  const fs = new LumoFileSystem();
  await fs.refresh();
  return new Bash({
    fs,
    cwd: '/',
    customCommands: [createMcpCommand()],
    executionLimitProfile: 'hardened',
    executionLimits: { maxExecutionTimeMs: 10_000 },
  });
}

beforeEach(async () => {
  await fileStorage.clearFiles();
  mcpRegistry.unregister(testServerId);
});

afterEach(async () => {
  mcpRegistry.unregister(testServerId);
  await fileStorage.clearFiles();
});

afterAll(() => {
  mcpRegistry.unregister(testServerId);
});

describe('LumoFileSystem', () => {
  it('shares files with fileStorage and creates parent directories', async () => {
    const bash = await shell();
    const result = await bash.exec('mkdir -p /notes && echo hello > /notes/a.txt && cat /notes/a.txt');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello\n');
    expect(await fileStorage.readFileAsText('notes/a.txt')).toBe('hello\n');
  });

  it('lists, moves and removes paths through the shell', async () => {
    const bash = await shell();
    await bash.exec('echo one > /a.txt && echo two > /b.txt');
    const listed = await bash.exec('ls /');
    expect(listed.stdout).toContain('a.txt');
    expect(listed.stdout).toContain('b.txt');

    const moved = await bash.exec('mv /a.txt /moved.txt && cat /moved.txt');
    expect(moved.stdout).toBe('one\n');
    expect(await fileStorage.readFileAsText('a.txt')).toBeNull();

    const removed = await bash.exec('rm /b.txt && ls /');
    expect(removed.stdout).not.toContain('b.txt');
  });

  it('runs a POSIX workflow over the shared store', async () => {
    const bash = await shell();
    const result = await bash.exec(
      [
        'mkdir -p /project/src',
        'echo alpha > /project/a.txt',
        'echo beta > /project/src/b.txt',
        'cp -r /project /clone',
        'find /clone -type f',
        'mv /clone /moved',
        'rm -rf /project',
        'tree /moved',
      ].join(' && '),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('/clone/src/b.txt');
    expect(result.stdout).toContain('`-- src');
    expect(await fileStorage.readFileAsText('project/a.txt')).toBeNull();
    expect(await fileStorage.readFileAsText('moved/src/b.txt')).toBe('beta\n');
  });

  it('replaces the destination file when mv targets an existing file', async () => {
    const bash = await shell();
    const result = await bash.exec(
      'echo one > /a.txt && echo two > /b.txt && mv /a.txt /b.txt && cat /b.txt && ls /',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('one');
    expect(result.stdout).not.toContain('a.txt');
    expect(await fileStorage.readFileAsText('a.txt')).toBeNull();
  });

  it('supports variables, functions and loops', async () => {
    const bash = await shell();
    const result = await bash.exec(
      [
        'greet() { echo "hi $1"; }',
        'total=0',
        'for i in 1 2 3; do total=$((total + i)); greet "$i"; done',
        'echo "total=$total"',
      ].join('; '),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hi 1\nhi 2\nhi 3\ntotal=6\n');
  });

  it('lets the shell write under skills/, shared with the file store', async () => {
    const bash = await shell();
    const result = await bash.exec(
      'mkdir -p /skills/written && printf -- "---\\nname: written\\ndescription: d\\n---\\n" > /skills/written/SKILL.md',
    );
    expect(result.exitCode).toBe(0);
    expect(await fileStorage.readFileAsText('skills/written/SKILL.md')).toContain('name: written');

    // The same path is visible to the file tool/ls on the next execution.
    const next = await shell();
    expect((await next.exec('cat /skills/written/SKILL.md')).stdout).toContain('name: written');
  });

  it('does not persist stdout/stderr redirected to /dev/null', async () => {
    await fileStorage.writeFile('notes.txt', 'needle');
    const bash = await shell();
    const result = await bash.exec(
      'grep needled notes.txt 2>/dev/null; echo hidden >/dev/null; cat /dev/null; echo done',
    );
    expect(result.stdout).toBe('done\n');
    expect(result.stderr).toBe('');

    // The artifact this guards against rendered in the chat file bar as a
    // zero-byte file named "null" (the last segment of `dev/null`).
    const names = (await fileStorage.listFiles()).map((file) => file.name);
    expect(names).not.toContain('dev/null');
  });

  it('lists /dev and reads /dev/zero without touching storage', async () => {
    const bash = await shell();
    expect((await bash.exec('ls /dev')).stdout.split('\n').filter(Boolean).sort()).toEqual([
      'null',
      'zero',
    ]);
    expect((await bash.exec('cat /dev/zero')).stdout).toBe('');
    // `clearFiles` keeps skills/ by design, so assert on the device path rather
    // than on the store being empty.
    expect((await fileStorage.listFiles()).map((file) => file.name)).not.toContain('dev/null');
  });

  it('removes a dev/null artifact left by an older build', async () => {
    await fileStorage.writeFile('dev/null', '');
    expect(await fileStorage.getMetadata('dev/null')).not.toBeNull();

    // A one-time repair belongs to storage, not to every shell refresh.
    await fileStorage.migrateLegacyShellArtifacts();
    expect(await fileStorage.getMetadata('dev/null')).toBeNull();

    const bash = await shell();
    expect((await bash.exec('ls /')).exitCode).toBe(0);
  });

  it('supports pipelines and jq', async () => {
    const bash = await shell();
    const result = await bash.exec("printf '{\"name\":\"lumo\"}\\n' | jq -r .name");
    expect(result.stdout).toBe('lumo\n');
  });
});

describe('mcp command', () => {
  beforeEach(() => {
    mcpRegistry.register(
      fakeServer({
        tools: {
          echo: {
            description: 'echo input',
            inputSchema: { type: 'object' },
            execute: async (input: unknown) => ({
              content: [{ type: 'text', text: JSON.stringify(input) }],
            }),
          } as unknown as AnyTool,
          shot: shotTool,
          svg: svgTool,
          "caption-shot": {
            description: 'return a caption and an image',
            inputSchema: { type: 'object' },
            execute: async () => ({
              content: [
                { type: 'text', text: 'Screenshot captured 800x600' },
                { type: 'image', data: btoa('PNG-BYTES'), mimeType: 'image/png' },
              ],
            }),
          } as unknown as AnyTool,
          fail: {
            description: 'return an error',
            inputSchema: { type: 'object' },
            execute: async () => ({
              content: [{ type: 'text', text: 'nope' }],
              isError: true,
            }),
          } as unknown as AnyTool,
        },
      }),
    );
  });

  it('lists servers and discovers tools', async () => {
    const bash = await shell();
    const list = await bash.exec('mcp list');
    expect(list.stdout).toContain('shell-test');
    expect(list.stdout).toContain('connected');

    const tools = await bash.exec('mcp tools shell-test');
    expect(tools.stdout).toContain('echo');
    expect(tools.stdout).toContain('echo input');

    const described = await bash.exec('mcp describe shell-test.echo');
    expect(described.stdout).toContain('"type": "object"');
  });

  it('calls a tool with positional JSON and with stdin', async () => {
    const bash = await shell();
    const positional = await bash.exec("mcp call shell-test.echo '{\"msg\":\"hi\"}'");
    expect(positional.exitCode).toBe(0);
    expect(positional.stdout.trim()).toBe('{"msg":"hi"}');

    const piped = await bash.exec("echo '{\"msg\":\"pipe\"}' | mcp call shell-test.echo");
    expect(piped.stdout.trim()).toBe('{"msg":"pipe"}');
  });

  it('composes with jq in a pipeline', async () => {
    const bash = await shell();
    const result = await bash.exec(
      "mcp call shell-test.echo '{\"msg\":\"hi\"}' | jq -r .msg",
    );
    expect(result.stdout).toBe('hi\n');
  });

  it('writes images to tmp and reports the path', async () => {
    const bash = await shell();
    const result = await bash.exec('mcp call shell-test.shot');
    expect(result.stdout).toMatch(/\[image\] \/tmp\/mcp-.*\.png/);
    const files = await fileStorage.listFiles();
    expect(files.some((file) => file.name.startsWith('tmp/mcp-'))).toBe(true);
  });

  it('writes image bytes when the result also carries a caption', async () => {
    const bash = await shell();
    const result = await bash.exec(
      "mcp call shell-test.caption-shot '{}' --output /tmp/shot.png",
    );
    expect(result.exitCode).toBe(0);
    // The caption still reaches stdout for a pipeline to read…
    expect(result.stdout).toContain('Screenshot captured');
    // …but the path's image extension decides the file's contents. Before this
    // rule, `page_screenshot --output shot.png` wrote the caption text.
    expect(await fileStorage.readFileAsText('tmp/shot.png')).toBe('PNG-BYTES');
  });

  it('writes the text result when the output path is not an image', async () => {
    const bash = await shell();
    await bash.exec("mcp call shell-test.caption-shot '{}' --output /tmp/shot.txt");
    expect(await fileStorage.readFileAsText('tmp/shot.txt')).toContain(
      'Screenshot captured 800x600',
    );
  });

  it('suppresses stdout with --quiet', async () => {
    const bash = await shell();
    const quiet = await bash.exec("mcp call shell-test.echo '{\"msg\":\"hi\"}' --quiet");
    expect(quiet.exitCode).toBe(0);
    expect(quiet.stdout).toBe('');

    // A failure still has to be reported, or `--quiet` would hide it.
    const failed = await bash.exec('mcp call shell-test.fail --quiet');
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain('nope');
  });

  it('turns a tool error into a non-zero exit', async () => {
    const bash = await shell();
    const result = await bash.exec('mcp call shell-test.fail');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('nope');
  });

  it('runs batch calls from JSONL', async () => {
    const bash = await shell();
    const result = await bash.exec(
      "printf '%s\\n' '{\"target\":\"shell-test.echo\",\"params\":{\"n\":1}}' '{\"target\":\"shell-test.echo\",\"params\":{\"n\":2}}' | mcp batch",
    );
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0].ok).toBe(true);
  });
});

describe('sh tool', () => {
  beforeEach(() => {
    mcpRegistry.register(fakeServer({ tools: { svg: svgTool, shot: shotTool, echo: echoTool } }));
  });

  afterEach(() => {
    mcpRegistry.unregister(testServerId);
  });

  it('returns a CallToolResult summary with stdout and exit code', async () => {
    const sh = createShellTool({}) as unknown as {
      execute: (input: unknown, options: unknown) => Promise<{
        content: Array<{ type: string; text?: string }>;
        isError: boolean;
      }>;
    };
    const result = await sh.execute(
      { command: 'echo hello && pwd' },
      { toolCallId: 'test', messages: [] },
    );
    expect(result.isError).toBe(false);
    const text = result.content.find((part) => part.type === 'text')?.text ?? '';
    const summary = JSON.parse(text) as { stdout: string; exitCode: number };
    expect(summary.stdout).toContain('hello');
    expect(summary.stdout).toContain('/');
    expect(summary.exitCode).toBe(0);
  });

  it('reports a non-zero exit as isError', async () => {
    const sh = createShellTool({}) as unknown as {
      execute: (input: unknown, options: unknown) => Promise<{
        content: Array<{ type: string; text?: string }>;
        isError: boolean;
      }>;
    };
    const result = await sh.execute(
      { command: 'exit 3' },
      { toolCallId: 'test', messages: [] },
    );
    expect(result.isError).toBe(true);
    const text = result.content.find((part) => part.type === 'text')?.text ?? '';
    expect(JSON.parse(text).exitCode).toBe(3);
  });

  it('spills output past the size cap to tmp/ and reports the path', async () => {
    // A single long line: the line cap is not in play, so this pins the
    // character cap. Written before the shell starts so the index sees it.
    await fileStorage.writeFile('big.txt', 'x'.repeat(60_000));
    const sh = createShellTool({}) as unknown as {
      execute: (input: unknown, options: unknown) => Promise<{
        content: Array<{ type: string; text?: string }>;
        isError: boolean;
      }>;
    };
    const result = await sh.execute(
      { command: 'cat /big.txt' },
      { toolCallId: 'test', messages: [] },
    );
    const summary = JSON.parse(
      result.content.find((part) => part.type === 'text')?.text ?? '{}',
    ) as { truncated?: boolean; fullOutputPath?: string };
    expect(summary.truncated).toBe(true);
    expect(summary.fullOutputPath).toMatch(/^\/tmp\/sh-.*\.txt$/);
    const stored = await fileStorage.readFileAsText(
      String(summary.fullOutputPath).replace(/^\//, ''),
    );
    expect(stored?.length).toBe(60_000);
    expect(stored?.endsWith('xxxx')).toBe(true);
  });

  it('writes an SVG result to tmp without attaching it as an image', async () => {
    const sh = createShellTool({}) as unknown as {
      execute: (input: unknown, options: unknown) => Promise<{
        content: Array<{ type: string; text?: string }>;
        isError: boolean;
      }>;
    };
    const result = await sh.execute(
      { command: 'mcp call shell-test.svg' },
      { toolCallId: 'test', messages: [] },
    );
    const summary = JSON.parse(
      result.content.find((part) => part.type === 'text')?.text ?? '{}',
    ) as { stdout: string };
    expect(summary.stdout).toMatch(/\[image\] \/tmp\/mcp-.*\.svg/);
    // SVG is text to the model and an unsupported image block to providers, so
    // it is reported by path instead of being attached.
    expect(result.content.filter((part) => part.type === 'image')).toHaveLength(0);

    const path = summary.stdout.match(/(\/tmp\/mcp-\S+\.svg)/)?.[1] ?? '';
    expect(await fileStorage.readFileAsText(path.replace(/^\//, ''))).toContain('<svg');
  });

  it('projects a tool image into model-visible content', async () => {
    const sh = createShellTool({}) as unknown as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
      toModelOutput: (options: {
        toolCallId: string;
        input: unknown;
        output: unknown;
      }) => { type: string; value: Array<{ type: string; mediaType?: string }> };
    };
    const output = await sh.execute(
      { command: 'mcp call shell-test.shot' },
      { toolCallId: 'test', messages: [] },
    );
    const modelOutput = sh.toModelOutput({ toolCallId: 'test', input: {}, output });
    expect(modelOutput.type).toBe('content');
    expect(
      modelOutput.value.some(
        (part) => part.type === 'file' && part.mediaType === 'image/png',
      ),
    ).toBe(true);
  });

  it('collects images produced by batched calls', async () => {
    const sh = createShellTool({}) as unknown as {
      execute: (input: unknown, options: unknown) => Promise<{
        content: Array<{ type: string }>;
      }>;
    };
    const result = await sh.execute(
      {
        command:
          "printf '%s\\n' '{\"target\":\"shell-test.shot\"}' '{\"target\":\"shell-test.echo\",\"params\":{\"n\":1}}' | mcp batch",
      },
      { toolCallId: 'test', messages: [] },
    );
    expect(result.content.filter((part) => part.type === 'image')).toHaveLength(1);
  });

  it('collects batched images in request order, not completion order', async () => {
    mcpRegistry.unregister(testServerId);
    const imageTool = (data: string, delayMs: number) =>
      ({
        description: 'return an image',
        inputSchema: { type: 'object' },
        execute: async () => {
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          return {
            content: [{ type: 'image', data: btoa(data), mimeType: 'image/png' }],
          };
        },
      }) as unknown as AnyTool;
    mcpRegistry.register(
      fakeServer({
        tools: { slow: imageTool('slow-image', 40), fast: imageTool('fast-image', 0) },
      }),
    );

    const sh = createShellTool({}) as unknown as {
      execute: (input: unknown, options: unknown) => Promise<{
        content: Array<{ type: string; data?: string }>;
      }>;
    };
    const result = await sh.execute(
      {
        command:
          "printf '%s\\n' '{\"target\":\"shell-test.slow\"}' '{\"target\":\"shell-test.fast\"}' | mcp batch",
      },
      { toolCallId: 'test', messages: [] },
    );

    // Line 2 finishes first; the model must still receive line 1 first.
    expect(result.content.filter((part) => part.type === 'image').map((part) => part.data)).toEqual([
      btoa('slow-image'),
      btoa('fast-image'),
    ]);
  });

  it('attaches images returned by tools.* inside node', async () => {
    const sh = createShellTool({}) as unknown as {
      execute: (input: unknown, options: unknown) => Promise<{
        content: Array<{ type: string; data?: string; text?: string }>;
        isError: boolean;
      }>;
    };
    const result = await sh.execute(
      { command: `node -e "await tools['shell-test']['shot']()"` },
      { toolCallId: 'test', messages: [] },
    );
    const summary = JSON.parse(
      result.content.find((part) => part.type === 'text')?.text ?? '{}',
    ) as { exitCode: number; attachments?: Array<{ path?: string }> };
    expect(summary.exitCode).toBe(0);
    expect(summary.attachments?.[0]?.path).toMatch(/^\/tmp\/mcp-.*\.png$/);
    // Same contract as `mcp call`: the image reaches the model, not just disk.
    expect(result.content.filter((part) => part.type === 'image')).toHaveLength(1);
  });

  it('calls MCP tools from JavaScript through exec', async () => {
    // A file avoids three levels of shell/JS quoting: the JSON must reach
    // `mcp call` with its quotes intact.
    await fileStorage.writeFile(
      'scripts/exec-mcp.js',
      [
        `const result = await exec('mcp call shell-test.echo \\'{"msg":"hi"}\\'');`,
        "console.log(result.code, result.stdout.trim());",
      ].join('\n'),
    );
    const sh = createShellTool({}) as unknown as {
      execute: (input: unknown, options: unknown) => Promise<{
        content: Array<{ type: string; text?: string }>;
        isError: boolean;
      }>;
    };
    const result = await sh.execute(
      { command: 'node /scripts/exec-mcp.js' },
      { toolCallId: 'test', messages: [] },
    );
    expect(result.isError).toBe(false);
    const summary = JSON.parse(
      result.content.find((part) => part.type === 'text')?.text ?? '{}',
    ) as { stdout: string };
    expect(summary.stdout.trim()).toBe('0 {"msg":"hi"}');
  });

  it('collects MCP images produced inside exec', async () => {
    const sh = createShellTool({}) as unknown as {
      execute: (input: unknown, options: unknown) => Promise<{
        content: Array<{ type: string }>;
        isError: boolean;
      }>;
    };
    const result = await sh.execute(
      { command: 'node -e \'await exec("mcp call shell-test.shot")\' ' },
      { toolCallId: 'test', messages: [] },
    );
    expect(result.content.filter((part) => part.type === 'image')).toHaveLength(1);
  });

  it('runs curl through the host fetch, with no allow-list', async () => {
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return new Response('shell-body', {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/plain' },
      });
    }) as typeof fetch;

    try {
      const sh = createShellTool({}) as unknown as {
        execute: (input: unknown, options: unknown) => Promise<{
          content: Array<{ type: string; text?: string }>;
          isError: boolean;
        }>;
      };
      const result = await sh.execute(
        { command: 'curl https://example.com/data' },
        { toolCallId: 'test', messages: [] },
      );
      const summary = JSON.parse(
        result.content.find((part) => part.type === 'text')?.text ?? '{}',
      ) as { stdout: string; exitCode: number };
      expect(summary.exitCode).toBe(0);
      expect(summary.stdout).toContain('shell-body');
      expect(requested).toContain('https://example.com/data');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('programmatic tool set', () => {
  it('exposes exactly the three file tools plus sh', () => {
    const allTools = {
      file_read: { description: 'read' },
      file_write: { description: 'write' },
      file_edit: { description: 'edit' },
      file_list: { description: 'list' },
      page_click: { description: 'click' },
      browser_tabs: { description: 'tabs' },
    } as never;

    const tools = buildProgrammaticToolSet(allTools, { conversationId: 'conv-1' });
    expect(Object.keys(tools).sort()).toEqual(['file_edit', 'file_read', 'file_write', 'sh']);
  });

  it('omits a file tool that the registry did not provide', () => {
    const tools = buildProgrammaticToolSet({ file_read: { description: 'read' } } as never);
    expect(Object.keys(tools).sort()).toEqual(['file_read', 'sh']);
  });
});
