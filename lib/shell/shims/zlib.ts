/**
 * Browser shim for the two `node:zlib` entry points `just-bash` imports.
 *
 * The package's browser bundle still statically imports `gunzipSync`,
 * `gzipSync` and `constants`; without this alias Rollup fails on
 * `node:zlib`. Implementing them with `fflate` (already a project dependency)
 * also makes `gzip`/`gunzip`/`zcat` work in the extension.
 */

import {
  gzipSync as fflateGzipSync,
  gunzipSync as fflateGunzipSync,
} from 'fflate';

export function gzipSync(input: Uint8Array | ArrayBuffer, _options?: unknown): Uint8Array {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return fflateGzipSync(bytes);
}

export function gunzipSync(input: Uint8Array | ArrayBuffer, _options?: unknown): Uint8Array {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return fflateGunzipSync(bytes);
}

/** The subset of zlib constants used by just-bash's gzip command. */
export const constants = {
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  Z_DEFAULT_STRATEGY: 0,
} as const;
