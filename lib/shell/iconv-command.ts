/**
 * `iconv` — recode text between charsets.
 *
 * The browser cannot ship an iconv table set, but Chrome's `TextDecoder` knows
 * gbk, gb18030, big5, shift_jis, euc-kr, windows-125x, iso-8859-x and more. That
 * covers the real use case — reading a non-UTF-8 file and saving it as UTF-8 —
 * for a few hundred bytes of code and no new dependency.
 *
 * Only UTF-8 output is supported, because the platform has no other encoder.
 * Anything else fails with a clear message instead of writing mojibake.
 */

import { defineCommand, type ExecResult, type ResolvedCommandContext } from 'just-bash/browser';
import { bytesFromLatin1 } from '@/lib/encoding';

/** Common labels, in the order they are most likely to be needed here. */
const KNOWN_ENCODINGS = [
  'utf-8',
  'utf-16le',
  'utf-16be',
  'gbk',
  'gb18030',
  'big5',
  'shift_jis',
  'euc-jp',
  'euc-kr',
  'windows-1252',
  'iso-8859-1',
  'iso-8859-2',
  'iso-8859-15',
  'koi8-r',
  'macintosh',
];

function normalizeLabel(label: string): string {
  const key = label.trim().toLowerCase();
  if (key === 'utf8' || key === 'utf-8' || key === 'utf') return 'utf-8';
  if (key === 'ascii' || key === 'us-ascii' || key === 'ansi_x3.4-1968') return 'windows-1252';
  if (key === 'latin1' || key === 'binary' || key === 'iso8859-1') return 'iso-8859-1';
  if (key === 'cp936' || key === 'ms936' || key === 'gb2312' || key === 'gb_2312-80') return 'gbk';
  if (key === 'cp950' || key === 'big5-hkscs') return 'big5';
  if (key === 'cp932' || key === 'sjis' || key === 'shift-jis' || key === 'ms_kanji') return 'shift_jis';
  if (key === 'cp949' || key === 'ks_c_5601-1987' || key === 'uhc') return 'euc-kr';
  if (key === 'utf16' || key === 'ucs-2' || key === 'ucs2') return 'utf-16le';
  return key;
}

function isUtf8Output(label: string): boolean {
  return normalizeLabel(label) === 'utf-8';
}

async function readInput(ctx: ResolvedCommandContext, path?: string): Promise<Uint8Array> {
  if (!path || path === '-') {
    const stdin = ctx.stdin as unknown as string;
    return bytesFromLatin1(stdin ?? '');
  }
  const absolute = ctx.fs.resolvePath(ctx.cwd, path);
  if (typeof ctx.fs.readFileBuffer === 'function') return ctx.fs.readFileBuffer(absolute);
  return bytesFromLatin1(await ctx.fs.readFile(absolute, 'latin1'));
}

function usage(): ExecResult {
  return {
    stdout: 'usage: iconv -f <from> -t <to> [file]\n       iconv -l\n',
    stderr: '',
    exitCode: 0,
  };
}

export function createIconvCommand() {
  return defineCommand('iconv', async (args, ctx): Promise<ExecResult> => {
    let from: string | undefined;
    let to: string | undefined;
    let list = false;
    let ignoreErrors = false;
    let output: string | undefined;
    const files: string[] = [];

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if (arg === '-l' || arg === '--list') {
        list = true;
        continue;
      }
      if (arg === '-c') {
        ignoreErrors = true;
        continue;
      }
      if (arg === '-f' || arg === '--from-code') {
        from = args[++i];
        continue;
      }
      if (arg === '-t' || arg === '--to-code') {
        to = args[++i];
        continue;
      }
      if (arg === '-o' || arg === '--output') {
        output = args[++i];
        continue;
      }
      if (arg.startsWith('-f') && arg.length > 2) {
        from = arg.slice(2);
        continue;
      }
      if (arg.startsWith('-t') && arg.length > 2) {
        to = arg.slice(2);
        continue;
      }
      if (arg === '--') {
        files.push(...args.slice(i + 1));
        break;
      }
      if (arg.startsWith('-') && arg !== '-') {
        return { stdout: '', stderr: `iconv: unrecognized option '${arg}'\n`, exitCode: 2 };
      }
      files.push(arg);
    }

    if (list) {
      return { stdout: `${KNOWN_ENCODINGS.join(' ')}\n`, stderr: '', exitCode: 0 };
    }
    if (!from || !to) return usage();
    if (!isUtf8Output(to)) {
      return {
        stdout: '',
        stderr: `iconv: conversion to '${to}' is not supported (only UTF-8 output is available in the browser)\n`,
        exitCode: 1,
      };
    }

    const target = files[0];
    let bytes: Uint8Array;
    try {
      bytes = await readInput(ctx, target);
    } catch (error) {
      return {
        stdout: '',
        stderr: `iconv: ${target}: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }

    let text: string;
    try {
      text = new TextDecoder(normalizeLabel(from), { fatal: !ignoreErrors }).decode(bytes);
    } catch (error) {
      return {
        stdout: '',
        stderr: `iconv: conversion from '${from}' failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
        exitCode: 1,
      };
    }

    if (output) {
      // Writing in place is what makes `iconv -f gbk -t utf-8 -o fixed.txt a.txt`
      // a one-liner instead of a redirect plus a move.
      const absolute = ctx.fs.resolvePath(ctx.cwd, output);
      await ctx.fs.writeFile(absolute, text);
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: text, stderr: '', exitCode: 0 };
  });
}
