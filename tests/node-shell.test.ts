/**
 * QuickJS-backed `node` command.
 *
 * Vitest serves the wasm asset as a dev-server path (`/node_modules/...`), not
 * an absolute URL, so `fetch` is patched for that one request. The production
 * build emits `/assets/emscripten-module-*.wasm`, which the extension page can
 * fetch normally.
 */

import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Bash } from 'just-bash/browser';
import { LumoFileSystem } from '@/lib/shell/vfs';
import { createNodeCommand } from '@/lib/shell/node-command';
import { fileStorage } from '@/lib/mcp/file-storage';
import { mcpRegistry } from '@/lib/mcp/registry';
import type { AnyTool, IMcpServer } from '@/lib/mcp/types';

const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('.wasm')) {
      const path = url.startsWith('/node_modules/') ? `.${url}` : url;
      const bytes = await readFile(path);
      return new Response(bytes, { status: 200 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function fakeServer(): IMcpServer {
  const tool = {
    description: 'echo input',
    inputSchema: { type: 'object' },
    execute: async (input: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(input) }],
    }),
  } as unknown as AnyTool;
  return {
    getInfo: () => ({
      id: 'node-test',
      name: 'Node Test',
      description: 'test',
      transport: 'builtin',
      builtin: true,
      enabled: true,
    }),
    connect: async () => undefined,
    disconnect: async () => undefined,
    getStatus: () => 'connected',
    getTools: () => [{ name: 'echo', description: 'echo input', inputSchema: { type: 'object' } }],
    getAITools: () => ({ echo: tool }),
    getError: () => undefined,
  };
}

async function shell(nodeOptions: Parameters<typeof createNodeCommand>[0] = {}) {
  const fs = new LumoFileSystem();
  await fs.refresh();
  return new Bash({
    fs,
    cwd: '/',
    customCommands: [createNodeCommand(nodeOptions)],
    executionLimitProfile: 'hardened',
    executionLimits: { maxExecutionTimeMs: 20_000 },
  });
}

