/**
 * Regression tests for the converged defect list.
 *
 * Each block is named after the defect id in the analysis so a future change
 * that reintroduces it is obvious:
 *
 *   E0-*  wrong results / crashes          E1-*  real gaps now implemented
 *   E2-*  Node semantics + performance
 */

import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Bash } from 'just-bash/browser';
import { LumoFileSystem } from '@/lib/shell/vfs';
import { createNodeCommand } from '@/lib/shell/node-command';
import { createArchiveCommands } from '@/lib/shell/archive-command';
import { createIconvCommand } from '@/lib/shell/iconv-command';
import { createYqCommand } from '@/lib/shell/yq-command';
import { fileStorage } from '@/lib/mcp/file-storage';
import { mcpRegistry } from '@/lib/mcp/registry';
import type { AnyTool, IMcpServer } from '@/lib/mcp/types';
import { hostTimeZone } from '@/lib/shell/env';

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

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function shell(limits: { maxExecutionTimeMs?: number } = {}) {
  const fs = new LumoFileSystem();
  await fs.refresh();
  return new Bash({
    fs,
    cwd: '/',
    env: { TZ: 'Asia/Shanghai' },
    customCommands: [
      createNodeCommand(),
      ...createArchiveCommands(),
      createIconvCommand(),
      createYqCommand(),
    ],
    executionLimitProfile: 'hardened',
    executionLimits: { maxExecutionTimeMs: limits.maxExecutionTimeMs ?? 30_000 },
  });
}

/** Write raw bytes into the shared VFS. */
async function writeBytes(name: string, bytes: Uint8Array): Promise<void> {
  await fileStorage.writeFile(name, new Blob([bytes as unknown as BlobPart]));
}

/** Run a `node -e` snippet in a fresh shell. */
async function node(code: string, limits: { maxExecutionTimeMs?: number } = {}) {
  const bash = await shell(limits);
  const escaped = code.replace(/'/g, "'\\''");
  return bash.exec(`node -e '${escaped}'`);
}

/* -------------------------------------------------------------------------- */

describe('E0 correctness', () => {
  it('E0-1 reports an unhandled rejection and exits non-zero', async () => {
    const result = await node("fs.readFile('/missing-unhandled'); console.log('assumed-ok')");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('assumed-ok');
    expect(result.stderr).toMatch(/Uncaught|ENOENT|no such file/i);
  });

  it('E0-1 keeps a handled rejection quiet', async () => {
    const result = await node(
      "try { await fs.readFile('/missing-handled') } catch (error) { console.log(error.code) }",
    );
    expect(result.stdout).toBe('ENOENT\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('E0-2 fs.rm does not delete a non-empty directory by default', async () => {
    const result = await node(
      "await fs.mkdir('/rmdir-test', {recursive: true}); await fs.writeFile('/rmdir-test/f', 'x');" +
        "try { await fs.rm('/rmdir-test') } catch (error) { console.log(error.code) }" +
        "console.log(await fs.exists('/rmdir-test/f'));" +
        "await fs.rm('/rmdir-test', {recursive: true}); console.log(await fs.exists('/rmdir-test'))",
    );
    expect(result.stdout).toBe('ENOTEMPTY\ntrue\nfalse\n');
    expect(result.stderr).toBe('');
  });

  it('E0-3 honours the write encoding for hex and latin1', async () => {
    const result = await node(
      "await fs.writeFile('/encode/hex.txt', '6869', 'hex');" +
        "await fs.writeFile('/encode/latin1.txt', Buffer.from([0xe9]), 'latin1');" +
        "console.log(await fs.readFile('/encode/hex.txt', 'utf8'), Buffer.from(await fs.readFile('/encode/latin1.txt')).toString('hex'))",
    );
    expect(result.stdout).toBe('hi e9\n');
  });

  it('E0-4 strips a shebang instead of throwing', async () => {
    await fileStorage.writeFile(
      'scripts/shebang.js',
      '#!/usr/bin/env node\nconsole.log("shebang", process.argv.length >= 2)\n',
    );
    const bash = await shell();
    const result = await bash.exec('node /scripts/shebang.js');
    expect(result.stdout).toBe('shebang true\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('E0-5 prints the value for node -p', async () => {
    const bash = await shell();
    const simple = await bash.exec("node -p '1 + 1'");
    expect(simple.stdout).toBe('2\n');
    const object = await bash.exec(`node -p 'JSON.stringify({a: 1})'`);
    expect(object.stdout).toBe('{"a":1}\n');
    // A statement list falls back to the block form instead of failing.
    const statements = await bash.exec("node -p 'const x = 2; x * 3'");
    expect(statements.exitCode).toBe(0);
  });

  it('E0-5 prints non-primitive results with inspect', async () => {
    const bash = await shell();
    const result = await bash.exec("node -p '[1, 2]'");
    expect(result.stdout).toBe('[ 1, 2 ]\n');
  });

  it('E0-6 keeps error codes and names across the bridge', async () => {
    const result = await node(
      "try { await fs.readFile('/nope') } catch (error) {" +
        "console.log(error.code, error instanceof Error, String(error.message).includes('nope')) }",
    );
    expect(result.stdout).toBe('ENOENT true true\n');
  });

  it('E0-8 cannot reset the node nesting depth from the guest environment', async () => {
    const result = await node(
      "const out = await exec('node -e \"console.log(process.env.LUMO_NODE_DEPTH)\"', {env: {LUMO_NODE_DEPTH: '0'}});" +
        'console.log(out.stdout.trim(), out.code)',
    );
    expect(result.stdout).toBe('1 0\n');
  });
});

/* -------------------------------------------------------------------------- */

describe('E1 Node API gaps', () => {
  it('E1-1 hashes with known vectors', async () => {
    const result = await node(
      "const c = require('node:crypto');" +
        "const md5 = c.createHash('md5').update('abc').digest('hex');" +
        "const sha1 = c.createHash('sha1').update('abc').digest('hex');" +
        "const sha256 = c.createHash('sha256').update('abc').digest('hex');" +
        "const sha512 = c.createHash('sha512').update('abc').digest('hex').slice(0, 32);" +
        "const hmac = c.createHmac('sha256', 'key').update('abc').digest('hex');" +
        "const empty = c.createHash('sha256').update('').digest('hex');" +
        'console.log(md5); console.log(sha1); console.log(sha256); console.log(sha512); console.log(hmac); console.log(empty)',
    );
    expect(result.stdout.trim().split('\n')).toStrictEqual([
      '900150983cd24fb0d6963f7d28e17f72',
      'a9993e364706816aba3e25717850c26c9cd0d89d',
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      'ddaf35a193617abacc417349ae204131',
      '9c196e32dc0175f86f4b1cb89289d6619de6bee699e4c378e68309ed97a1a6ab',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ]);
    expect(result.stderr).toBe('');
  });

  it('E1-1 supports timingSafeEqual, randomInt and subtle.digest', async () => {
    const result = await node(
      "const c = require('node:crypto');" +
        "const a = Buffer.from('abcd'); const b = Buffer.from('abcd');" +
        "console.log(c.timingSafeEqual(a, b), c.timingSafeEqual(a, Buffer.from('abce')));" +
        'const n = c.randomInt(1, 5); console.log(n >= 1 && n < 5);' +
        "const digest = await c.webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));" +
        "console.log(Buffer.from(digest).toString('hex').slice(0, 8))",
    );
    expect(result.stdout).toBe('true false\ntrue\nba7816bf\n');
  });

  it('E1-2 provides AbortController and honours fetch signals', async () => {
    const result = await node(
      'console.log(typeof AbortController, typeof AbortSignal, typeof AbortSignal.timeout, typeof AbortSignal.abort)' +
        '; const c = new AbortController(); c.signal.addEventListener("abort", () => console.log("aborted", c.signal.aborted)); c.abort();' +
        'try { c.signal.throwIfAborted() } catch (error) { console.log(error.name, error.code) }',
    );
    expect(result.stdout).toBe('function function function function\naborted true\nAbortError ABORT_ERR\n');
  });

  it('E1-2 aborts an in-flight fetch', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
      return new Response('late');
    }) as typeof fetch;

    const bash = await shell();
    const started = Date.now();
    const result = await bash.exec(
      "node -e 'const controller = new AbortController(); setTimeout(() => controller.abort(), 50); try { await fetch(\"https://example.com\", {signal: controller.signal}) } catch (error) { console.log(error.name) }'",
    );
    expect(result.stdout).toBe('AbortError\n');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('E1-3 exposes Headers/Response and keeps every set-cookie', async () => {
    // Node's Headers collapses duplicates, so emulate Chrome's Response shape:
    // `forEach` yields the ordinary headers and `getSetCookie()` the cookies.
    const body = new TextEncoder().encode(JSON.stringify({ ok: true }));
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      statusText: '',
      url: 'https://example.com/login',
      redirected: false,
      type: 'basic',
      headers: {
        forEach(callback: (value: string, key: string) => void) {
          callback('application/json', 'content-type');
        },
        getSetCookie: () => ['a=1; Path=/', 'b=2; Path=/'],
      },
      arrayBuffer: async () => body.buffer,
    })) as unknown as typeof fetch;

    const bash = await shell();
    const result = await bash.exec(
      `node -e 'const response = await fetch("https://example.com/login"); console.log(response.status, response.ok); console.log(JSON.stringify(response.headers.getSetCookie())); console.log((await response.json()).ok, typeof response.body.getReader, typeof response.bytes)'`,
    );
    expect(result.stdout).toBe('200 true\n["a=1; Path=/","b=2; Path=/"]\ntrue function function\n');
  });

  it('E1-4 decodes GBK and honours fatal/BOM rules', async () => {
    await writeBytes('gbk/raw.bin', new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]));
    await writeBytes('enc/bom.txt', new Uint8Array([0xef, 0xbb, 0xbf, 0x61]));
    const result = await node(
      "const bytes = await fs.readFile('/gbk/raw.bin');" +
        "console.log(new TextDecoder('gbk').decode(bytes));" +
        "console.log(new TextDecoder('gb18030').encoding);" +
        "try { new TextDecoder('utf-8', {fatal: true}).decode(new Uint8Array([0xff])) } catch (error) { console.log('fatal-threw') }" +
        "const withBom = await fs.readFile('/enc/bom.txt');" +
        "const stripped = new TextDecoder('utf-8').decode(withBom);" +
        "const kept = new TextDecoder('utf-8', {ignoreBOM: true}).decode(withBom);" +
        "console.log(stripped === 'a', kept.length === 2, kept.charCodeAt(0) === 0xfeff);" +
        "const destination = new Uint8Array(4);" +
        "const info = new TextEncoder().encodeInto('你好', destination);" +
        'console.log(info.read, info.written, Array.from(destination).join(","))',
    );
    expect(result.stdout).toBe('你好\ngb18030\nfatal-threw\ntrue true true\n1 3 228,189,160,0\n');
    expect(result.stderr).toBe('');
  });

  it('E1-5 provides node:zlib', async () => {
    const result = await node(
      "const zlib = require('node:zlib');" +
        "const compressed = zlib.gzipSync('hello zlib');" +
        "console.log(compressed[0], compressed[1], zlib.gunzipSync(compressed).toString())",
    );
    expect(result.stdout).toBe('31 139 hello zlib\n');
  });

  it('E1-6 streams child stdout through events', async () => {
    const result = await node(
      "const { exec } = require('node:child_process');" +
        "const child = exec('echo streamed');" +
        "child.stdout.on('data', (chunk) => console.log('chunk:', chunk.toString().trim()));" +
        "child.on('exit', (code) => console.log('exit:', code));" +
        'await new Promise((resolve) => child.on("close", resolve))',
    );
    expect(result.stdout).toBe('chunk: streamed\nexit: 0\n');
  });

  it('E1-7 bounds node by the shell budget', async () => {
    const bash = await shell({ maxExecutionTimeMs: 1_500 });
    const started = Date.now();
    const result = await bash.exec("node -e 'await sleep(20000)'");
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it('E1-8 answers the node CLI probes', async () => {
    await fileStorage.writeFile('scripts/check.js', 'console.log("executed")\n');
    const bash = await shell();
    const version = await bash.exec('node -v');
    expect(version.stdout).toBe('v0.0.0-lumo\n');
    expect(version.stderr).toBe('');
    expect(version.exitCode).toBe(0);
    const help = await bash.exec('node --help');
    expect(help.stdout).toContain('--check');
    const check = await bash.exec('node --check /scripts/check.js');
    expect(check.stdout).toBe('');
    expect(check.stderr).toBe('');
    expect(check.exitCode).toBe(0);
    const bad = await bash.exec("node -e 'const = 1'");
    expect(bad.exitCode).not.toBe(0);
    const unknownFlag = await bash.exec('node --inspect /x.js');
    expect(unknownFlag.exitCode).toBe(9);
    expect(unknownFlag.stderr).toContain('bad option');
  });

  it('E1-9 does not truncate a normal 4 MiB fetch', async () => {
    // The host-memory guard is 64 MiB; a 4 MiB response is delivered whole.
    globalThis.fetch = (async () =>
      new Response('x'.repeat(4 * 1024 * 1024 + 128), { status: 200 })) as typeof fetch;
    const bash = await shell();
    const result = await bash.exec(
      `node -e 'const response = await fetch("https://example.com/big"); console.log(response.truncated, response.size, (await response.text()).length)'`,
    );
    expect(result.stdout).toBe('false 4194432 4194432\n');
  });

  it('E1-10 forwards the host timezone to the shell', async () => {
    expect(hostTimeZone()).toBeTruthy();
    const bash = await shell();
    const result = await bash.exec('echo $TZ');
    expect(result.stdout.trim()).toBe('Asia/Shanghai');
  });

  it('E1-11 round-trips tar and zip archives', async () => {
    const bash = await shell();
    const tar = await bash.exec(
      [
        "mkdir -p /archive/inner",
        "printf 'one' > /archive/a.txt",
        "printf 'two' > /archive/inner/b.txt",
        'cd / && tar -czf /archive/out.tar.gz archive',
        'mkdir -p /archive/tar-out',
        'cd /archive/tar-out && tar -xzf /archive/out.tar.gz',
        'cat /archive/tar-out/archive/a.txt /archive/tar-out/archive/inner/b.txt',
        'tar -tzf /archive/out.tar.gz',
      ].join('; '),
    );
    expect(tar.stderr).toBe('');
    expect(tar.stdout).toContain('onetwo');
    expect(tar.stdout).toContain('archive/inner/b.txt');

    const zip = await bash.exec(
      [
        'zip -r /archive/out.zip /archive/a.txt /archive/inner',
        'mkdir -p /archive/zip-out',
        'unzip -o -d /archive/zip-out /archive/out.zip',
        'cat /archive/zip-out/archive/a.txt /archive/zip-out/archive/inner/b.txt',
        'unzip -l /archive/out.zip',
      ].join('; '),
    );
    expect(zip.stderr).toBe('');
    expect(zip.stdout).toContain('onetwo');
    expect(zip.stdout).toContain('archive/inner/b.txt');
  });

  it('E1-12 converts GBK to UTF-8', async () => {
    await writeBytes('gbk/legacy.txt', new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]));
    const bash = await shell();
    const result = await bash.exec('iconv -f gbk -t utf-8 /gbk/legacy.txt');
    expect(result.stdout).toBe('你好');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    const piped = await bash.exec("iconv -f gbk -t utf-8 /gbk/legacy.txt | cat");
    expect(piped.stdout).toBe('你好');
    const unsupported = await bash.exec('iconv -f utf-8 -t gbk /gbk/legacy.txt');
    expect(unsupported.exitCode).toBe(1);
  });

  it('E1-13 reads YAML as JSON and edits it', async () => {
    await fileStorage.writeFile('conf/app.yml', 'name: demo\nservices:\n  web:\n    port: 8080\n');
    const bash = await shell();
    const asJson = await bash.exec("yq '.' /conf/app.yml");
    expect(JSON.parse(asJson.stdout)).toStrictEqual({
      name: 'demo',
      services: { web: { port: 8080 } },
    });
    const scalar = await bash.exec("yq -r '.services.web.port' /conf/app.yml");
    expect(scalar.stdout).toBe('8080\n');
    const assigned = await bash.exec("yq '.services.web.port = 9090' /conf/app.yml | yq -r '.services.web.port' -");
    expect(assigned.stdout).toBe('9090\n');
    const asYaml = await bash.exec("yq -o yaml '.services' /conf/app.yml");
    expect(asYaml.stdout).toContain('web:');
  });

  it('E1-14 fills in Buffer methods and encodings', async () => {
    const result = await node(
      "const b = Buffer.from('abcd');" +
        "const view = b.slice(0, 2); view[0] = 120;" +
        "console.log(b.toString(), typeof b.readUInt32BE(), typeof b.indexOf());" +
        "const le = Buffer.alloc(4); le.writeUInt32BE(0xdeadbeef, 0);" +
        "console.log(le.toString('hex'), le.readUInt32BE(0).toString(16));" +
        "console.log(Buffer.from('hi').toString('base64url'), Buffer.isEncoding('utf16le'), Buffer.compare(Buffer.from('a'), Buffer.from('b')));" +
        "console.log(Buffer.from('你好', 'utf16le').toString('utf16le'), Buffer.from('你好', 'utf16le').length);",
    );
    expect(result.stdout).toBe(
      'xbcd number number\ndeadbeef deadbeef\naGk true -1\n你好 4\n',
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('E2 Node semantics', () => {
  it('E2-1 returns Timeout objects that can unref and refresh', async () => {
    const result = await node(
      'const timer = setTimeout(() => console.log("fired"), 5);' +
        'console.log(typeof timer, typeof timer.unref, timer.hasRef());' +
        'timer.unref(); console.log(timer.hasRef());' +
        'const long = setTimeout(() => console.log("never"), 60000); long.unref();' +
        'await new Promise((resolve) => setTimeout(resolve, 20));' +
        'console.log("done")',
    );
    expect(result.stdout).toBe('object function true\nfalse\nfired\ndone\n');
  });

  it('E2-2 runs exit hooks, writes to stdout with a callback, and exits from a timer', async () => {
    const hooks = await node(
      'process.on("exit", () => console.log("exit-hook"));' +
        'await new Promise((resolve) => process.stdout.write("written", resolve));' +
        'console.log("body")',
    );
    expect(hooks.stdout).toBe('written\nbody\nexit-hook\n');
    expect(hooks.exitCode).toBe(0);

    const timerExit = await node('setTimeout(() => process.exit(7), 1); await sleep(50)');
    expect(timerExit.exitCode).toBe(7);
    expect(timerExit.stderr).toBe('');
  });

  it('E2-3 formats console.log placeholders', async () => {
    const result = await node(`console.log('%s has %d items', 'cart', 3); console.log('%j', {a: 1})`);
    expect(result.stdout).toBe('cart has 3 items\n{"a":1}\n');
  });

  it('E2-4 serialises URLs and query strings per spec', async () => {
    const result = await node(
      "console.log(new URL('mailto:a@b.c').href);" +
        "console.log(new URL('https://example.com/a b?x=1').pathname);" +
        "console.log(new URLSearchParams({a: \"it's~*\"}).toString());" +
        "console.log(new URLSearchParams('a=1&b=2').size, URL.canParse('https://x'), URL.canParse('notaurl'));" +
        "const u = new URL('https://example.com'); u.searchParams.set('q', 'a b'); console.log(u.toString())",
    );
    expect(result.stdout).toBe(
      'mailto:a@b.c\n/a%20b\na=it%27s%7E*\n2 true false\nhttps://example.com/?q=a+b\n',
    );
  });

  it('E2-5 compares values deeply the way util.isDeepStrictEqual does', async () => {
    const result = await node(
      "const util = require('node:util');" +
        "console.log(util.isDeepStrictEqual({a: 1, b: 2}, {b: 2, a: 1}));" +
        "console.log(util.isDeepStrictEqual(NaN, NaN), util.isDeepStrictEqual([1, [2]], [1, [2]]));" +
        "console.log(util.isDeepStrictEqual(new Map([['a', 1]]), new Map([['a', 1]])));" +
        "console.log(util.isDeepStrictEqual({a: undefined}, {}))",
    );
    expect(result.stdout).toBe('true\ntrue true\ntrue\nfalse\n');
  });

  it('E2-6 supports assert.rejects and AssertionError', async () => {
    const result = await node(
      "const assert = require('node:assert/strict');" +
        "await assert.rejects(async () => { throw new Error('boom') }, /boom/);" +
        "console.log('rejected-ok');" +
        "try { assert.deepStrictEqual({a: 1}, {a: 2}) } catch (error) { console.log(error.name, error.code) }" +
        "assert.throws(() => { throw new TypeError('t') }, TypeError); console.log('throws-ok')",
    );
    expect(result.stdout).toBe('rejected-ok\nAssertionError ERR_ASSERTION\nthrows-ok\n');
  });

  it('E2-7 reports real os values', async () => {
    const result = await node(
      "const os = require('node:os');" +
        'console.log(os.cpus().length > 0, os.totalmem() > 0, os.homedir(), os.tmpdir())',
    );
    expect(result.stdout).toBe('true true / /tmp\n');
  });

  it('E2-8 structuredClone rejects functions', async () => {
    const result = await node(
      'try { structuredClone({f() {}}) } catch (error) { console.log(error.name) }' +
        'const clone = structuredClone({d: new Date(0), m: new Map([["k", 1]])});' +
        'console.log(clone.d.getTime(), clone.m.get("k"))',
    );
    expect(result.stdout).toBe('DataCloneError\n0 1\n');
  });

  it('E2-9 exposes chmod, utimes and realpath', async () => {
    const result = await node(
      "await fs.writeFile('/perm.txt', 'x'); await fs.chmod('/perm.txt', 0o600);" +
        "const stat = await fs.stat('/perm.txt'); console.log((stat.mode & 0o777).toString(8));" +
        "await fs.utimes('/perm.txt', new Date(0), new Date(1000));" +
        "console.log((await fs.stat('/perm.txt')).mtime.getTime());" +
        "console.log(await fs.realpath('/perm.txt'));" +
        "console.log(typeof fs.createReadStream, typeof fs.open)",
    );
    expect(result.stdout).toBe('600\n1000\n/perm.txt\nfunction function\n');
  });

  it('E2-10 fills Dirent paths and returns the created directory', async () => {
    const result = await node(
      "console.log(await fs.mkdir('/nested/deep', {recursive: true}));" +
        "await fs.writeFile('/nested/deep/file.txt', 'x');" +
        "const entries = await fs.readdir('/nested/deep', {withFileTypes: true});" +
        "console.log(entries[0].parentPath, entries[0].path, entries[0].isFile());" +
        "console.log((await fs.readdir('/nested', {recursive: true})).join(','))",
    );
    expect(result.stdout).toBe('/nested/deep\n/nested/deep /nested/deep/file.txt true\ndeep,deep/file.txt\n');
  });

  it('E2-11 provides querystring, string_decoder and perf_hooks', async () => {
    const result = await node(
      "const qs = require('node:querystring');" +
        "console.log(qs.stringify({a: 'b c'}), JSON.stringify(qs.parse('a=1&a=2')));" +
        "const { StringDecoder } = require('node:string_decoder');" +
        'const decoder = new StringDecoder("utf8");' +
        "const bytes = Buffer.from('你');" +
        'console.log(JSON.stringify(decoder.write(bytes.subarray(0, 2))), decoder.end(bytes.subarray(2)));' +
        "const { performance: perf } = require('node:perf_hooks');" +
        'console.log(typeof perf.now())',
    );
    expect(result.stdout).toBe('a=b+c {"a":["1","2"]}\n"" 你\nnumber\n');
  });

  it('E2-12 does not pay a timer tick per await', async () => {
    const result = await node(
      "const started = Date.now(); for (let i = 0; i < 100; i++) await fs.exists('/');" +
        'console.log(Date.now() - started < 800)',
    );
    expect(result.stdout).toBe('true\n');
  });

  it('E2-15 requires relative files and JSON from the VFS', async () => {
    await fileStorage.writeFile('proj/util.js', 'module.exports.double = (n) => n * 2;\n');
    await fileStorage.writeFile('proj/nested/deep.js', "module.exports = require('../util.js').double(3);\n");
    await fileStorage.writeFile('proj/data.json', '{"name":"lumo"}\n');
    await fileStorage.writeFile(
      'proj/main.js',
      [
        "const { double } = require('./util.js');",
        "const deep = require('./nested/deep.js');",
        "const data = require('./data.json');",
        'console.log(double(2), deep, data.name);',
      ].join('\n'),
    );
    const bash = await shell();
    const result = await bash.exec('cd /proj && node main.js');
    expect(result.stdout).toBe('4 6 lumo\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);

    const missing = await bash.exec("cd /proj && node -e 'require(\"./nope.js\")'");
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("Cannot find module './nope.js'");
  });

  it('E2-16 runs ES module syntax', async () => {
    await fileStorage.writeFile('esm/helper.js', 'module.exports = { greeting: "hi" };\n');
    await fileStorage.writeFile(
      'esm/main.mjs',
      [
        "import fs from 'node:fs';",
        "import { greeting } from './helper.js';",
        "import * as path from 'node:path';",
        "await fs.writeFile('/esm/out.txt', greeting + ' ' + path.basename('/a/b.txt'));",
        "const text = await fs.readFile('/esm/out.txt', 'utf8');",
        "const value = 1 + 1;",
        'console.log(text, value, import.meta.url);',
      ].join('\n'),
    );
    const bash = await shell();
    const result = await bash.exec('node /esm/main.mjs');
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('hi b.txt 2 file:///esm/main.mjs\n');
  });

  it('E2-16 downgrades export statements too', async () => {
    await fileStorage.writeFile(
      'esm/exports.mjs',
      [
        'export const answer = 42;',
        'export function double(n) { return n * 2; }',
        'export default { kind: "demo" };',
        'export { answer as renamed };',
        'console.log(answer, double(2), "ok");',
      ].join('\n'),
    );
    const bash = await shell();
    const result = await bash.exec('node /esm/exports.mjs');
    expect(result.stdout).toBe('42 4 ok\n');
    expect(result.stderr).toBe('');
  });

  it('E2-9 explains why links cannot exist instead of throwing a TypeError', async () => {
    const result = await node(
      "try { await fs.symlink('/a', '/b') } catch (error) { console.log(error.code, error.message.includes('cp')) }",
    );
    expect(result.stdout).toBe('ENOSYS true\n');
  });

  it('E2-14 spills MCP images to the VFS instead of the JSON bridge', async () => {
    const tool = {
      description: 'screenshot',
      inputSchema: { type: 'object' },
      execute: async () => ({
        content: [
          { type: 'text', text: 'shot' },
          { type: 'image', data: Buffer.from('fake-png').toString('base64'), mimeType: 'image/png' },
        ],
      }),
    } as unknown as AnyTool;
    const server: IMcpServer = {
      getInfo: () => ({
        id: 'image-test',
        name: 'Image Test',
        description: 'test',
        transport: 'builtin',
        builtin: true,
        enabled: true,
      }),
      connect: async () => undefined,
      disconnect: async () => undefined,
      getStatus: () => 'connected',
      getTools: () => [{ name: 'shot', description: 'screenshot', inputSchema: { type: 'object' } }],
      getAITools: () => ({ shot: tool }),
      getError: () => undefined,
    };
    mcpRegistry.register(server);
    try {
      const bash = await shell();
      const result = await bash.exec(
        `node -e 'const r = await tools["image-test"].shot({}); console.log(r.content[0].text, r.content[1].type, r.content[1].data === undefined, r.content[1].path.startsWith("/tmp/mcp-"))'`,
      );
      expect(result.stdout).toBe('shot image true true\n');
      expect(result.stderr).toBe('');
    } finally {
      mcpRegistry.unregister('image-test');
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('E3 remaining small gaps', () => {
  it('E3-1 formats through the host ICU', async () => {
    const dateFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'short' });
    const numberFormat = new Intl.NumberFormat('de-DE');
    const currency = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' });
    const list = new Intl.ListFormat('en', { type: 'conjunction' });
    const result = await node(
      "console.log(new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', dateStyle: 'short'}).format(new Date(0)));" +
        "console.log(new Intl.NumberFormat('de-DE').format(1234.5));" +
        "console.log(new Intl.NumberFormat('zh-CN', {style: 'currency', currency: 'CNY'}).format(12.5));" +
        "console.log(new Intl.ListFormat('en', {type: 'conjunction'}).format(['a', 'b', 'c']));" +
        "console.log(new Date(0).toLocaleDateString('en-US', {timeZone: 'UTC'}), new Date(0).toLocaleTimeString('en-US', {timeZone: 'UTC'}));" +
        "console.log((1234.5).toLocaleString('en-US'), 'b'.localeCompare('a'));" +
        "console.log(new Intl.DateTimeFormat('en-US', {timeZone: 'UTC'}).resolvedOptions().timeZone)",
    );
    expect(result.stdout).toBe(
      [
        dateFormat.format(new Date(0)),
        numberFormat.format(1234.5),
        currency.format(12.5),
        list.format(['a', 'b', 'c']),
        `${new Date(0).toLocaleDateString('en-US', { timeZone: 'UTC' })} ${new Date(0).toLocaleTimeString('en-US', { timeZone: 'UTC' })}`,
        `${(1234.5).toLocaleString('en-US')} 1`,
        'UTC',
      ].join('\n') + '\n',
    );
    expect(result.stderr).toBe('');
  });

  it('E3-2 exposes module/exports/__filename/__dirname to the entry script', async () => {
    await fileStorage.writeFile(
      'cjs/main.js',
      [
        'const path = require("node:path");',
        'module.exports = { where: __dirname, file: __filename, base: path.basename(__filename) };',
        'console.log(__dirname, __filename, module.exports.base, require.main === module);',
      ].join('\n'),
    );
    const bash = await shell();
    const result = await bash.exec('node /cjs/main.js');
    expect(result.stdout).toBe('/cjs /cjs/main.js main.js true\n');
    expect(result.stderr).toBe('');
  });

  it('E3-3 derives keys with pbkdf2 and hkdf', async () => {
    const result = await node(
      "const c = require('node:crypto');" +
        "console.log(c.pbkdf2Sync('password', 'salt', 1, 32, 'sha256').toString('hex'));" +
        "console.log(c.pbkdf2Sync('password', 'salt', 4096, 32, 'sha256').toString('hex'));" +
        "const ikm = Buffer.alloc(22, 0x0b);" +
        "const salt = Buffer.from('000102030405060708090a0b0c', 'hex');" +
        "const info = Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex');" +
        "console.log(Buffer.from(c.hkdfSync('sha256', ikm, salt, info, 42)).toString('hex'));" +
        "const filled = Buffer.alloc(8); c.randomFillSync(filled);" +
        'console.log(filled.length)',
    );
    expect(result.stdout.trim().split('\n')).toStrictEqual([
      '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b',
      'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a',
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
      '8',
    ]);
    expect(result.stderr).toBe('');
  });

  it('E3-4 round-trips deflate/inflate', async () => {
    const result = await node(
      "const zlib = require('node:zlib');" +
        "const packed = zlib.deflateSync('deflate me');" +
        "console.log(packed.length > 0, zlib.inflateSync(packed).toString());" +
        "const stream = zlib.createDeflate();" +
        "const chunks = []; stream.on('data', (chunk) => chunks.push(chunk));" +
        "stream.write('a'); stream.write('b'); stream.end();" +
        "await new Promise((resolve) => stream.on('end', resolve));" +
        "console.log(zlib.inflateSync(Buffer.concat(chunks)).toString())",
    );
    expect(result.stdout).toBe('true deflate me\nab\n');
    expect(result.stderr).toBe('');
  });

  it('E3-5 parses argv with util.parseArgs', async () => {
    const result = await node(
      "const util = require('node:util');" +
        "const parsed = util.parseArgs({args: ['-v', '--name', 'lumo', 'file.txt'], options: {" +
        "verbose: {type: 'boolean', short: 'v'}, name: {type: 'string'}}, allowPositionals: true});" +
        "console.log(JSON.stringify(parsed.values), parsed.positionals.join(','));" +
        "try { util.parseArgs({args: ['--nope'], options: {}}) } catch (error) { console.log(error.message) }",
    );
    expect(result.stdout).toBe('{"verbose":true,"name":"lumo"} file.txt\nUnknown option \'--nope\'\n');
  });

  it('E3-6 keeps the legacy url.parse API', async () => {
    const result = await node(
      "const url = require('node:url');" +
        "const parsed = url.parse('https://user:pass@example.com:8080/a/b?x=1#frag');" +
        "console.log(parsed.protocol, parsed.hostname, parsed.port, parsed.pathname, parsed.hash, parsed.auth);" +
        "console.log(url.format({protocol: 'https:', hostname: 'example.com', pathname: '/x', query: {a: 1}}));" +
        "console.log(url.resolve('https://example.com/a/b', '../c'))",
    );
    expect(result.stdout).toBe('https: example.com 8080 /a/b #frag user:pass\nhttps://example.com/x?a=1\nhttps://example.com/c\n');
  });

  it('E3-7 provides a real path.win32', async () => {
    const bash = await shell();
    const path = await import('node:path');
    const script = [
      "const BS = String.fromCharCode(92);",
      "const p = require('node:path');",
      "const win = 'C:' + BS + 'a' + BS + 'b.txt';",
      "console.log(p.win32.basename(win), p.win32.sep.charCodeAt(0));",
      "console.log(p.win32.join('a', 'b', 'c'), p.win32.dirname(win));",
      "console.log(p.win32.extname('C:' + BS + 'a.tar.gz'), p.win32.isAbsolute(win));",
      "console.log(p.posix.join('a', 'b'), p.basename('/a/b.txt'));",
    ].join('');
    const result = await bash.exec(`node -e "${script.replace(/"/g, '\\"')}"`);
    expect(result.stdout).toBe(
      [
        `${path.win32.basename('C:\\a\\b.txt')} 92`,
        `${path.win32.join('a', 'b', 'c')} ${path.win32.dirname('C:\\a\\b.txt')}`,
        '.gz true',
        'a/b b.txt',
      ].join('\n') + '\n',
    );
    expect(result.stderr).toBe('');
  });

  it('E3-8 iterates directories and refuses to fake a watcher', async () => {
    const result = await node(
      "await fs.mkdir('/opendir/a', {recursive: true});" +
        "await fs.writeFile('/opendir/b.txt', 'x');" +
        'const names = [];' +
        "for await (const entry of await fs.opendir('/opendir')) names.push(entry.name);" +
        "console.log(names.sort().join(','));" +
        "try { fs.watch('/opendir') } catch (error) { console.log(error.message.includes('IndexedDB')) }",
    );
    expect(result.stdout).toBe('a,b.txt\ntrue\n');
  });

  it('E3-9 reads 64-bit integers and swaps byte order', async () => {
    const result = await node(
      "const big = Buffer.from([0, 0, 0, 0, 0, 0, 1, 2]);" +
        'console.log(big.readBigInt64BE(0).toString(), big.readBigUInt64LE(0).toString());' +
        "const swapped = Buffer.from([1, 2, 3, 4]).swap32();" +
        'console.log(swapped.toString("hex"))',
    );
    expect(result.stdout).toBe('258 144396663052566528\n04030201\n');
  });

  it('E3-10 counts, indents and routes a Console', async () => {
    const result = await node(
      "console.group('outer'); console.log('inner'); console.groupEnd();" +
        "console.count('hits'); console.count('hits'); console.countReset('hits'); console.count('hits');" +
        "const { Console } = console; const sink = { text: '', write(chunk) { this.text += chunk } };" +
        "new Console({stdout: sink}).log('routed'); console.log(sink.text.trim())",
    );
    expect(result.stdout).toBe('outer\n  inner\nhits: 1\nhits: 2\nhits: 1\nrouted\n');
  });

  it('E3-11 streams lines with readline and transforms with stream.Transform', async () => {
    await fileStorage.writeFile('lines/data.txt', 'one\ntwo\nthree\n');
    const result = await node(
      "const readline = require('node:readline');" +
        "const { Transform } = require('node:stream');" +
        "const lines = [];" +
        "const rl = readline.createInterface({input: fs.createReadStream('/lines/data.txt')});" +
        "for await (const line of rl) lines.push(line);" +
        "console.log(lines.join('|'));" +
        "const upper = new Transform({transform(chunk, encoding, callback) { callback(null, chunk.toString().toUpperCase()) }});" +
        "const out = []; upper.on('data', (chunk) => out.push(chunk.toString()));" +
        "upper.write('ab'); upper.end('cd');" +
        'await new Promise((resolve) => upper.on("end", resolve));' +
        'console.log(out.join(""))',
    );
    expect(result.stdout).toBe('one|two|three\nABCD\n');
    expect(result.stderr).toBe('');
  });

  it('E3-12 reports process identity helpers', async () => {
    const result = await node(
      'console.log(process.umask().toString(8), process.getuid(), typeof process.resourceUsage().maxRSS, typeof process.memoryUsage.rss());' +
        "process.emitWarning('careful', {type: 'DeprecationWarning'});" +
        "console.error('after')",
    );
    expect(result.stdout).toBe('22 1000 number number\n');
    expect(result.stderr).toContain('DeprecationWarning: careful');
  });
});