describe('node command', () => {
  it('runs an inline script and prints console output', async () => {
    const bash = await shell();
    const result = await bash.exec("node -e 'console.log(1+1)'");
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('2\n');
  });

  it('reads and writes the shared filesystem', async () => {
    await fileStorage.writeFile('input.txt', 'hello from vfs');
    const bash = await shell();
    const result = await bash.exec(
      "node -e 'const t = await fs.readFile(\"/input.txt\", \"utf8\"); console.log(t.toUpperCase()); await fs.writeFile(\"/output.txt\", \"written\")'",
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('HELLO FROM VFS\n');
    expect(await fileStorage.readFileAsText('output.txt')).toBe('written');
  });

  it('calls MCP tools through the tools proxy', async () => {
    mcpRegistry.register(fakeServer());
    try {
      const bash = await shell();
      const result = await bash.exec(
        "node -e 'const r = await tools[\"node-test\"].echo({msg: \"js\"}); console.log(r.content[0].text)'",
      );
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('{\"msg\":\"js\"}\n');
    } finally {
      mcpRegistry.unregister('node-test');
    }
  });

  it('reports a guest error as a non-zero exit', async () => {
    const bash = await shell();
    const result = await bash.exec("node -e 'throw new Error(\"boom\")'");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('boom');
  });

  it('fetches through the host with no allow-list', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({ url, method: init?.method ?? 'GET' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const bash = await shell();
      const result = await bash.exec(
        `node -e 'const r = await fetch("https://example.com/api", {method: "POST"}); console.log(r.status, r.url, r.statusText); console.log((await r.json()).method); console.log(new TextDecoder().decode(await r.arrayBuffer()))'`,
      );
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(
        '200 https://example.com/api \nPOST\n{"url":"https://example.com/api","method":"POST"}\n',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('runs a script piped on stdin', async () => {
    const bash = await shell();
    const result = await bash.exec(`printf 'console.log("stdin")' | node -`);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('stdin\n');
  });

  it('keeps the script alive for timers and clears intervals', async () => {
    const bash = await shell();
    const late = await bash.exec("node -e 'setTimeout(() => console.log(\"late\"), 10)'");
    expect(late.stdout).toBe('late\n');
    expect(late.stderr).toBe('');

    const interval = await bash.exec(
      "node -e 'let n = 0; const id = setInterval(() => { n += 1; if (n === 2) clearInterval(id); }, 5); await new Promise((resolve) => setTimeout(resolve, 40)); queueMicrotask(() => console.log(\"n\", n)); await new Promise((resolve) => setTimeout(resolve, 5));'",
    );
    expect(interval.stderr).toBe('');
    expect(interval.stdout).toBe('n 2\n');

    const started = Date.now();
    const cleared = await bash.exec(
      "node -e 'const id = setTimeout(() => console.log(\"never\"), 5000); clearTimeout(id); console.log(\"done\")'",
    );
    expect(cleared.stdout).toBe('done\n');
    // A cleared timer must not keep the command waiting for its original delay.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('provides encoding helpers and Buffer', async () => {
    const bash = await shell();
    const result = await bash.exec(
      "node -e 'const bytes = new TextEncoder().encode(\"你好\"); console.log(bytes.length, new TextDecoder().decode(bytes), Buffer.from(\"hi\").toString(\"base64\"), atob(btoa(\"ok\")))'",
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('6 你好 aGk= ok\n');
  });

  it('provides URL, crypto, path and os', async () => {
    await fileStorage.writeFile(
      'scripts/runtime.js',
      [
        "const url = new URL('/a?x=1', 'https://example.com/base');",
        "url.searchParams.set('y', '2');",
        "const path = require('node:path');",
        "const os = require('node:os');",
        "console.log(url.toString(), url.hostname, url.searchParams.get('y'));",
        "console.log(crypto.randomUUID().length, crypto.randomBytes(4).length);",
        "console.log(path.join('/a', 'b', 'c.txt'), path.dirname('/a/b.txt'), path.extname('/a/b.txt'));",
        "console.log(os.platform(), os.tmpdir());",
      ].join('\n'),
    );
    const bash = await shell();
    const result = await bash.exec('node /scripts/runtime.js');
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'https://example.com/a?x=1&y=2 example.com 2\n36 4\n/a/b/c.txt /a .txt\nlinux /tmp\n',
    );
  });

  it('separates stdout and stderr and exposes process metadata', async () => {
    const bash = await shell();
    const result = await bash.exec(
      "node -e 'console.log(\"out\"); console.error(\"err\"); console.warn(\"warn\"); console.log(process.version, process.platform, typeof process.nextTick, typeof process.stdout.write)'",
    );
    expect(result.stdout).toBe('out\nv0.0.0-lumo linux function function\n');
    expect(result.stderr).toBe('err\nwarn\n');
  });

  it('extends fs with append, stat, readdir types, rename and unlink', async () => {
    await fileStorage.writeFile(
      'scripts/fs.js',
      [
        "await fs.writeFile('/tmp/a.txt', 'a');",
        "await fs.appendFile('/tmp/a.txt', 'b');",
        "const text = await fs.readFile('/tmp/a.txt', 'utf8');",
        "const buffer = await fs.readFile('/tmp/a.txt');",
        "const stat = await fs.stat('/tmp/a.txt');",
        "await fs.mkdir('/tmp/list', { recursive: true });",
        "await fs.writeFile('/tmp/list/one.txt', '1');",
        "const entries = await fs.readdir('/tmp/list', { withFileTypes: true });",
        "await fs.rename('/tmp/a.txt', '/tmp/b.txt');",
        "console.log(text, stat.isFile(), await fs.exists('/tmp/a.txt'), await fs.exists('/tmp/b.txt'));",
        "console.log(Buffer.isBuffer(buffer), buffer.toString());",
        "console.log(entries.map((entry) => entry.name + ':' + entry.isFile()).join(','));",
        "await fs.unlink('/tmp/b.txt');",
        "console.log(await fs.exists('/tmp/b.txt'));",
      ].join('\n'),
    );
    const bash = await shell();
    const result = await bash.exec('node /scripts/fs.js');
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('ab true false true\ntrue ab\none.txt:true\nfalse\n');
  });

  it('provides Buffer, EventEmitter, promisify and process.chdir', async () => {
    await fileStorage.writeFile(
      'scripts/helpers.js',
      [
        "const { EventEmitter } = require('node:events');",
        "const { promisify } = require('node:util');",
        "const { setTimeout: delay } = require('node:timers/promises');",
        "const events = new EventEmitter();",
        "events.on('greet', (name) => console.log('hi', name));",
        "events.emit('greet', 'lumo');",
        "const delayed = (value, callback) => setTimeout(() => callback(null, value + 1), 1);",
        "console.log(await promisify(delayed)(1));",
        "console.log(Buffer.concat([Buffer.from('ab'), Buffer.from('cd')]).toString(), Buffer.byteLength('你好'));",
        "process.chdir('/tmp');",
        "await fs.writeFile('rel.txt', 'r');",
        "console.log(process.cwd(), await fs.exists('/tmp/rel.txt'));",
        "const clone = structuredClone({ d: new Date(0), m: new Map([['x', 1]]) });",
        "console.log(clone.d.getTime(), clone.m.get('x'), typeof performance.now());",
        "console.log(await delay(1, 'tick'), global === globalThis);",
        "console.table([{ a: 1, b: 'x' }]);",
      ].join('\n'),
    );
    const bash = await shell();
    const result = await bash.exec('node /scripts/helpers.js');
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'hi lumo\n2\nabcd 6\n/tmp true\n0 1 number\ntick true\n(index)\ta\tb\n0\t1\tx\n',
    );
  });

  it('enumerates tools and answers mcp discovery', async () => {
    mcpRegistry.register(fakeServer());
    try {
      const bash = await shell();
      const result = await bash.exec(
        "node -e 'console.log(Object.keys(tools).join(\",\"), Object.keys(tools[\"node-test\"]).join(\",\"), (await mcp.tools(\"node-test\")).join(\",\")); console.log((await mcp.describe(\"node-test\", \"echo\")).name)'",
      );
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('node-test echo echo\necho\n');
    } finally {
      mcpRegistry.unregister('node-test');
    }
  });

  it('makes execSync fail with a clear instruction', async () => {
    const bash = await shell();
    const result = await bash.exec(
      "node -e 'try { execSync(\"echo hi\"); } catch (error) { console.log(error.message.includes(\"not available\")) }'",
    );
    expect(result.stdout).toBe('true\n');
    expect(result.stderr).toBe('');
  });

  it('runs shell commands with exec, execFile, env and cwd', async () => {
    await fileStorage.writeFile(
      'scripts/exec.js',
      [
        "const one = await exec('echo hi');",
        "const two = await exec('pwd; echo $FOO', { cwd: '/tmp', env: { FOO: 'bar' } });",
        "const three = await execFile('echo', ['a b']);",
        "console.log(one.code, JSON.stringify(one.stdout));",
        "console.log(JSON.stringify(two.stdout));",
        "console.log(JSON.stringify(three.stdout));",
      ].join('\n'),
    );
    const bash = await shell();
    const result = await bash.exec('node /scripts/exec.js');
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('0 "hi\\n"\n"/tmp\\nbar\\n"\n"a b\\n"\n');
  });

  it('reports exec failures to the callback and keeps await non-throwing', async () => {
    const bash = await shell();
    const result = await bash.exec(
      "node -e 'const result = await exec(\"exit 3\"); exec(\"exit 4\", (error, out, errOut) => console.log(result.code, error.code, JSON.stringify(out), JSON.stringify(errOut)))'",
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('3 4 "" ""\n');
  });

  it('supports callback fs, fs.promises and process.exitCode', async () => {
    await fileStorage.writeFile('/callback.txt', 'hello');
    await fileStorage.writeFile(
      'scripts/fs-callback.js',
      [
        "fs.readFile('/callback.txt', 'utf8', (error, text) => console.log('cb', error, text));",
        "fs.exists('/callback.txt', (exists) => console.log('exists', exists));",
        "fs.promises.readFile('/callback.txt', 'utf8').then((text) => console.log('promise', text));",
        "try { fs.readFileSync('/callback.txt'); } catch (error) { console.log(error.message.includes('await fs.readFile')); }",
        'process.exitCode = 5;',
      ].join('\n'),
    );
    const bash = await shell();
    const result = await bash.exec('node /scripts/fs-callback.js');
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('true\n');
    expect(result.stdout).toContain('cb null hello\n');
    expect(result.stdout).toContain('promise hello\n');
    expect(result.stdout).toContain('exists true\n');
    expect(result.exitCode).toBe(5);
  });

  it('can kill an exec child process', async () => {
    await fileStorage.writeFile(
      'scripts/kill.js',
      [
        "const child = exec('sleep 5');",
        'setTimeout(() => child.kill(), 20);',
        'const result = await child;',
        "console.log(child.killed, result.code !== 0, result.stderr.includes('aborted'));",
      ].join('\n'),
    );
    const bash = await shell();
    const result = await bash.exec('node /scripts/kill.js');
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('true true true\n');
  });

  it('bounds node-to-node recursion', async () => {
    await fileStorage.writeFile(
      'scripts/depth.js',
      [
        "const result = await exec('node /scripts/depth.js');",
        "if (result.stderr) { console.error(result.stderr.trim()); process.exit(result.code || 1); }",
        "console.log('depth', process.env.LUMO_NODE_DEPTH);",
      ].join('\n'),
    );
    // The default budget is 256, so this test pins a small one explicitly.
    const bash = await shell({ maxNestingDepth: 3 });
    const result = await bash.exec('node /scripts/depth.js');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('maximum node nesting depth');
  });
});
