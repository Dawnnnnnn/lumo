/**
 * QuickJS guest runtime for the shell's `node` command.
 *
 * This file is imported with `?raw` and evaluated inside the QuickJS context,
 * immediately before the user's script. It must stay plain JavaScript — it is
 * not transpiled or type-checked as TypeScript.
 *
 * The host bridge is `__lumo_host(kind, payloadJson)` (async, returns a
 * promise) and `__lumo_sync(kind, payloadJson)` (synchronous, for operations
 * such as `crypto.randomUUID` that Node also exposes synchronously).
 *
 * What is provided is a practical subset of Node, not Node itself. The shape of
 * every API matches Node closely enough that code written against the real
 * runtime behaves the same, including error `code`s, `Timeout` objects,
 * `AbortSignal`, `Headers`/`Response`, BOM/fatal handling in `TextDecoder`, and
 * unhandled-rejection reporting. Everything that cannot exist in a browser
 * (sockets, processes, synchronous I/O) fails with a message that names the
 * replacement instead of a bare `undefined is not a function`.
 */

const __lumo_config = globalThis.__lumo_config || {};
delete globalThis.__lumo_config;

const __lumo_servers = __lumo_config.servers || [];
const __lumo_cwd = __lumo_config.cwd || '/';
const __lumo_script_dir = __lumo_config.scriptDir || __lumo_cwd;
let __lumo_current_cwd = __lumo_cwd;
const __lumo_started_at = Date.now();
const __lumo_timeout_ms = Number(__lumo_config.timeoutMs) || 30000;

const __lumo_script_path = __lumo_config.scriptPath || '/node-script.js';

/**
 * The entry script is a CommonJS file as far as Node is concerned: `module`,
 * `exports`, `__filename` and `__dirname` all exist there.
 */
const module = {
  exports: {},
  id: '.',
  filename: __lumo_script_path,
  path: __lumo_script_dir,
  loaded: false,
  children: [],
  paths: [],
};
const exports = module.exports;
const __filename = __lumo_script_path;
const __dirname = __lumo_script_dir;

const __lumo_console_out = [];
const __lumo_console_err = [];
const __lumo_timer_errors = [];

/**
 * Console output is buffered in the VM and only crosses the bridge at exit, so a
 * runaway `console.log` loop used to grow until QuickJS hit its 64 MB memory
 * limit and the whole script died with an opaque OOM instead of a result. Cap
 * the buffer and say so, the same way the shell caps stdout.
 */
const __LUMO_MAX_CONSOLE_CHARS = 32 * 1024 * 1024;
let __lumo_console_chars = 0;
let __lumo_console_dropped = false;

function __lumo_out(text) {
  const value = String(text);
  if (__lumo_console_dropped) return;
  __lumo_console_chars += value.length;
  if (__lumo_console_chars > __LUMO_MAX_CONSOLE_CHARS) {
    __lumo_console_out.push('\n[output truncated: exceeding ' + __LUMO_MAX_CONSOLE_CHARS + ' characters]\n');
    __lumo_console_dropped = true;
    return;
  }
  __lumo_console_out.push(value);
}

function __lumo_err(text) {
  __lumo_console_err.push(String(text));
}
/** Rejections nobody handled; the wrapper turns these into a non-zero exit. */
const __lumo_unhandled = [];
/** Every tracked promise, so the exit path can look for unhandled failures. */
const __lumo_rejections = [];

function __lumo_sync_json(kind, payload) {
  const raw = __lumo_sync(kind, JSON.stringify(payload || {}));
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === 'object' && typeof parsed.__lumo_error === 'string') {
    const error = new Error(parsed.__lumo_error);
    if (typeof parsed.name === 'string') error.name = parsed.name;
    if (typeof parsed.code === 'string') error.code = parsed.code;
    throw error;
  }
  return parsed;
}

/**
 * Every host call counts as pending work, so a script that fires an unawaited
 * promise (`fs.readFile(path, cb)`, `fetch(...).then(...)`) still runs to
 * completion before the command returns. Node keeps the process alive for
 * pending I/O in the same way.
 */
/**
 * Exit code carried by a `process.exit()` unwinding, or `null` for any other
 * error. `0` is a valid code, so the check cannot be truthiness.
 */
function __lumo_process_exit_code(error) {
  return error && typeof error.__lumo_process_exit === 'number'
    ? error.__lumo_process_exit
    : null;
}

function __lumo_pending_begin() {
  __lumo_pending_timers += 1;
}

function __lumo_pending_end() {
  __lumo_pending_timers -= 1;
  if (__lumo_pending_timers <= 0 && __lumo_idle_resolve) {
    const resolve = __lumo_idle_resolve;
    __lumo_idle_resolve = null;
    resolve();
  }
}

function __lumo_call(kind, payload) {
  __lumo_pending_begin();
  return __lumo_host(kind, payload).then(
    (value) => {
      __lumo_pending_end();
      return value;
    },
    (error) => {
      __lumo_pending_end();
      throw error;
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Unhandled rejection tracking                                               */
/* -------------------------------------------------------------------------- */

/**
 * Wrap a promise so an unhandled rejection can be reported.
 *
 * QuickJS exposes no rejection tracker through this binding, so the guest
 * tracks its own: every public async API returns this thenable and sets
 * `handled` as soon as the caller attaches a rejection path. `await`,
 * `.catch()`, `Promise.all` and friends all pass an `onRejected`, so real
 * handling is detected; a bare `fs.readFile(...)` is not, exactly like Node.
 */
function __lumo_track(promise) {
  const entry = { handled: false, failed: false, error: undefined, settled: false };
  __lumo_rejections.push(entry);
  const inner = Promise.resolve(promise);
  inner.then(
    (value) => {
      entry.settled = true;
      return value;
    },
    (error) => {
      entry.settled = true;
      entry.failed = true;
      entry.error = error;
      // Swallow so the guest runtime sees no stray rejection; the entry is the
      // record the command reads at exit.
      return undefined;
    },
  );
  const tracked = {
    then(onFulfilled, onRejected) {
      if (typeof onRejected === 'function') entry.handled = true;
      return __lumo_track(inner.then(onFulfilled, onRejected));
    },
    catch(onRejected) {
      entry.handled = true;
      return __lumo_track(inner.catch(onRejected));
    },
    finally(onFinally) {
      entry.handled = true;
      return __lumo_track(inner.finally(onFinally));
    },
  };
  Object.defineProperty(tracked, '__lumo_tracked', { value: entry });
  Object.defineProperty(tracked, Symbol.toStringTag, { value: 'Promise' });
  return tracked;
}

/** Wrap an async function so its result participates in rejection tracking. */
function __lumo_pub(fn) {
  return function (...args) {
    try {
      return __lumo_track(fn.apply(this, args));
    } catch (error) {
      return __lumo_track(Promise.reject(error));
    }
  };
}

function __lumo_collect_unhandled() {
  for (const entry of __lumo_rejections) {
    if (entry.failed && !entry.handled) __lumo_unhandled.push(entry.error);
  }
  __lumo_rejections.length = 0;
}
/* -------------------------------------------------------------------------- */
/* Errors and formatting                                                      */
/* -------------------------------------------------------------------------- */

function __lumo_make_error(name, message, code) {
  const error = new Error(message);
  error.name = name;
  if (code !== undefined) error.code = code;
  return error;
}

function __lumo_abort_error(message) {
  return __lumo_make_error('AbortError', message || 'This operation was aborted', 'ABORT_ERR');
}

function __lumo_capture_stack(target) {
  try {
    target.stack = new Error().stack;
  } catch {
    // Frozen object: nothing to capture.
  }
}

function __lumo_error_text(error) {
  if (error && typeof error === 'object') {
    const name = typeof error.name === 'string' ? error.name : 'Error';
    const message = typeof error.message === 'string' ? error.message : '';
    const head = message ? name + ': ' + message : name;
    if (typeof error.stack === 'string' && error.stack.length > 0) {
      return error.stack.indexOf(head) === 0 ? error.stack : head + '\n' + error.stack;
    }
    return head;
  }
  return String(error);
}

function __lumo_inspect(value, depth, seen) {
  const maxDepth = depth === undefined ? 2 : depth;
  const stack = seen || [];
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'undefined') return 'undefined';
  if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value);
  if (type === 'function') return '[Function: ' + (value.name || 'anonymous') + ']';
  if (type === 'symbol') return String(value);
  if (stack.indexOf(value) !== -1) return '[Circular *' + (stack.length - stack.indexOf(value)) + ']';
  if (maxDepth < 0) return Array.isArray(value) ? '[Array]' : '[Object]';
  stack.push(value);
  try {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (value instanceof Error) return value.stack || (value.name + ': ' + value.message);
    if (ArrayBuffer.isView(value)) {
      const name = value.constructor && value.constructor.name ? value.constructor.name : 'TypedArray';
      return name + ' [' + Array.prototype.join.call(value, ', ') + ']';
    }
    if (value instanceof ArrayBuffer) return 'ArrayBuffer { byteLength: ' + value.byteLength + ' }';
    if (Array.isArray(value)) {
      const items = value.slice(0, 100).map((item) => __lumo_inspect(item, maxDepth - 1, stack));
      if (value.length > 100) items.push('... ' + (value.length - 100) + ' more items');
      return '[ ' + items.join(', ') + ' ]';
    }
    if (value instanceof Map) {
      const items = [];
      value.forEach((v, k) =>
        items.push(
          __lumo_inspect(k, maxDepth - 1, stack) + ' => ' + __lumo_inspect(v, maxDepth - 1, stack),
        ),
      );
      return 'Map(' + value.size + ') { ' + items.join(', ') + ' }';
    }
    if (value instanceof Set) {
      const items = [];
      value.forEach((v) => items.push(__lumo_inspect(v, maxDepth - 1, stack)));
      return 'Set(' + value.size + ') { ' + items.join(', ') + ' }';
    }
    const keys = Object.keys(value);
    const rendered = keys.slice(0, 100).map((key) => {
      const child = value[key];
      return key + ': ' + __lumo_inspect(child, maxDepth - 1, stack);
    });
    if (keys.length > 100) rendered.push('... ' + (keys.length - 100) + ' more keys');
    return '{ ' + rendered.join(', ') + ' }';
  } catch (error) {
    return String(value);
  } finally {
    stack.pop();
  }
}

/** `util.format` / `console.log` placeholder expansion, like Node. */
function __lumo_format(format, ...args) {
  if (typeof format !== 'string') {
    return [format].concat(args).map((value) => __lumo_inspect(value)).join(' ');
  }
  let index = 0;
  let out = format.replace(/%[sdifjoOc%]/g, (token) => {
    if (token === '%%') return '%';
    if (index >= args.length) return token;
    const value = args[index];
    index += 1;
    switch (token) {
      case '%s':
        return typeof value === 'string'
          ? value
          : typeof value === 'bigint' || typeof value === 'number'
            ? String(value)
            : __lumo_inspect(value, 2);
      case '%d':
      case '%i':
        if (typeof value === 'bigint') return value.toString() + 'n';
        return String(typeof value === 'number' ? Math.trunc(value) : parseInt(value, 10));
      case '%f':
        return String(parseFloat(value));
      case '%j':
        try {
          return JSON.stringify(value);
        } catch {
          return '[Circular]';
        }
      case '%c':
        return '';
      case '%o':
      case '%O':
        return __lumo_inspect(value, 4);
      default:
        return __lumo_inspect(value);
    }
  });
  if (index < args.length) {
    out +=
      ' ' +
      args
        .slice(index)
        .map((value) => (typeof value === 'string' ? value : __lumo_inspect(value)))
        .join(' ');
  }
  return out;
}

function __lumo_format_args(args) {
  if (typeof args[0] === 'string' && args[0].indexOf('%') !== -1) {
    return __lumo_format.apply(null, args);
  }
  return args.map((value) => (typeof value === 'string' ? value : __lumo_inspect(value))).join(' ');
}

/* -------------------------------------------------------------------------- */
/* Base64 / UTF-8 / hex / UTF-16                                              */
/* -------------------------------------------------------------------------- */

const __lumo_b64_chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const __lumo_b64_lookup = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < __lumo_b64_chars.length; i += 1) table[__lumo_b64_chars.charCodeAt(i)] = i;
  return table;
})();

function __lumo_b64_encode(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < view.length; i += 3) {
    const a = view[i];
    const b = i + 1 < view.length ? view[i + 1] : 0;
    const c = i + 2 < view.length ? view[i + 2] : 0;
    out += __lumo_b64_chars[a >> 2];
    out += __lumo_b64_chars[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < view.length ? __lumo_b64_chars[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < view.length ? __lumo_b64_chars[c & 63] : '=';
  }
  return out;
}

function __lumo_b64_decode(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/=]/g, '');
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const code = clean.charCodeAt(i);
    if (code === 61) break; // '='
    const value = __lumo_b64_lookup[code];
    if (value === -1) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function __lumo_b64url_encode(bytes) {
  return __lumo_b64_encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function __lumo_b64url_decode(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
  return __lumo_b64_decode(padded);
}

function __lumo_utf8_encode(input) {
  const text = String(input);
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

/** UTF-8 decode with WHATWG replacement/fatal rules and BOM stripping. */
function __lumo_utf8_decode(input, options) {
  const fatal = !!(options && options.fatal);
  const ignoreBOM = !!(options && options.ignoreBOM);
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let out = '';
  let i = 0;
  if (!ignoreBOM && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    i = 3;
  }
  const fail = () => {
    if (fatal) throw new TypeError('The encoded data was not valid for encoding utf-8');
    out += '\ufffd';
  };
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
      continue;
    }
    let length = 0;
    let code = 0;
    let lower = 0x80;
    let upper = 0xbf;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      length = 1;
      code = b0 & 0x1f;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      length = 2;
      code = b0 & 0x0f;
      if (b0 === 0xe0) lower = 0xa0;
      if (b0 === 0xed) upper = 0x9f;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      length = 3;
      code = b0 & 0x07;
      if (b0 === 0xf0) lower = 0x90;
      if (b0 === 0xf4) upper = 0x8f;
    } else {
      fail();
      i += 1;
      continue;
    }
    if (i + length >= bytes.length + 0 && i + length > bytes.length - 1) {
      fail();
      break;
    }
    let valid = true;
    for (let j = 0; j < length; j += 1) {
      const next = bytes[i + j + 1];
      const min = j === 0 ? lower : 0x80;
      const max = j === 0 ? upper : 0xbf;
      if (next === undefined || next < min || next > max) {
        valid = false;
        break;
      }
      code = (code << 6) | (next & 0x3f);
    }
    if (!valid) {
      fail();
      i += 1;
      continue;
    }
    i += length + 1;
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      fail();
    } else {
      out += String.fromCodePoint(code);
    }
  }
  return out;
}

function __lumo_utf16_encode(input, littleEndian) {
  const text = String(input);
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (littleEndian) {
      bytes[i * 2] = code & 0xff;
      bytes[i * 2 + 1] = code >> 8;
    } else {
      bytes[i * 2] = code >> 8;
      bytes[i * 2 + 1] = code & 0xff;
    }
  }
  return bytes;
}

function __lumo_utf16_decode(bytes, littleEndian, ignoreBOM) {
  let start = 0;
  if (!ignoreBOM && bytes.length >= 2) {
    if (littleEndian && bytes[0] === 0xff && bytes[1] === 0xfe) start = 2;
    else if (!littleEndian && bytes[0] === 0xfe && bytes[1] === 0xff) start = 2;
  }
  const length = Math.floor((bytes.length - start) / 2);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const offset = start + i * 2;
    const code = littleEndian
      ? bytes[offset] | (bytes[offset + 1] << 8)
      : (bytes[offset] << 8) | bytes[offset + 1];
    out += String.fromCharCode(code);
  }
  return out;
}

function __lumo_hex_encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return out;
}

function __lumo_hex_decode(text) {
  const clean = String(text).replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const __lumo_encoding_aliases = {
  utf8: 'utf-8',
  'utf-8': 'utf-8',
  'unicode-1-1-utf-8': 'utf-8',
  ascii: 'latin1',
  'us-ascii': 'latin1',
  latin1: 'latin1',
  'iso-8859-1': 'latin1',
  binary: 'latin1',
  'utf-16le': 'utf-16le',
  utf16le: 'utf-16le',
  ucs2: 'utf-16le',
  'ucs-2': 'utf-16le',
  'utf-16': 'utf-16le',
  'utf-16be': 'utf-16be',
  hex: 'hex',
  base64: 'base64',
  base64url: 'base64url',
};

function __lumo_normalize_encoding(label) {
  const key = String(label === undefined || label === null ? 'utf-8' : label).toLowerCase();
  return __lumo_encoding_aliases[key] || key;
}

/** Decode bytes for any encoding Chrome's TextDecoder knows, via the host. */
function __lumo_decode_any(label, bytes, fatal, ignoreBOM) {
  return __lumo_sync_json('encoding.decode', {
    encoding: label,
    data: __lumo_b64_encode(bytes),
    fatal: !!fatal,
    ignoreBOM: !!ignoreBOM,
  });
}

/* -------------------------------------------------------------------------- */
/* TextEncoder / TextDecoder / atob / btoa                                    */
/* -------------------------------------------------------------------------- */

class TextEncoder {
  get encoding() {
    return 'utf-8';
  }
  encode(input) {
    return __lumo_utf8_encode(input === undefined ? '' : input);
  }
  encodeInto(input, destination) {
    const text = String(input === undefined ? '' : input);
    let read = 0;
    let written = 0;
    for (const character of text) {
      const bytes = __lumo_utf8_encode(character);
      if (written + bytes.length > destination.length) break;
      destination.set(bytes, written);
      written += bytes.length;
      read += character.length;
    }
    return { read, written };
  }
}

class TextDecoder {
  constructor(label, options) {
    this._label = String(label === undefined ? 'utf-8' : label);
    this.encoding = __lumo_normalize_encoding(this._label);
    this.fatal = !!(options && options.fatal);
    this.ignoreBOM = !!(options && options.ignoreBOM);
  }
  decode(input) {
    if (input === undefined || input === null) return '';
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : ArrayBuffer.isView(input)
          ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          : __lumo_utf8_encode(input);
    switch (this.encoding) {
      case 'utf-8':
        return __lumo_utf8_decode(bytes, this);
      case 'utf-16le':
        return __lumo_utf16_decode(bytes, true, this.ignoreBOM);
      case 'utf-16be':
        return __lumo_utf16_decode(bytes, false, this.ignoreBOM);
      case 'latin1': {
        let out = '';
        for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
        return out;
      }
      case 'hex':
        return __lumo_hex_encode(bytes);
      case 'base64':
        return __lumo_b64_encode(bytes);
      default:
        // gbk / big5 / shift_jis / euc-kr / windows-125x: Chrome decodes these
        // natively, so the host does the work instead of shipping code tables.
        return __lumo_decode_any(this._label, bytes, this.fatal, this.ignoreBOM);
    }
  }
}

function atob(input) {
  const bytes = __lumo_b64_decode(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

function btoa(input) {
  const text = String(input);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0xff) throw new Error('InvalidCharacterError: btoa received a character outside Latin1');
    bytes[i] = code;
  }
  return __lumo_b64_encode(bytes);
}

/** Coerce any Node-ish binary/string input to bytes. */
function __lumo_to_bytes(value, encoding) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  const enc = __lumo_normalize_encoding(encoding);
  if (enc === 'base64') return __lumo_b64_decode(value);
  if (enc === 'base64url') return __lumo_b64url_decode(value);
  if (enc === 'hex') return __lumo_hex_decode(value);
  if (enc === 'latin1') {
    const text = String(value);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
    return bytes;
  }
  if (enc === 'utf-16le') return __lumo_utf16_encode(value, true);
  if (enc === 'utf-16be') return __lumo_utf16_encode(value, false);
  return __lumo_utf8_encode(value);
}


/** PBKDF2 on top of the in-guest HMAC; no ICU/OpenSSL in WASM. */
function __lumo_pbkdf2(digestName, password, salt, iterations, keylen) {
  const spec = __lumo_hash_spec(digestName);
  const hLen = spec.fn(new Uint8Array(0)).length;
  const blocks = Math.ceil(keylen / hLen);
  const out = new Uint8Array(blocks * hLen);
  for (let block = 1; block <= blocks; block += 1) {
    const saltBlock = new Uint8Array(salt.length + 4);
    saltBlock.set(salt);
    saltBlock[salt.length] = (block >>> 24) & 0xff;
    saltBlock[salt.length + 1] = (block >>> 16) & 0xff;
    saltBlock[salt.length + 2] = (block >>> 8) & 0xff;
    saltBlock[salt.length + 3] = block & 0xff;
    let u = __lumo_hmac(spec.fn, spec.blockSize, password, saltBlock);
    const mixed = u.slice();
    for (let round = 1; round < iterations; round += 1) {
      u = __lumo_hmac(spec.fn, spec.blockSize, password, u);
      for (let i = 0; i < mixed.length; i += 1) mixed[i] ^= u[i];
    }
    out.set(mixed, (block - 1) * hLen);
  }
  return out.slice(0, keylen);
}

/** HKDF (extract + expand) on top of the in-guest HMAC. */
function __lumo_hkdf(digestName, ikm, salt, info, keylen) {
  const spec = __lumo_hash_spec(digestName);
  const hLen = spec.fn(new Uint8Array(0)).length;
  const actualSalt = salt.length === 0 ? new Uint8Array(hLen) : salt;
  const prk = __lumo_hmac(spec.fn, spec.blockSize, actualSalt, ikm);
  const blocks = Math.ceil(keylen / hLen);
  if (blocks > 255) throw new RangeError('hkdf: keylen is too large');
  const out = new Uint8Array(blocks * hLen);
  let previous = new Uint8Array(0);
  for (let block = 1; block <= blocks; block += 1) {
    const input = new Uint8Array(previous.length + info.length + 1);
    input.set(previous);
    input.set(info, previous.length);
    input[input.length - 1] = block;
    previous = __lumo_hmac(spec.fn, spec.blockSize, prk, input);
    out.set(previous, (block - 1) * hLen);
  }
  return out.slice(0, keylen);
}
function __lumo_concat_bytes(list) {
  let total = 0;
  for (const item of list) total += item.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const item of list) {
    out.set(item, offset);
    offset += item.length;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Buffer                                                                     */
/* -------------------------------------------------------------------------- */

class Buffer extends Uint8Array {
  static from(value, encoding) {
    if (typeof value === 'string') return new Buffer(__lumo_to_bytes(value, encoding));
    if (value === null || value === undefined) throw new TypeError('Buffer.from: value is required');
    if (value instanceof ArrayBuffer) return new Buffer(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) {
      return new Buffer(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
    if (Array.isArray(value)) return new Buffer(Uint8Array.from(value));
    return new Buffer(Uint8Array.from(value));
  }
  static alloc(size, fill, encoding) {
    const bytes = new Uint8Array(Number(size) || 0);
    if (fill !== undefined) {
      if (typeof fill === 'number') bytes.fill(fill & 0xff);
      else {
        const pattern = __lumo_to_bytes(fill, encoding);
        if (pattern.length > 0) {
          for (let i = 0; i < bytes.length; i += 1) bytes[i] = pattern[i % pattern.length];
        }
      }
    }
    return new Buffer(bytes);
  }
  static allocUnsafe(size) {
    return Buffer.alloc(size);
  }
  static allocUnsafeSlow(size) {
    return Buffer.alloc(size);
  }
  static byteLength(value, encoding) {
    if (typeof value === 'string') return __lumo_to_bytes(value, encoding).length;
    if (value instanceof ArrayBuffer) return value.byteLength;
    return value && typeof value.byteLength === 'number' ? value.byteLength : 0;
  }
  static isBuffer(value) {
    return value instanceof Buffer;
  }
  static isEncoding(encoding) {
    return Object.prototype.hasOwnProperty.call(
      __lumo_encoding_aliases,
      String(encoding).toLowerCase(),
    );
  }
  static compare(a, b) {
    const left = a instanceof Uint8Array ? a : Buffer.from(a);
    const right = b instanceof Uint8Array ? b : Buffer.from(b);
    return Buffer.prototype.compare.call(left, right);
  }
  static concat(list, totalLength) {
    const arrays = list.map((item) => (item instanceof Uint8Array ? item : Buffer.from(item)));
    const total =
      totalLength === undefined
        ? arrays.reduce((sum, item) => sum + item.length, 0)
        : totalLength;
    const out = Buffer.alloc(total);
    let offset = 0;
    for (const item of arrays) {
      if (offset >= out.length) break;
      const chunk = item.subarray(0, Math.max(0, out.length - offset));
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
  toString(encoding, start, end) {
    const enc = __lumo_normalize_encoding(encoding);
    const view = this.subarray(start === undefined ? 0 : start, end === undefined ? this.length : end);
    if (enc === 'base64') return __lumo_b64_encode(view);
    if (enc === 'base64url') return __lumo_b64url_encode(view);
    if (enc === 'hex') return __lumo_hex_encode(view);
    if (enc === 'utf-16le') return __lumo_utf16_decode(view, true, true);
    if (enc === 'utf-16be') return __lumo_utf16_decode(view, false, true);
    if (enc === 'latin1') {
      let out = '';
      for (let i = 0; i < view.length; i += 1) out += String.fromCharCode(view[i]);
      return out;
    }
    return __lumo_utf8_decode(view, { ignoreBOM: true });
  }
  /** Node returns a *view* here (deprecated in favour of subarray). */
  slice(start, end) {
    return new Buffer(this.buffer, this.byteOffset, this.byteLength).subarray(start, end);
  }
  equals(other) {
    if (!(other instanceof Uint8Array) || other.length !== this.length) return false;
    for (let i = 0; i < this.length; i += 1) if (this[i] !== other[i]) return false;
    return true;
  }
  compare(other) {
    const right = other instanceof Uint8Array ? other : Buffer.from(other);
    const length = Math.min(this.length, right.length);
    for (let i = 0; i < length; i += 1) {
      if (this[i] !== right[i]) return this[i] < right[i] ? -1 : 1;
    }
    if (this.length === right.length) return 0;
    return this.length < right.length ? -1 : 1;
  }
  copy(target, targetStart, sourceStart, sourceEnd) {
    const start = targetStart === undefined ? 0 : targetStart;
    const from = sourceStart === undefined ? 0 : sourceStart;
    const to = sourceEnd === undefined ? this.length : sourceEnd;
    const chunk = this.subarray(from, to);
    const written = Math.min(chunk.length, Math.max(0, target.length - start));
    target.set(chunk.subarray(0, written), start);
    return written;
  }
  indexOf(value, byteOffset, encoding) {
    const needle =
      typeof value === 'number' ? Uint8Array.of(value) : __lumo_to_bytes(value, encoding);
    const from = Math.max(0, byteOffset === undefined ? 0 : byteOffset);
    if (needle.length === 0) return from <= this.length ? from : this.length;
    outer: for (let i = from; i <= this.length - needle.length; i += 1) {
      for (let j = 0; j < needle.length; j += 1) if (this[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }
  includes(value, byteOffset, encoding) {
    return this.indexOf(value, byteOffset, encoding) !== -1;
  }
  readUInt8(offset) {
    return this[offset];
  }
  readInt8(offset) {
    return (this[offset] << 24) >> 24;
  }
  readUInt16BE(offset) {
    return (this[offset] << 8) | this[offset + 1];
  }
  readUInt16LE(offset) {
    return this[offset] | (this[offset + 1] << 8);
  }
  readUInt32BE(offset) {
    return ((this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]) >>> 0;
  }
  readUInt32LE(offset) {
    return ((this[offset + 3] << 24) | (this[offset + 2] << 16) | (this[offset + 1] << 8) | this[offset]) >>> 0;
  }
  readInt32BE(offset) {
    return (this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3];
  }
  readInt32LE(offset) {
    return (this[offset + 3] << 24) | (this[offset + 2] << 16) | (this[offset + 1] << 8) | this[offset];
  }
  writeUInt8(value, offset) {
    this[offset] = value & 0xff;
    return offset + 1;
  }
  writeUInt16BE(value, offset) {
    this[offset] = (value >> 8) & 0xff;
    this[offset + 1] = value & 0xff;
    return offset + 2;
  }
  writeUInt16LE(value, offset) {
    this[offset] = value & 0xff;
    this[offset + 1] = (value >> 8) & 0xff;
    return offset + 2;
  }
  writeUInt32BE(value, offset) {
    this[offset] = (value >>> 24) & 0xff;
    this[offset + 1] = (value >> 16) & 0xff;
    this[offset + 2] = (value >> 8) & 0xff;
    this[offset + 3] = value & 0xff;
    return offset + 4;
  }
  writeUInt32LE(value, offset) {
    this[offset] = value & 0xff;
    this[offset + 1] = (value >> 8) & 0xff;
    this[offset + 2] = (value >> 16) & 0xff;
    this[offset + 3] = (value >>> 24) & 0xff;
    return offset + 4;
  }
  readBigInt64BE(offset) {
    let value = 0n;
    for (let i = 0; i < 8; i += 1) value = (value << 8n) | BigInt(this[offset + i]);
    return value > 9223372036854775807n ? value - 18446744073709551616n : value;
  }
  readBigInt64LE(offset) {
    let value = 0n;
    for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(this[offset + i]);
    return value > 9223372036854775807n ? value - 18446744073709551616n : value;
  }
  readBigUInt64BE(offset) {
    let value = 0n;
    for (let i = 0; i < 8; i += 1) value = (value << 8n) | BigInt(this[offset + i]);
    return value;
  }
  readBigUInt64LE(offset) {
    let value = 0n;
    for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(this[offset + i]);
    return value;
  }
  writeBigInt64BE(value, offset) {
    let remaining = BigInt(value) & 18446744073709551615n;
    for (let i = 7; i >= 0; i -= 1) {
      this[offset + i] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    return offset + 8;
  }
  writeBigInt64LE(value, offset) {
    let remaining = BigInt(value) & 18446744073709551615n;
    for (let i = 0; i < 8; i += 1) {
      this[offset + i] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    return offset + 8;
  }
  swap16() {
    for (let i = 0; i + 1 < this.length; i += 2) {
      const a = this[i];
      this[i] = this[i + 1];
      this[i + 1] = a;
    }
    return this;
  }
  swap32() {
    for (let i = 0; i + 3 < this.length; i += 4) {
      const a = this[i];
      const b = this[i + 1];
      this[i] = this[i + 3];
      this[i + 1] = this[i + 2];
      this[i + 2] = b;
      this[i + 3] = a;
    }
    return this;
  }
  swap64() {
    for (let i = 0; i + 7 < this.length; i += 8) {
      for (let j = 0; j < 4; j += 1) {
        const a = this[i + j];
        this[i + j] = this[i + 7 - j];
        this[i + 7 - j] = a;
      }
    }
    return this;
  }
  toJSON() {
    return { type: 'Buffer', data: Array.from(this) };
  }
}

/* -------------------------------------------------------------------------- */
/* URL / URLSearchParams                                                      */
/* -------------------------------------------------------------------------- */

const __lumo_url_extra_safe = new Set(['*', '-', '.', '_']);

function __lumo_form_encode(value) {
  const text = String(value);
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const character = text.charAt(i);
    const code = text.charCodeAt(i);
    const isAlphanumeric =
      (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    if (isAlphanumeric || __lumo_url_extra_safe.has(character)) out += character;
    else if (character === ' ') out += '+';
    else out += __lumo_percent_encode(character);
  }
  return out;
}

function __lumo_percent_encode(character) {
  const bytes = __lumo_utf8_encode(character);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += '%' + (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16).toUpperCase();
  }
  return out;
}

/** WHATWG path percent-encode set. */
function __lumo_encode_path(path) {
  const text = String(path);
  const allowed = "-._~!$&'()*+,;=:@/";
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const character = text.charAt(i);
    const code = text.charCodeAt(i);
    const isAlphanumeric =
      (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    if (isAlphanumeric || allowed.indexOf(character) !== -1) out += character;
    else if (character === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      out += character;
    } else out += __lumo_percent_encode(character);
  }
  return out;
}

function __lumo_form_decode(value) {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, ' '));
  } catch {
    return String(value);
  }
}

class URLSearchParams {
  constructor(init) {
    this._pairs = [];
    if (init === undefined || init === null) return;
    if (typeof init === 'string') {
      const text = init.charAt(0) === '?' ? init.slice(1) : init;
      if (text.length > 0) {
        for (const part of text.split('&')) {
          if (part === '') continue;
          const eq = part.indexOf('=');
          const key = eq === -1 ? part : part.slice(0, eq);
          const value = eq === -1 ? '' : part.slice(eq + 1);
          this._pairs.push([__lumo_form_decode(key), __lumo_form_decode(value)]);
        }
      }
      return;
    }
    if (init instanceof URLSearchParams) {
      for (const pair of init._pairs) this._pairs.push([pair[0], pair[1]]);
      return;
    }
    if (Array.isArray(init)) {
      for (const pair of init) this._pairs.push([String(pair[0]), String(pair[1])]);
      return;
    }
    if (typeof init === 'object') {
      for (const key of Object.keys(init)) this._pairs.push([String(key), String(init[key])]);
    }
  }
  get size() {
    return this._pairs.length;
  }
  append(key, value) {
    this._pairs.push([String(key), String(value)]);
  }
  delete(key, value) {
    const target = String(key);
    this._pairs = this._pairs.filter(
      (pair) => pair[0] !== target || (value !== undefined && pair[1] !== String(value)),
    );
  }
  get(key) {
    const target = String(key);
    const found = this._pairs.find((pair) => pair[0] === target);
    return found ? found[1] : null;
  }
  getAll(key) {
    const target = String(key);
    return this._pairs.filter((pair) => pair[0] === target).map((pair) => pair[1]);
  }
  has(key, value) {
    const target = String(key);
    return this._pairs.some(
      (pair) => pair[0] === target && (value === undefined || pair[1] === String(value)),
    );
  }
  set(key, value) {
    const target = String(key);
    const index = this._pairs.findIndex((pair) => pair[0] === target);
    if (index === -1) this._pairs.push([target, String(value)]);
    else this._pairs[index] = [target, String(value)];
  }
  sort() {
    this._pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  toString() {
    return this._pairs
      .map((pair) => __lumo_form_encode(pair[0]) + '=' + __lumo_form_encode(pair[1]))
      .join('&');
  }
  forEach(callback, thisArg) {
    for (const [key, value] of this._pairs) callback.call(thisArg, value, key, this);
  }
  keys() {
    return this._pairs.map((pair) => pair[0])[Symbol.iterator]();
  }
  values() {
    return this._pairs.map((pair) => pair[1])[Symbol.iterator]();
  }
  entries() {
    return this._pairs.map((pair) => [pair[0], pair[1]])[Symbol.iterator]();
  }
  [Symbol.iterator]() {
    return this.entries();
  }
}

function __lumo_normalize_url_path(path) {
  const absolute = path.charAt(0) === '/';
  const parts = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const joined = parts.join('/');
  return (absolute ? '/' : '') + joined;
}

const __lumo_url_scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;
const __lumo_special_schemes = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:', 'file:']);

class URL {
  constructor(input, base) {
    const text = String(input);
    let resolved = text;
    if (!__lumo_url_scheme.test(text)) {
      if (base === undefined) throw new TypeError('Invalid URL: ' + text);
      const baseUrl = base instanceof URL ? base : new URL(String(base));
      if (text.slice(0, 2) === '//') resolved = baseUrl.protocol + text;
      else if (text.charAt(0) === '/') resolved = baseUrl.protocol + '//' + baseUrl.host + text;
      else if (text.charAt(0) === '?') resolved = baseUrl.protocol + '//' + baseUrl.host + baseUrl.pathname + text;
      else if (text.charAt(0) === '#') {
        resolved = baseUrl.protocol + '//' + baseUrl.host + baseUrl.pathname + baseUrl.search + text;
      } else {
        resolved =
          baseUrl.protocol +
          '//' +
          baseUrl.host +
          __lumo_normalize_url_path(baseUrl.pathname.replace(/[^/]*$/, '') + text);
      }
    }
    const match = __lumo_url_scheme.exec(resolved);
    if (!match) throw new TypeError('Invalid URL: ' + text);
    this.protocol = match[1] + ':';
    const authority = match[2];
    this._hasAuthority = authority !== undefined;
    this._pathname =
      __lumo_encode_path(__lumo_normalize_url_path(match[3] || (this._hasAuthority ? '/' : ''))) ||
      (this._hasAuthority ? '/' : '');
    this._search = match[4] === undefined ? '' : '?' + match[4];
    this._hash = match[5] === undefined ? '' : '#' + match[5];
    this._searchParams = new URLSearchParams(this._search);
    let credentials = '';
    let hostPart = authority || '';
    const at = hostPart.lastIndexOf('@');
    if (at !== -1) {
      credentials = hostPart.slice(0, at);
      hostPart = hostPart.slice(at + 1);
    }
    const colon = credentials.indexOf(':');
    this.username = colon === -1 ? credentials : credentials.slice(0, colon);
    this.password = colon === -1 ? '' : credentials.slice(colon + 1);
    const isIpv6 = hostPart.charAt(0) === '[';
    let hostname = hostPart;
    let port = '';
    if (isIpv6) {
      const close = hostPart.indexOf(']');
      if (close !== -1 && hostPart.charAt(close + 1) === ':') {
        hostname = hostPart.slice(0, close + 1);
        port = hostPart.slice(close + 2);
      }
    } else {
      const portColon = hostPart.lastIndexOf(':');
      if (portColon !== -1) {
        hostname = hostPart.slice(0, portColon);
        port = hostPart.slice(portColon + 1);
      }
    }
    this.hostname = hostname.toLowerCase();
    this.port = port;
    this.host = this.hostname + (port ? ':' + port : '');
    this.origin =
      __lumo_special_schemes.has(this.protocol) && this._hasAuthority
        ? this.protocol === 'file:'
          ? 'null'
          : this.protocol + '//' + this.host
        : 'null';
  }
  static canParse(input, base) {
    try {
      new URL(input, base);
      return true;
    } catch {
      return false;
    }
  }
  static parse(input, base) {
    try {
      return new URL(input, base);
    } catch {
      return null;
    }
  }
  get pathname() {
    return this._pathname;
  }
  set pathname(value) {
    const text = String(value);
    this._pathname =
      __lumo_encode_path(__lumo_normalize_url_path(text.charAt(0) === '/' ? text : '/' + text)) || '/';
  }
  get search() {
    const query = this._searchParams ? this._searchParams.toString() : '';
    return query ? '?' + query : '';
  }
  set search(value) {
    const text = String(value);
    this._search = text === '' ? '' : '?' + (text.charAt(0) === '?' ? text.slice(1) : text);
    this._searchParams = new URLSearchParams(this._search);
  }
  get searchParams() {
    return this._searchParams;
  }
  set searchParams(value) {
    this._searchParams = value instanceof URLSearchParams ? value : new URLSearchParams(value);
  }
  get hash() {
    return this._hash;
  }
  set hash(value) {
    const text = String(value);
    this._hash = text === '' ? '' : '#' + (text.charAt(0) === '#' ? text.slice(1) : text);
  }
  get href() {
    return this.toString();
  }
  set href(value) {
    const next = new URL(String(value));
    Object.assign(this, next);
  }
  toString() {
    const credentials =
      this.username || this.password
        ? this.username + (this.password ? ':' + this.password : '') + '@'
        : '';
    const authority = this._hasAuthority ? '//' + credentials + this.host : '';
    const query = this._searchParams.toString();
    return this.protocol + authority + this._pathname + (query ? '?' + query : '') + this._hash;
  }
  toJSON() {
    return this.toString();
  }
}

/* -------------------------------------------------------------------------- */
/* AbortController / AbortSignal                                              */
/* -------------------------------------------------------------------------- */

class AbortSignal {
  constructor() {
    this.aborted = false;
    this.reason = undefined;
    this.onabort = null;
    this._listeners = [];
  }
  addEventListener(type, listener, options) {
    if (type !== 'abort' || typeof listener !== 'function') return;
    if (options && options.once) {
      listener._once = true;
    }
    this._listeners.push(listener);
  }
  removeEventListener(type, listener) {
    if (type !== 'abort') return;
    this._listeners = this._listeners.filter((item) => item !== listener);
  }
  dispatchEvent() {
    return true;
  }
  throwIfAborted() {
    if (this.aborted) throw this.reason || __lumo_abort_error();
  }
  _abort(reason) {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason === undefined ? __lumo_abort_error() : reason;
    const listeners = this._listeners.slice();
    this._listeners.length = 0;
    for (const listener of listeners) {
      try {
        listener.call(this, { type: 'abort', target: this });
      } catch (error) {
        __lumo_timer_errors.push(error);
      }
    }
    if (typeof this.onabort === 'function') {
      try {
        this.onabort.call(this, { type: 'abort', target: this });
      } catch (error) {
        __lumo_timer_errors.push(error);
      }
    }
  }
  static abort(reason) {
    const controller = new AbortController();
    controller.abort(reason);
    return controller.signal;
  }
  static timeout(ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(__lumo_make_error('TimeoutError', 'The operation was aborted due to timeout', 'ABORT_ERR'));
    }, ms);
    // Node's timeout signal does not keep the process alive.
    if (timer && typeof timer.unref === 'function') timer.unref();
    return controller.signal;
  }
  static any(signals) {
    const controller = new AbortController();
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      }
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
  }
}

class AbortController {
  constructor() {
    this.signal = new AbortSignal();
  }
  abort(reason) {
    this.signal._abort(reason);
  }
}

/* -------------------------------------------------------------------------- */
/* performance / structuredClone                                              */
/* -------------------------------------------------------------------------- */

const performance = {
  timeOrigin: __lumo_started_at,
  now() {
    return Date.now() - __lumo_started_at;
  },
  mark() {},
  measure() {},
  getEntries() {
    return [];
  },
  getEntriesByName() {
    return [];
  },
  clearMarks() {},
  clearMeasures() {},
  eventLoopUtilization() {
    return { idle: 0, active: 0, utilization: 0 };
  },
};

function structuredClone(value, options) {
  return __lumo_clone(value, []);
}

function __lumo_data_clone_error() {
  return __lumo_make_error('DataCloneError', 'value could not be cloned', 'DATA_CLONE_ERR');
}

function __lumo_clone(value, seen) {
  if (value === null) return value;
  const type = typeof value;
  if (type === 'function' || type === 'symbol') throw __lumo_data_clone_error();
  if (type !== 'object') return value;
  if (seen.indexOf(value) !== -1) return seen[seen.indexOf(value)];
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      return new DataView(value.buffer.slice(0), value.byteOffset, value.byteLength);
    }
    return new value.constructor(value);
  }
  if (Array.isArray(value)) {
    const out = [];
    seen.push(value);
    for (const item of value) out.push(__lumo_clone(item, seen));
    return out;
  }
  if (value instanceof Map) {
    const out = new Map();
    seen.push(value);
    value.forEach((v, k) => out.set(__lumo_clone(k, seen), __lumo_clone(v, seen)));
    return out;
  }
  if (value instanceof Set) {
    const out = new Set();
    seen.push(value);
    value.forEach((v) => out.add(__lumo_clone(v, seen)));
    return out;
  }
  const out = {};
  seen.push(value);
  for (const key of Object.keys(value)) out[key] = __lumo_clone(value[key], seen);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Intl (delegated to the host's ICU)                                         */
/* -------------------------------------------------------------------------- */

/**
 * QuickJS/WASM ships without ICU, so `Intl` would be `undefined` and every
 * `toLocaleDateString`/`toLocaleString` call degrades to engine defaults. The
 * host has full ICU; formatting is a cheap synchronous call, so the guest
 * proxies to it instead of pretending to know locales.
 */
function __lumo_intl_format(type, locales, options, extra) {
  const payload = Object.assign(
    {
      type: type,
      locale: locales === undefined || locales === null ? undefined : String(locales),
      options: options || {},
    },
    extra || {},
  );
  return __lumo_sync_json('intl.format', payload);
}

function __lumo_intl_resolved(type, locales, options) {
  return __lumo_sync_json('intl.resolved', {
    type: type,
    locale: locales === undefined || locales === null ? undefined : String(locales),
    options: options || {},
  });
}

function __lumo_intl_locales(locales) {
  if (locales === undefined) return undefined;
  return locales;
}

function DateTimeFormat(locales, options) {
  if (!(this instanceof DateTimeFormat)) return new DateTimeFormat(locales, options);
  this._locales = locales;
  this._options = options || {};
}
DateTimeFormat.prototype.format = function format(date) {
  const value =
    date === undefined
      ? Date.now()
      : date instanceof Date
        ? date.getTime()
        : Number(date);
  return __lumo_intl_format('date', this._locales, this._options, { value: value });
};
DateTimeFormat.prototype.formatToParts = function formatToParts(date) {
  return [{ type: 'literal', value: this.format(date) }];
};
DateTimeFormat.prototype.formatRange = function formatRange(start, end) {
  return this.format(start) + ' – ' + this.format(end);
};
DateTimeFormat.prototype.formatRangeToParts = function formatRangeToParts(start, end) {
  return [{ type: 'literal', value: this.formatRange(start, end), source: 'shared' }];
};
DateTimeFormat.prototype.resolvedOptions = function resolvedOptions() {
  return __lumo_intl_resolved('date', this._locales, this._options);
};
DateTimeFormat.supportedLocalesOf = (locales) => (locales === undefined ? [] : locales);

function NumberFormat(locales, options) {
  if (!(this instanceof NumberFormat)) return new NumberFormat(locales, options);
  this._locales = locales;
  this._options = options || {};
}
NumberFormat.prototype.format = function format(value) {
  return __lumo_intl_format('number', this._locales, this._options, {
    value: Number(value),
  });
};
NumberFormat.prototype.formatToParts = function formatToParts(value) {
  // Sign/exponent splitting is not reproduced; a single literal part keeps
  // `parts.map((part) => part.value).join('')` correct.
  return [{ type: 'literal', value: this.format(value) }];
};
NumberFormat.prototype.resolvedOptions = function resolvedOptions() {
  return __lumo_intl_resolved('number', this._locales, this._options);
};
NumberFormat.supportedLocalesOf = (locales) => (locales === undefined ? [] : locales);

function Collator(locales, options) {
  if (!(this instanceof Collator)) return new Collator(locales, options);
  this._locales = locales;
  this._options = options || {};
}
Collator.prototype.compare = function compare(a, b) {
  return __lumo_intl_format('collator', this._locales, this._options, {
    value: String(a),
    other: String(b),
  });
};
Collator.prototype.resolvedOptions = function resolvedOptions() {
  return __lumo_intl_resolved('collator', this._locales, this._options);
};
Collator.supportedLocalesOf = (locales) => (locales === undefined ? [] : locales);

function ListFormat(locales, options) {
  if (!(this instanceof ListFormat)) return new ListFormat(locales, options);
  this._locales = locales;
  this._options = options || {};
}
ListFormat.prototype.format = function format(list) {
  return __lumo_intl_format('list', this._locales, this._options, {
    value: (Array.isArray(list) ? list : []).map(String),
  });
};
ListFormat.prototype.formatToParts = function formatToParts(list) {
  return [{ type: 'element', value: this.format(list) }];
};
ListFormat.supportedLocalesOf = (locales) => (locales === undefined ? [] : locales);

function PluralRules(locales, options) {
  if (!(this instanceof PluralRules)) return new PluralRules(locales, options);
  this._locales = locales;
  this._options = options || {};
}
PluralRules.prototype.select = function select(value) {
  return __lumo_intl_format('plural', this._locales, this._options, { value: Number(value) });
};
PluralRules.prototype.resolvedOptions = function resolvedOptions() {
  return __lumo_intl_resolved('number', this._locales, this._options);
};

function RelativeTimeFormat(locales, options) {
  if (!(this instanceof RelativeTimeFormat)) return new RelativeTimeFormat(locales, options);
  this._locales = locales;
  this._options = options || {};
}
RelativeTimeFormat.prototype.format = function format(value, unit) {
  return __lumo_intl_format('relative', this._locales, this._options, {
    value: Number(value),
    unit: String(unit || 'second'),
  });
};
RelativeTimeFormat.prototype.resolvedOptions = function resolvedOptions() {
  return __lumo_intl_resolved('number', this._locales, this._options);
};

const Intl = {
  DateTimeFormat: DateTimeFormat,
  NumberFormat: NumberFormat,
  Collator: Collator,
  ListFormat: ListFormat,
  PluralRules: PluralRules,
  RelativeTimeFormat: RelativeTimeFormat,
  getCanonicalLocales(locales) {
    if (locales === undefined) return [];
    return (Array.isArray(locales) ? locales : [locales]).map(String);
  },
};

// `Intl` is the only place a locale-aware conversion can happen, so route the
// prototype helpers through it. Without this, `toLocaleString()` silently
// returns engine defaults (QuickJS has no ICU).
Date.prototype.toLocaleString = function toLocaleString(locales, options) {
  return new DateTimeFormat(locales, options).format(this);
};
Date.prototype.toLocaleDateString = function toLocaleDateString(locales, options) {
  const defaults = { year: 'numeric', month: 'numeric', day: 'numeric' };
  return new DateTimeFormat(locales, Object.assign(defaults, options || {})).format(this);
};
Date.prototype.toLocaleTimeString = function toLocaleTimeString(locales, options) {
  const defaults = { hour: 'numeric', minute: 'numeric', second: 'numeric' };
  return new DateTimeFormat(locales, Object.assign(defaults, options || {})).format(this);
};
Number.prototype.toLocaleString = function toLocaleString(locales, options) {
  return new NumberFormat(locales, options).format(this);
};
if (typeof BigInt !== 'undefined') {
  BigInt.prototype.toLocaleString = function toLocaleString(locales, options) {
    return new NumberFormat(locales, options).format(this);
  };
}
String.prototype.localeCompare = function localeCompare(that, locales, options) {
  return new Collator(locales, options).compare(this, that);
};

/* -------------------------------------------------------------------------- */
/* Hashes (md5 / sha1 / sha256 / sha512) and HMAC                             */
/* -------------------------------------------------------------------------- */

const __lumo_md5_k = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x2441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x4881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);
const __lumo_md5_s = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

function __lumo_md5(bytes) {
  const len = bytes.length;
  const total = (((len + 8) >>> 6) + 1) << 6;
  const buffer = new Uint8Array(total);
  buffer.set(bytes);
  buffer[len] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(total - 8, (len * 8) >>> 0, true);
  view.setUint32(total - 4, Math.floor((len * 8) / 4294967296), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let offset = 0; offset < total; offset += 64) {
    for (let j = 0; j < 16; j += 1) m[j] = view.getUint32(offset + j * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let j = 0; j < 64; j += 1) {
      let f;
      let g;
      if (j < 16) {
        f = (b & c) | (~b & d);
        g = j;
      } else if (j < 32) {
        f = (d & b) | (~d & c);
        g = (5 * j + 1) % 16;
      } else if (j < 48) {
        f = b ^ c ^ d;
        g = (3 * j + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * j) % 16;
      }
      const sum = (a + f + __lumo_md5_k[j] + m[g]) >>> 0;
      const shift = __lumo_md5_s[j];
      const rotated = ((sum << shift) | (sum >>> (32 - shift))) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotated) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

function __lumo_sha1(bytes) {
  const len = bytes.length;
  const total = (((len + 8) >>> 6) + 1) << 6;
  const buffer = new Uint8Array(total);
  buffer.set(bytes);
  buffer[len] = 0x80;
  const view = new DataView(buffer.buffer);
  const bits = len * 8;
  view.setUint32(total - 8, Math.floor(bits / 4294967296));
  view.setUint32(total - 4, bits >>> 0);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let offset = 0; offset < total; offset += 64) {
    for (let j = 0; j < 16; j += 1) w[j] = view.getUint32(offset + j * 4);
    for (let j = 16; j < 80; j += 1) {
      const x = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
      w[j] = ((x << 1) | (x >>> 31)) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let j = 0; j < 80; j += 1) {
      let f;
      let k;
      if (j < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (j < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (j < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = ((((a << 5) | (a >>> 27)) >>> 0) + f + e + k + w[j]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0);
  outView.setUint32(4, h1);
  outView.setUint32(8, h2);
  outView.setUint32(12, h3);
  outView.setUint32(16, h4);
  return out;
}

const __lumo_sha256_k = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function __lumo_sha256(bytes) {
  const len = bytes.length;
  const total = (((len + 8) >>> 6) + 1) << 6;
  const buffer = new Uint8Array(total);
  buffer.set(bytes);
  buffer[len] = 0x80;
  const view = new DataView(buffer.buffer);
  const bits = len * 8;
  view.setUint32(total - 8, Math.floor(bits / 4294967296));
  view.setUint32(total - 4, bits >>> 0);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  const rotr = (value, shift) => ((value >>> shift) | (value << (32 - shift))) >>> 0;
  for (let offset = 0; offset < total; offset += 64) {
    for (let j = 0; j < 16; j += 1) w[j] = view.getUint32(offset + j * 4);
    for (let j = 16; j < 64; j += 1) {
      const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let j = 0; j < 64; j += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + __lumo_sha256_k[j] + w[j]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  const state = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, state[i]);
  return out;
}

const __lumo_sha512_k = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
];

const __lumo_mask64 = (1n << 64n) - 1n;

function __lumo_rotr64(value, shift) {
  const big = BigInt(shift);
  return ((value >> big) | (value << (64n - big))) & __lumo_mask64;
}

function __lumo_sha512(bytes) {
  const len = bytes.length;
  const total = (((len + 16) >>> 7) + 1) << 7;
  const buffer = new Uint8Array(total);
  buffer.set(bytes);
  buffer[len] = 0x80;
  const view = new DataView(buffer.buffer);
  const bits = BigInt(len) * 8n;
  view.setUint32(total - 8, Number(bits >> 32n));
  view.setUint32(total - 4, Number(bits & 0xffffffffn));
  let h0 = 0x6a09e667f3bcc908n;
  let h1 = 0xbb67ae8584caa73bn;
  let h2 = 0x3c6ef372fe94f82bn;
  let h3 = 0xa54ff53a5f1d36f1n;
  let h4 = 0x510e527fade682d1n;
  let h5 = 0x9b05688c2b3e6c1fn;
  let h6 = 0x1f83d9abfb41bd6bn;
  let h7 = 0x5be0cd19137e2179n;
  const w = new Array(80);
  for (let offset = 0; offset < total; offset += 128) {
    for (let j = 0; j < 16; j += 1) {
      const hi = view.getUint32(offset + j * 8);
      const lo = view.getUint32(offset + j * 8 + 4);
      w[j] = (BigInt(hi) << 32n) | BigInt(lo);
    }
    for (let j = 16; j < 80; j += 1) {
      const s0 = __lumo_rotr64(w[j - 15], 1) ^ __lumo_rotr64(w[j - 15], 8) ^ (w[j - 15] >> 7n);
      const s1 = __lumo_rotr64(w[j - 2], 19) ^ __lumo_rotr64(w[j - 2], 61) ^ (w[j - 2] >> 6n);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) & __lumo_mask64;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let j = 0; j < 80; j += 1) {
      const s1 = __lumo_rotr64(e, 14) ^ __lumo_rotr64(e, 18) ^ __lumo_rotr64(e, 41);
      const ch = (e & f) ^ (~e & __lumo_mask64 & g);
      const temp1 = (h + s1 + ch + __lumo_sha512_k[j] + w[j]) & __lumo_mask64;
      const s0 = __lumo_rotr64(a, 28) ^ __lumo_rotr64(a, 34) ^ __lumo_rotr64(a, 39);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) & __lumo_mask64;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) & __lumo_mask64;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) & __lumo_mask64;
    }
    h0 = (h0 + a) & __lumo_mask64;
    h1 = (h1 + b) & __lumo_mask64;
    h2 = (h2 + c) & __lumo_mask64;
    h3 = (h3 + d) & __lumo_mask64;
    h4 = (h4 + e) & __lumo_mask64;
    h5 = (h5 + f) & __lumo_mask64;
    h6 = (h6 + g) & __lumo_mask64;
    h7 = (h7 + h) & __lumo_mask64;
  }
  const out = new Uint8Array(64);
  const outView = new DataView(out.buffer);
  const state = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i += 1) {
    outView.setUint32(i * 8, Number(state[i] >> 32n));
    outView.setUint32(i * 8 + 4, Number(state[i] & 0xffffffffn));
  }
  return out;
}

function __lumo_sha384(bytes) {
  // SHA-384 is SHA-512 with a different IV and truncation.
  const len = bytes.length;
  const total = (((len + 16) >>> 7) + 1) << 7;
  const buffer = new Uint8Array(total);
  buffer.set(bytes);
  buffer[len] = 0x80;
  const view = new DataView(buffer.buffer);
  const bits = BigInt(len) * 8n;
  view.setUint32(total - 8, Number(bits >> 32n));
  view.setUint32(total - 4, Number(bits & 0xffffffffn));
  let h0 = 0xcbbb9d5dc1059ed8n;
  let h1 = 0x629a292a367cd507n;
  let h2 = 0x9159015a3070dd17n;
  let h3 = 0x152fecd8f70e5939n;
  let h4 = 0x67332667ffc00b31n;
  let h5 = 0x8eb44a8768581511n;
  let h6 = 0xdb0c2e0d64f98fa7n;
  let h7 = 0x47b5481dbefa4fa4n;
  const w = new Array(80);
  for (let offset = 0; offset < total; offset += 128) {
    for (let j = 0; j < 16; j += 1) {
      const hi = view.getUint32(offset + j * 8);
      const lo = view.getUint32(offset + j * 8 + 4);
      w[j] = (BigInt(hi) << 32n) | BigInt(lo);
    }
    for (let j = 16; j < 80; j += 1) {
      const s0 = __lumo_rotr64(w[j - 15], 1) ^ __lumo_rotr64(w[j - 15], 8) ^ (w[j - 15] >> 7n);
      const s1 = __lumo_rotr64(w[j - 2], 19) ^ __lumo_rotr64(w[j - 2], 61) ^ (w[j - 2] >> 6n);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) & __lumo_mask64;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let j = 0; j < 80; j += 1) {
      const s1 = __lumo_rotr64(e, 14) ^ __lumo_rotr64(e, 18) ^ __lumo_rotr64(e, 41);
      const ch = (e & f) ^ (~e & __lumo_mask64 & g);
      const temp1 = (h + s1 + ch + __lumo_sha512_k[j] + w[j]) & __lumo_mask64;
      const s0 = __lumo_rotr64(a, 28) ^ __lumo_rotr64(a, 34) ^ __lumo_rotr64(a, 39);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) & __lumo_mask64;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) & __lumo_mask64;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) & __lumo_mask64;
    }
    h0 = (h0 + a) & __lumo_mask64;
    h1 = (h1 + b) & __lumo_mask64;
    h2 = (h2 + c) & __lumo_mask64;
    h3 = (h3 + d) & __lumo_mask64;
    h4 = (h4 + e) & __lumo_mask64;
    h5 = (h5 + f) & __lumo_mask64;
    h6 = (h6 + g) & __lumo_mask64;
    h7 = (h7 + h) & __lumo_mask64;
  }
  const out = new Uint8Array(48);
  const outView = new DataView(out.buffer);
  const state = [h0, h1, h2, h3, h4, h5];
  for (let i = 0; i < 6; i += 1) {
    outView.setUint32(i * 8, Number(state[i] >> 32n));
    outView.setUint32(i * 8 + 4, Number(state[i] & 0xffffffffn));
  }
  return out;
}

const __lumo_hash_specs = {
  md5: { fn: __lumo_md5, blockSize: 64 },
  sha1: { fn: __lumo_sha1, blockSize: 64 },
  sha256: { fn: __lumo_sha256, blockSize: 64 },
  sha384: { fn: __lumo_sha384, blockSize: 128 },
  sha512: { fn: __lumo_sha512, blockSize: 128 },
};

const __lumo_hash_aliases = {
  md5: 'md5',
  sha1: 'sha1',
  'sha-1': 'sha1',
  sha256: 'sha256',
  'sha-256': 'sha256',
  sha384: 'sha384',
  'sha-384': 'sha384',
  sha512: 'sha512',
  'sha-512': 'sha512',
  'sha512-256': 'sha512',
};

function __lumo_hash_spec(algorithm) {
  const key = String(algorithm).toLowerCase().replace(/^sha/,'sha').trim();
  const normalized = __lumo_hash_aliases[key] || (__lumo_hash_specs[key] ? key : undefined);
  const spec = normalized ? __lumo_hash_specs[normalized] : undefined;
  if (!spec) {
    throw new Error(
      "Digest method not supported: '" + algorithm + "'. Supported: md5, sha1, sha256, sha384, sha512",
    );
  }
  return { name: normalized, ...spec };
}

function __lumo_hmac(hashFn, blockSize, keyBytes, dataBytes) {
  let key = keyBytes;
  if (key.length > blockSize) key = hashFn(key);
  const padded = new Uint8Array(blockSize);
  padded.set(key);
  const inner = new Uint8Array(blockSize);
  const outer = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i += 1) {
    inner[i] = padded[i] ^ 0x36;
    outer[i] = padded[i] ^ 0x5c;
  }
  return hashFn(__lumo_concat_bytes([outer, hashFn(__lumo_concat_bytes([inner, dataBytes]))]));
}

function __lumo_hash_object(algorithm) {
  const spec = __lumo_hash_spec(algorithm);
  const chunks = [];
  const self = {
    _chunks: chunks,
    update(data, encoding) {
      chunks.push(__lumo_to_bytes(data, encoding));
      return self;
    },
    digest(encoding) {
      const out = spec.fn(__lumo_concat_bytes(chunks));
      chunks.length = 0;
      return encoding ? Buffer.from(out).toString(encoding) : Buffer.from(out);
    },
    copy() {
      const clone = __lumo_hash_object(algorithm);
      clone._chunks.push(...chunks.map((chunk) => chunk.slice()));
      return clone;
    },
  };
  return self;
}

function __lumo_hmac_object(algorithm, key, keyEncoding) {
  const spec = __lumo_hash_spec(algorithm);
  const keyBytes = __lumo_to_bytes(key, keyEncoding);
  const chunks = [];
  const self = {
    _chunks: chunks,
    update(data, encoding) {
      chunks.push(__lumo_to_bytes(data, encoding));
      return self;
    },
    digest(encoding) {
      const out = __lumo_hmac(spec.fn, spec.blockSize, keyBytes, __lumo_concat_bytes(chunks));
      chunks.length = 0;
      return encoding ? Buffer.from(out).toString(encoding) : Buffer.from(out);
    },
  };
  return self;
}

/* -------------------------------------------------------------------------- */
/* Timers                                                                     */
/* -------------------------------------------------------------------------- */

let __lumo_timer_seq = 0;
const __lumo_timers = new Map();
let __lumo_pending_timers = 0;
let __lumo_idle_resolve = null;

function __lumo_timer_begin() {
  __lumo_pending_begin();
}

function __lumo_timer_finish(state, id) {
  if (state.done) return;
  state.done = true;
  __lumo_timers.delete(id);
  if (!state.unrefed) __lumo_pending_end();
}

function __lumo_wait_timers() {
  if (__lumo_pending_timers <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    __lumo_idle_resolve = resolve;
  });
}

/** Node returns a `Timeout` object; scripts call `unref()`/`refresh()` on it. */
class Timeout {
  constructor(id) {
    this._id = id;
    this._ref = true;
    this._state = __lumo_timers.get(id);
  }
  ref() {
    this._ref = true;
    const state = this._state;
    if (state && !state.done && state.unrefed) {
      state.unrefed = false;
      __lumo_timer_begin();
    }
    return this;
  }
  unref() {
    this._ref = false;
    const state = this._state;
    if (state && !state.done && !state.unrefed) {
      state.unrefed = true;
      __lumo_pending_end();
    }
    return this;
  }
  hasRef() {
    return this._ref;
  }
  refresh() {
    const state = this._state;
    if (!state || state.done) return this;
    if (state.cancelled) {
      state.cancelled = false;
      state.done = false;
      __lumo_timers.set(this._id, state);
    }
    state.restart = true;
    return this;
  }
  close() {
    clearTimer(this._id);
    return this;
  }
  [Symbol.toPrimitive]() {
    return this._id;
  }
}

function __lumo_cancel_all_timers() {
  for (const [id, state] of Array.from(__lumo_timers.entries())) {
    state.cancelled = true;
    __lumo_timer_finish(state, id);
  }
}

function __lumo_schedule_timer(callback, delay, args, repeat) {
  const id = ++__lumo_timer_seq;
  const state = { cancelled: false, done: false, unrefed: false, restart: false };
  __lumo_timers.set(id, state);
  __lumo_timer_begin();
  const wait = Math.max(0, Math.min(Number(delay) || 0, __lumo_timeout_ms));
  (async () => {
    try {
      do {
        state.restart = false;
        await __lumo_host('timer.wait', JSON.stringify({ ms: wait }));
        if (state.cancelled) break;
        try {
          callback(...args);
        } catch (error) {
          if (__lumo_process_exit_code(error) !== null) {
            // `process.exit()` inside a timer cannot unwind the script, so
            // record the code and stop scheduling further work.
            process.exitCode = __lumo_process_exit_code(error);
            __lumo_cancel_all_timers();
            break;
          }
          __lumo_timer_errors.push(error);
        }
        if (repeat && state.restart) continue;
      } while (repeat && !state.cancelled);
    } catch (error) {
      if (!state.cancelled) __lumo_timer_errors.push(error);
    } finally {
      __lumo_timer_finish(state, id);
    }
  })();
  return new Timeout(id);
}

function setTimeout(callback, delay, ...args) {
  if (typeof callback !== 'function') throw new TypeError('setTimeout: callback must be a function');
  return __lumo_schedule_timer(callback, delay, args, false);
}

function setInterval(callback, delay, ...args) {
  if (typeof callback !== 'function') throw new TypeError('setInterval: callback must be a function');
  // A zero-delay interval would spin the host bridge; Node clamps to 1ms.
  return __lumo_schedule_timer(callback, Math.max(1, Number(delay) || 1), args, true);
}

function clearTimer(id) {
  const numeric = typeof id === 'object' && id !== null ? Number(id) : Number(id);
  const state = __lumo_timers.get(numeric);
  if (!state) return;
  state.cancelled = true;
  __lumo_timer_finish(state, numeric);
}

const clearTimeout = clearTimer;
const clearInterval = clearTimer;

function setImmediate(callback, ...args) {
  return setTimeout(callback, 0, ...args);
}

function clearImmediate(id) {
  clearTimeout(id);
}

function queueMicrotask(callback) {
  Promise.resolve().then(() => {
    try {
      callback();
    } catch (error) {
      __lumo_timer_errors.push(error);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* console                                                                    */
/* -------------------------------------------------------------------------- */

const __lumo_console_timers = new Map();
const __lumo_console_counts = new Map();
let __lumo_console_indent = 0;

function __lumo_console_prefix(text) {
  if (__lumo_console_indent <= 0) return text;
  const padding = ' '.repeat(__lumo_console_indent * 2);
  return text
    .split('\n')
    .map((line) => padding + line)
    .join('\n');
}

const console = {
  log(...args) {
    __lumo_out(__lumo_console_prefix(__lumo_format_args(args)));
  },
  info(...args) {
    __lumo_out(__lumo_console_prefix(__lumo_format_args(args)));
  },
  debug(...args) {
    __lumo_out(__lumo_console_prefix(__lumo_format_args(args)));
  },
  dir(value) {
    __lumo_out(__lumo_inspect(value, 4));
  },
  warn(...args) {
    __lumo_err(__lumo_console_prefix(__lumo_format_args(args)));
  },
  error(...args) {
    __lumo_err(__lumo_console_prefix(__lumo_format_args(args)));
  },
  trace(...args) {
    __lumo_err('Trace: ' + __lumo_format_args(args) + '\n' + new Error().stack);
  },
  assert(condition, ...args) {
    if (!condition) __lumo_err('Assertion failed: ' + __lumo_format_args(args));
  },
  time(label) {
    __lumo_console_timers.set(String(label || 'default'), Date.now());
  },
  timeEnd(label) {
    const key = String(label || 'default');
    const started = __lumo_console_timers.get(key);
    if (started === undefined) return;
    __lumo_console_timers.delete(key);
    __lumo_out(key + ': ' + (Date.now() - started) + 'ms');
  },
  timeLog(label, ...args) {
    const key = String(label || 'default');
    const started = __lumo_console_timers.get(key);
    if (started === undefined) return;
    __lumo_out(key + ': ' + (Date.now() - started) + 'ms ' + __lumo_format_args(args));
  },
  table(data, columns) {
    if (!data || typeof data !== 'object') {
      __lumo_out(__lumo_inspect(data));
      return;
    }
    const rows = Array.isArray(data)
      ? data.map((value, index) =>
          value && typeof value === 'object'
            ? Object.assign({ '(index)': String(index) }, value)
            : { '(index)': String(index), value },
        )
      : Object.keys(data).map((key) =>
          data[key] && typeof data[key] === 'object'
            ? Object.assign({ '(index)': key }, data[key])
            : { '(index)': key, value: data[key] },
        );
    if (rows.length === 0) return;
    const keys =
      Array.isArray(columns) && columns.length > 0
        ? columns.map(String)
        : Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).filter((key) => key !== '(index)');
    const header = ['(index)'].concat(keys);
    const body = rows.map((row) => header.map((key) => String(row[key] === undefined ? '' : row[key])));
    __lumo_out([header].concat(body).map((row) => row.join('\t')).join('\n'));
  },
  group(...args) {
    if (args.length > 0) __lumo_out(__lumo_console_prefix(__lumo_format_args(args)));
    __lumo_console_indent += 1;
  },
  groupCollapsed(...args) {
    console.group(...args);
  },
  groupEnd() {
    __lumo_console_indent = Math.max(0, __lumo_console_indent - 1);
  },
  count(label) {
    const key = String(label === undefined ? 'default' : label);
    const next = (__lumo_console_counts.get(key) || 0) + 1;
    __lumo_console_counts.set(key, next);
    __lumo_out(__lumo_console_prefix(key + ': ' + next));
  },
  countReset(label) {
    __lumo_console_counts.delete(String(label === undefined ? 'default' : label));
  },
  timeStamp() {},
  clear() {},
};

/** `new console.Console({stdout, stderr})` — routes to the supplied streams. */
function Console(options) {
  if (!(this instanceof Console)) return new Console(options);
  const target = options || {};
  this._stdout = target.stdout;
  this._stderr = target.stderr;
}
Console.prototype.log = function log(...args) {
  const line = __lumo_format_args(args);
  if (this._stdout && typeof this._stdout.write === 'function') this._stdout.write(line + '\n');
  else console.log(line);
};
Console.prototype.info = Console.prototype.log;
Console.prototype.debug = Console.prototype.log;
Console.prototype.warn = function warn(...args) {
  const line = __lumo_format_args(args);
  if (this._stderr && typeof this._stderr.write === 'function') this._stderr.write(line + '\n');
  else console.warn(line);
};
Console.prototype.error = Console.prototype.warn;
Console.prototype.dir = function dir(value) {
  this.log(__lumo_inspect(value, 4));
};
Console.prototype.table = console.table;
Console.prototype.assert = console.assert;
Console.prototype.count = console.count;
Console.prototype.time = console.time;
Console.prototype.timeEnd = console.timeEnd;
console.Console = Console;

/* -------------------------------------------------------------------------- */
/* process                                                                    */
/* -------------------------------------------------------------------------- */

function __lumo_format_hrtime(previous) {
  const now = Date.now() * 1e6;
  const delta = previous ? now - (previous[0] * 1e9 + previous[1]) : now;
  return [Math.floor(delta / 1e9), Math.floor(delta % 1e9)];
}

const __lumo_exit_hooks = [];

function __lumo_run_exit_hooks() {
  while (__lumo_exit_hooks.length > 0) {
    const hook = __lumo_exit_hooks.pop();
    try {
      hook();
    } catch (error) {
      __lumo_err(__lumo_error_text(error));
    }
  }
}

/** Populated once from the host so `os`/`process` report reachable values. */
let __lumo_sysinfo_cache = null;
function __lumo_sysinfo() {
  if (!__lumo_sysinfo_cache) {
    try {
      __lumo_sysinfo_cache = __lumo_sync_json('os.info', {});
    } catch {
      __lumo_sysinfo_cache = {
        cpus: 4,
        totalmem: 8 * 1024 ** 3,
        freemem: 4 * 1024 ** 3,
        hostname: 'lumo',
        homedir: '/',
        tmpdir: '/tmp',
        username: 'lumo',
        platform: 'linux',
        arch: 'x64',
      };
    }
  }
  return __lumo_sysinfo_cache;
}

const process = {
  argv: __lumo_config.argv || ['node'],
  env: __lumo_config.env || {},
  version: 'v0.0.0-lumo',
  versions: {
    node: '0.0.0',
    lumo: __lumo_config.version || '0.0.0',
    quickjs: 'quickjs-wasm',
  },
  platform: 'linux',
  arch: 'x64',
  pid: 1,
  ppid: 0,
  title: 'lumo',
  exitCode: 0,
  cwd() {
    return __lumo_current_cwd;
  },
  chdir(directory) {
    __lumo_current_cwd = __lumo_path.resolve(__lumo_current_cwd, String(directory));
  },
  exit(code) {
    __lumo_run_exit_hooks();
    // A dedicated property, not a marker inside the message: a guest error whose
    // text happened to contain the marker used to change the exit code.
    const error = new Error('process.exit(' + (code === undefined ? process.exitCode : code) + ')');
    error.__lumo_process_exit = code === undefined ? process.exitCode : code;
    throw error;
  },
  nextTick(callback, ...args) {
    queueMicrotask(() => callback(...args));
  },
  hrtime: __lumo_format_hrtime,
  uptime() {
    return (Date.now() - __lumo_started_at) / 1000;
  },
  memoryUsage() {
    const info = __lumo_sysinfo();
    // A rough but non-zero picture: the VM is capped by the host runtime.
    const total = 64 * 1024 * 1024;
    return {
      rss: Math.round(total * 0.6),
      heapTotal: Math.round(total * 0.5),
      heapUsed: Math.round(total * 0.3),
      external: info ? 1024 * 1024 : 0,
      arrayBuffers: 0,
    };
  },
  cpuUsage() {
    return { user: 0, system: 0 };
  },
  emitWarning(message, options) {
    const type = options && typeof options.type === 'string' ? options.type : 'Warning';
    __lumo_err(type + ': ' + String(message));
  },
  umask() {
    return 0o022;
  },
  getuid() {
    return 1000;
  },
  geteuid() {
    return 1000;
  },
  getgid() {
    return 1000;
  },
  getegid() {
    return 1000;
  },
  resourceUsage() {
    const seconds = process.uptime();
    return {
      userCPUTime: Math.round(seconds * 1000),
      systemCPUTime: 0,
      maxRSS: 0,
      sharedMemorySize: 0,
      unsharedDataSize: 0,
      unsharedStackSize: 0,
      minorPageFault: 0,
      majorPageFault: 0,
      swappedOut: 0,
      fsRead: 0,
      fsWrite: 0,
      ipcSent: 0,
      ipcReceived: 0,
      signalsCount: 0,
      voluntaryContextSwitches: 0,
      involuntaryContextSwitches: 0,
    };
  },
  kill(pid, signal) {
    void signal;
    throw new Error("process.kill is not available in the browser (no OS processes, pid " + pid + ')');
  },
  on(name, listener) {
    if (name === 'exit' && typeof listener === 'function') __lumo_exit_hooks.push(listener);
    return process;
  },
  addListener(name, listener) {
    return process.on(name, listener);
  },
  once(name, listener) {
    return process.on(name, listener);
  },
  off() {
    return process;
  },
  removeListener() {
    return process;
  },
  removeAllListeners() {
    return process;
  },
  listeners() {
    return [];
  },
  emit() {
    return false;
  },
};
process.allowedNodeEnvironmentFlags = {
  has() {
    return false;
  },
};
process.memoryUsage.rss = () => process.memoryUsage().rss;
process.hrtime.bigint = function hrtimeBigint() {
  return BigInt(Date.now()) * 1000000n;
};
process.stdout = {
  isTTY: false,
  columns: 80,
  rows: 24,
  write(chunk, encoding, callback) {
    __lumo_out(String(chunk).replace(/\n$/, ''));
    if (typeof encoding === 'function') callback = encoding;
    if (typeof callback === 'function') queueMicrotask(() => callback());
    return true;
  },
};
process.stderr = {
  isTTY: false,
  columns: 80,
  rows: 24,
  write(chunk, encoding, callback) {
    __lumo_err(String(chunk).replace(/\n$/, ''));
    if (typeof encoding === 'function') callback = encoding;
    if (typeof callback === 'function') queueMicrotask(() => callback());
    return true;
  },
};
process.stdin = {
  isTTY: false,
  readableEnded: true,
  destroyed: true,
  on() {
    return process.stdin;
  },
  once() {
    return process.stdin;
  },
  off() {
    return process.stdin;
  },
  removeListener() {
    return process.stdin;
  },
  pause() {
    return process.stdin;
  },
  resume() {
    return process.stdin;
  },
  setEncoding() {
    return process.stdin;
  },
  read() {
    return null;
  },
};

/* -------------------------------------------------------------------------- */
/* path (POSIX)                                                               */
/* -------------------------------------------------------------------------- */

function __lumo_path_normalize(input) {
  const path = String(input);
  if (path === '') return '.';
  const absolute = path.charAt(0) === '/';
  const trailing = path.length > 1 && path.charAt(path.length - 1) === '/';
  const parts = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!absolute) parts.push('..');
      continue;
    }
    parts.push(segment);
  }
  let out = parts.join('/');
  if (out === '') out = absolute ? '/' : '.';
  else if (absolute) out = '/' + out;
  if (trailing && out !== '/') out += '/';
  return out;
}

const __lumo_path = {
  sep: '/',
  delimiter: ':',
  posix: null,
  win32: null,
  normalize: __lumo_path_normalize,
  isAbsolute(value) {
    return String(value).charAt(0) === '/';
  },
  join(...parts) {
    const filtered = parts.filter((part) => part !== undefined && part !== null && String(part) !== '');
    if (filtered.length === 0) return '.';
    return __lumo_path_normalize(filtered.map(String).join('/'));
  },
  resolve(...parts) {
    let resolved = '';
    let absolute = false;
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const part = String(parts[i]);
      if (part === '') continue;
      resolved = resolved === '' ? part : part + '/' + resolved;
      if (part.charAt(0) === '/') {
        absolute = true;
        break;
      }
    }
    if (!absolute) resolved = __lumo_current_cwd + '/' + resolved;
    return __lumo_path_normalize(resolved);
  },
  dirname(value) {
    const path = String(value).replace(/\/+$/, '');
    if (path === '') return '.';
    const index = path.lastIndexOf('/');
    if (index === -1) return '.';
    if (index === 0) return '/';
    return path.slice(0, index);
  },
  basename(value, suffix) {
    const path = String(value).replace(/\/+$/, '');
    const index = path.lastIndexOf('/');
    let base = index === -1 ? path : path.slice(index + 1);
    if (suffix && base.endsWith(String(suffix))) base = base.slice(0, -String(suffix).length);
    return base;
  },
  extname(value) {
    const base = __lumo_path.basename(value);
    const index = base.lastIndexOf('.');
    return index <= 0 ? '' : base.slice(index);
  },
  relative(from, to) {
    const start = __lumo_path.resolve(from).split('/').filter(Boolean);
    const end = __lumo_path.resolve(to).split('/').filter(Boolean);
    let common = 0;
    while (common < start.length && common < end.length && start[common] === end[common]) common += 1;
    const up = start.slice(common).map(() => '..');
    return up.concat(end.slice(common)).join('/') || '';
  },
  parse(value) {
    const path = String(value);
    const dir = __lumo_path.dirname(path);
    const base = __lumo_path.basename(path);
    const ext = __lumo_path.extname(path);
    const root = path.charAt(0) === '/' ? '/' : '';
    return {
      root,
      dir: dir === '.' ? '' : dir,
      base,
      ext,
      name: ext ? base.slice(0, -ext.length) : base,
    };
  },
  format(value) {
    const dir = value.dir || value.root || '';
    const base = value.base || (value.name || '') + (value.ext || '');
    return dir ? (dir === '/' ? '/' + base : dir + '/' + base) : base;
  },
  toNamespacedPath(value) {
    return value;
  },
  matchesGlob(path, pattern) {
    const regex = new RegExp(
      '^' +
        String(pattern)
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '\u0000')
          .replace(/\*/g, '[^/]*')
          .replace(/\u0000/g, '.*')
          .replace(/\?/g, '.') +
        '$',
    );
    return regex.test(String(path));
  },
};
__lumo_path.posix = __lumo_path;
__lumo_path.win32 = __lumo_make_win32_path();


/** A real `path.win32`: the posix alias silently produced `/` separators. */
function __lumo_make_win32_path() {
  const normalize = (input) => {
    let path = String(input).replace(/\//g, '\\');
    if (path === '') return '.';
    let device = '';
    const drive = /^([a-zA-Z]:)/.exec(path);
    if (drive) {
      device = drive[1].toUpperCase();
      path = path.slice(2);
    }
    const absolute = path.charAt(0) === '\\';
    const trailing = path.length > 1 && path.charAt(path.length - 1) === '\\';
    const parts = [];
    for (const segment of path.split('\\')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') {
        if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
        else if (!absolute) parts.push('..');
        continue;
      }
      parts.push(segment);
    }
    let out = parts.join('\\');
    if (device) out = device + (absolute ? '\\' : '') + out;
    else if (absolute) out = '\\' + out;
    if (out === '') out = device ? device + '\\' : '.';
    else if (trailing && out.charAt(out.length - 1) !== '\\') out += '\\';
    return out;
  };

  const win = {
    sep: '\\',
    delimiter: ';',
    normalize: normalize,
    isAbsolute(value) {
      const text = String(value);
      return /^[a-zA-Z]:[\\/]/.test(text) || /^[\\/]{2}/.test(text) || text.charAt(0) === '\\';
    },
    join(...parts) {
      const filtered = parts.filter((part) => part !== undefined && part !== null && String(part) !== '');
      if (filtered.length === 0) return '.';
      return normalize(filtered.map(String).join('\\'));
    },
    resolve(...parts) {
      let resolved = '';
      let absolute = false;
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const part = String(parts[i]);
        if (part === '') continue;
        resolved = resolved === '' ? part : part + '\\' + resolved;
        if (win.isAbsolute(part)) {
          absolute = true;
          break;
        }
      }
      if (!absolute) resolved = 'C:' + __lumo_current_cwd.replace(/\//g, '\\') + '\\' + resolved;
      return normalize(resolved);
    },
    dirname(value) {
      const path = String(value).replace(/[\\/]+$/, '');
      if (path === '') return '.';
      const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
      if (index === -1) return '.';
      if (index === 0) return path.charAt(0);
      const head = path.slice(0, index);
      if (/^[a-zA-Z]:$/.test(head)) return head + '\\';
      return head;
    },
    basename(value, suffix) {
      const path = String(value).replace(/[\\/]+$/, '');
      const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
      let base = index === -1 ? path : path.slice(index + 1);
      if (suffix && base.endsWith(String(suffix))) base = base.slice(0, -String(suffix).length);
      return base;
    },
    extname(value) {
      const base = win.basename(value);
      const index = base.lastIndexOf('.');
      return index <= 0 ? '' : base.slice(index);
    },
    relative(from, to) {
      const start = normalize(from).split('\\').filter(Boolean);
      const end = normalize(to).split('\\').filter(Boolean);
      let common = 0;
      while (common < start.length && common < end.length && start[common] === end[common]) common += 1;
      const up = start.slice(common).map(() => '..');
      return up.concat(end.slice(common)).join('\\') || '';
    },
    parse(value) {
      const path = String(value);
      const dir = win.dirname(path);
      const base = win.basename(path);
      const ext = win.extname(path);
      const root = /^[a-zA-Z]:[\\/]/.test(path) ? path.slice(0, 3) : path.charAt(0) === '\\' ? '\\' : '';
      return {
        root: root,
        dir: dir === '.' ? '' : dir,
        base: base,
        ext: ext,
        name: ext ? base.slice(0, -ext.length) : base,
      };
    },
    format(value) {
      const dir = value.dir || value.root || '';
      const base = value.base || (value.name || '') + (value.ext || '');
      return dir ? dir.replace(/[\\/]+$/, '') + '\\' + base : base;
    },
    toNamespacedPath(value) {
      return value;
    },
    matchesGlob(path, pattern) {
      return __lumo_path.matchesGlob(String(path).replace(/\\/g, '/'), String(pattern).replace(/\\/g, '/'));
    },
  };
  win.posix = __lumo_path;
  win.win32 = win;
  return win;
}

/* -------------------------------------------------------------------------- */
/* os / util / events                                                         */
/* -------------------------------------------------------------------------- */

const os = {
  EOL: '\n',
  platform: () => 'linux',
  arch: () => 'x64',
  type: () => 'Linux',
  release: () => '0.0.0-lumo',
  version: () => 'lumo',
  homedir: () => __lumo_sysinfo().homedir,
  tmpdir: () => __lumo_sysinfo().tmpdir,
  hostname: () => __lumo_sysinfo().hostname,
  userInfo: () => ({
    username: __lumo_sysinfo().username,
    homedir: __lumo_sysinfo().homedir,
    shell: '/bin/bash',
    uid: 1000,
    gid: 1000,
  }),
  cpus: () =>
    Array.from({ length: __lumo_sysinfo().cpus }, (_, index) => ({
      model: 'lumo-quickjs',
      speed: 1000,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      index,
    })),
  availableParallelism: () => __lumo_sysinfo().cpus,
  totalmem: () => __lumo_sysinfo().totalmem,
  freemem: () => __lumo_sysinfo().freemem,
  uptime: () => (Date.now() - __lumo_started_at) / 1000,
  loadavg: () => [0, 0, 0],
  endianness: () => 'LE',
  networkInterfaces: () => ({}),
  constants: {},
};

function __lumo_deep_equal(a, b, seen) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  const pairs = seen || [];
  for (const [left, right] of pairs) {
    if (left === a && right === b) return true;
  }
  pairs.push([a, b]);
  try {
    if (a instanceof Date || b instanceof Date) {
      return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    }
    if (a instanceof RegExp || b instanceof RegExp) {
      return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
    }
    if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
      if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false;
      return true;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (a instanceof Map || b instanceof Map) {
      if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
      for (const [key, value] of a) {
        let found = false;
        for (const [otherKey, otherValue] of b) {
          if (__lumo_deep_equal(key, otherKey, pairs) && __lumo_deep_equal(value, otherValue, pairs)) {
            found = true;
            break;
          }
        }
        if (!found) return false;
      }
      return true;
    }
    if (a instanceof Set || b instanceof Set) {
      if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
      for (const value of a) {
        let found = false;
        for (const other of b) {
          if (__lumo_deep_equal(value, other, pairs)) {
            found = true;
            break;
          }
        }
        if (!found) return false;
      }
      return true;
    }
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!__lumo_deep_equal(a[key], b[key], pairs)) return false;
    }
    return true;
  } finally {
    pairs.pop();
  }
}


/** `util.parseArgs` for the common strict-mode shape. */
function __lumo_parse_args(config) {
  const options = config.options || {};
  const strict = config.strict !== false;
  const allowPositionals = config.allowPositionals !== false || config.positionals === true;
  const argv = config.args || process.argv.slice(2);
  const byShort = {};
  for (const name of Object.keys(options)) {
    const definition = options[name] || {};
    if (typeof definition.short === 'string') {
      for (const letter of definition.short) byShort[letter] = name;
    }
    if (Array.isArray(definition.multiple)) {
      // `multiple: true` is expressed as an array type in Node 22.
    }
  }
  const values = {};
  const positionals = [];
  const setValue = (name, definition, value) => {
    const many = definition.multiple === true || Array.isArray(definition.multiple);
    if (many) {
      if (!Array.isArray(values[name])) values[name] = [];
      values[name].push(value);
      return;
    }
    values[name] = value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      const name = eq === -1 ? body : body.slice(0, eq);
      const definition = options[name];
      if (!definition) {
        if (strict) throw new Error("Unknown option '--" + name + "'");
        positionals.push(arg);
        continue;
      }
      if (definition.type === 'boolean') {
        setValue(name, definition, true);
      } else {
        const value = eq === -1 ? argv[++i] : body.slice(eq + 1);
        if (value === undefined) throw new Error("Option '--" + name + "' requires a value");
        setValue(name, definition, value);
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const letters = arg.slice(1);
      for (let j = 0; j < letters.length; j += 1) {
        const name = byShort[letters.charAt(j)];
        const definition = name ? options[name] : undefined;
        if (!definition) {
          if (strict) throw new Error("Unknown option '-" + letters.charAt(j) + "'");
          continue;
        }
        if (definition.type === 'boolean') {
          setValue(name, definition, true);
          continue;
        }
        const rest = letters.slice(j + 1);
        const value = rest.length > 0 ? rest : argv[++i];
        if (value === undefined) throw new Error("Option '-" + letters.charAt(j) + "' requires a value");
        setValue(name, definition, value);
        j = letters.length;
      }
      continue;
    }
    positionals.push(arg);
    if (!allowPositionals && strict) {
      throw new Error("Unexpected argument '" + arg + "'");
    }
  }
  return { values: values, positionals: positionals };
}
function __lumo_promisify(fn) {
  return function promisified(...args) {
    return new Promise((resolve, reject) => {
      fn.call(this, ...args, (error, value) => (error ? reject(error) : resolve(value)));
    });
  };
}

function __lumo_callbackify(fn) {
  return function callbackified(...args) {
    const callback = args.pop();
    Promise.resolve(fn.apply(this, args)).then(
      (value) => queueMicrotask(() => callback(null, value)),
      (error) => queueMicrotask(() => callback(error)),
    );
  };
}

const util = {
  format: __lumo_format,
  formatWithOptions(_options, ...args) {
    return __lumo_format.apply(null, args);
  },
  inspect(value, options) {
    return __lumo_inspect(value, options && options.depth !== undefined ? options.depth : 2);
  },
  promisify: __lumo_promisify,
  callbackify: __lumo_callbackify,
  deprecate(fn) {
    return fn;
  },
  isDeepStrictEqual(a, b) {
    return __lumo_deep_equal(a, b, []);
  },
  parseArgs(config) {
    return __lumo_parse_args(config || {});
  },
  stripVTControlCharacters(value) {
    // eslint-disable-next-line no-control-regex
    return String(value).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
  },
  getSystemErrorName(errno) {
    const names = {
      2: 'ENOENT',
      5: 'EIO',
      13: 'EACCES',
      16: 'EBUSY',
      17: 'EEXIST',
      20: 'ENOTDIR',
      21: 'EISDIR',
      22: 'EINVAL',
      28: 'ENOSPC',
      39: 'ENOTEMPTY',
    };
    return names[Number(errno)] || 'UNKNOWN';
  },
  aborted(signal, resource) {
    if (!signal) return Promise.reject(new Error('Expected an AbortSignal'));
    return new Promise((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      void resource;
    });
  },
  debuglog() {
    return function debuglogDisabled() {};
  },
  inspect_custom_symbol: Symbol.for('nodejs.util.inspect.custom'),
  inherits(ctor, superCtor) {
    Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
    Object.setPrototypeOf(ctor, superCtor);
  },
  types: {
    isPromise: (value) => !!value && typeof value.then === 'function',
    isDate: (value) => value instanceof Date,
    isRegExp: (value) => value instanceof RegExp,
    isMap: (value) => value instanceof Map,
    isSet: (value) => value instanceof Set,
    isTypedArray: (value) => ArrayBuffer.isView(value),
    isUint8Array: (value) => value instanceof Uint8Array,
    isArrayBuffer: (value) => value instanceof ArrayBuffer,
    isNativeError: (value) => value instanceof Error,
    isAsyncFunction: (value) => typeof value === 'function' && value.constructor && value.constructor.name === 'AsyncFunction',
    isProxy: () => false,
  },
  TextEncoder,
  TextDecoder,
};
util.inspect.custom = Symbol.for('nodejs.util.inspect.custom');

class EventEmitter {
  constructor() {
    this._events = new Map();
  }
  on(name, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const list = this._events.get(name) || [];
    list.push(listener);
    this._events.set(name, list);
    return this;
  }
  addListener(name, listener) {
    return this.on(name, listener);
  }
  prependListener(name, listener) {
    const list = this._events.get(name) || [];
    list.unshift(listener);
    this._events.set(name, list);
    return this;
  }
  once(name, listener) {
    const self = this;
    function wrapped(...args) {
      self.off(name, wrapped);
      listener.apply(self, args);
    }
    wrapped.listener = listener;
    return this.on(name, wrapped);
  }
  prependOnceListener(name, listener) {
    return this.prependListener(name, listener);
  }
  off(name, listener) {
    const list = this._events.get(name);
    if (!list) return this;
    const next = list.filter((item) => item !== listener && item.listener !== listener);
    if (next.length === 0) this._events.delete(name);
    else this._events.set(name, next);
    return this;
  }
  removeListener(name, listener) {
    return this.off(name, listener);
  }
  removeAllListeners(name) {
    if (name === undefined) this._events.clear();
    else this._events.delete(name);
    return this;
  }
  emit(name, ...args) {
    const list = this._events.get(name);
    if (!list || list.length === 0) {
      // Node rethrows unhandled 'error' events; scripts rely on that to fail.
      if (name === 'error') {
        const error = args[0];
        throw error instanceof Error ? error : __lumo_make_error('Error', String(error));
      }
      return false;
    }
    for (const listener of list.slice()) listener.apply(this, args);
    return true;
  }
  listeners(name) {
    return (this._events.get(name) || []).map((listener) => listener.listener || listener);
  }
  rawListeners(name) {
    return (this._events.get(name) || []).slice();
  }
  listenerCount(name) {
    return (this._events.get(name) || []).length;
  }
  eventNames() {
    return Array.from(this._events.keys());
  }
  setMaxListeners() {
    return this;
  }
  getMaxListeners() {
    return 10;
  }
}
EventEmitter.once = function once(emitter, name) {
  return new Promise((resolve, reject) => {
    emitter.once(name, (...args) => resolve(args));
    if (name !== 'error') {
      emitter.once('error', reject);
    }
  });
};

/* -------------------------------------------------------------------------- */
/* Streams (minimal, enough for `spawn`-style collection)                     */
/* -------------------------------------------------------------------------- */

class __lumo_readable extends EventEmitter {
  constructor(options) {
    super();
    this._chunks = [];
    this._ended = false;
    this._encoding = null;
    this.readable = true;
    this.destroyed = false;
    const readable = options && options.readable;
    if (typeof readable === 'function') {
      readable.call(this, this);
    }
  }
  push(chunk) {
    if (chunk === null) {
      this._ended = true;
      this.readable = false;
      // Node emits these on a later tick, so `.end(); on('end', ...)` works.
      queueMicrotask(() => {
        this.emit('end');
        this.emit('close');
      });
      return false;
    }
    const data = this._encoding ? String(chunk) : Buffer.from(__lumo_to_bytes(chunk));
    this._chunks.push(data);
    this.emit('data', data);
    return true;
  }
  setEncoding(encoding) {
    this._encoding = encoding || 'utf8';
    return this;
  }
  pipe(destination) {
    this.on('data', (chunk) => destination.write(chunk));
    this.on('end', () => destination.end && destination.end());
    return destination;
  }
  resume() {
    return this;
  }
  pause() {
    return this;
  }
  destroy(error) {
    this.destroyed = true;
    this.readable = false;
    if (error) this.emit('error', error);
    this.emit('close');
    return this;
  }
  async *[Symbol.asyncIterator]() {
    for (const chunk of this._chunks) yield chunk;
  }
  toArray() {
    return this._chunks.slice();
  }
  static from(source) {
    const stream = new __lumo_readable();
    if (typeof source === 'string' || source instanceof Uint8Array) {
      queueMicrotask(() => {
        stream.push(source);
        stream.push(null);
      });
    } else if (Array.isArray(source)) {
      queueMicrotask(() => {
        for (const item of source) stream.push(item);
        stream.push(null);
      });
    } else if (source && typeof source[Symbol.asyncIterator] === 'function') {
      (async () => {
        for await (const item of source) stream.push(item);
        stream.push(null);
      })().catch((error) => stream.emit('error', error));
    } else if (source && typeof source[Symbol.iterator] === 'function') {
      queueMicrotask(() => {
        for (const item of source) stream.push(item);
        stream.push(null);
      });
    }
    return stream;
  }
}

class __lumo_writable extends EventEmitter {
  constructor(options) {
    super();
    this._chunks = [];
    this.writable = true;
    this.writableEnded = false;
    this.writableFinished = false;
    const write = options && options.write;
    if (typeof write === 'function') {
      this.on('_write', write);
    }
  }
  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') callback = encoding;
    this._chunks.push(chunk);
    this.emit('_write', chunk, encoding && typeof encoding === 'string' ? encoding : 'utf8');
    if (typeof callback === 'function') queueMicrotask(() => callback());
    return true;
  }
  end(chunk, encoding, callback) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
    }
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit('finish');
    this.emit('close');
    if (typeof callback === 'function') queueMicrotask(() => callback());
    return this;
  }
  toArray() {
    return this._chunks.slice();
  }
  toString() {
    return this._chunks.map((chunk) => (typeof chunk === 'string' ? chunk : Buffer.from(__lumo_to_bytes(chunk)).toString())).join('');
  }
}

class __lumo_passthrough extends __lumo_readable {
  constructor() {
    super();
    this.writable = true;
    this._pending = [];
  }
  write(chunk) {
    this.push(chunk);
    return true;
  }
  end() {
    this.push(null);
    return this;
  }
}

class __lumo_transform extends __lumo_passthrough {
  constructor(options) {
    super();
    if (options && typeof options.transform === 'function') {
      this._transform = options.transform;
    }
    if (options && typeof options.flush === 'function') {
      this._flush = options.flush;
    }
  }
  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') callback = encoding;
    const done = (error, data) => {
      if (error) {
        this.emit('error', error);
        if (typeof callback === 'function') callback(error);
        return;
      }
      if (data !== undefined && data !== null) this.push(data);
      if (typeof callback === 'function') callback();
    };
    if (typeof this._transform === 'function') this._transform(chunk, encoding || 'utf8', done);
    else this.push(chunk);
    return true;
  }
  end(chunk, encoding, callback) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
    }
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
    if (typeof this._flush === 'function') {
      this._flush((error, data) => {
        if (data !== undefined && data !== null) this.push(data);
        if (error) this.emit('error', error);
        this.push(null);
        if (typeof callback === 'function') callback();
      });
    } else {
      this.push(null);
      if (typeof callback === 'function') callback();
    }
    return this;
  }
}

class __lumo_duplex extends __lumo_readable {
  constructor(options) {
    super(options);
    this.writable = true;
    this._writeImpl = options && options.write;
  }
  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') callback = encoding;
    if (typeof this._writeImpl === 'function') {
      this._writeImpl(chunk, encoding || 'utf8', (error, data) => {
        if (data !== undefined && data !== null) this.push(data);
        if (typeof callback === 'function') callback(error);
      });
    }
    return true;
  }
  end(chunk, encoding, callback) {
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
    this.push(null);
    this.writable = false;
    if (typeof callback === 'function') queueMicrotask(() => callback());
    return this;
  }
}

/* -------------------------------------------------------------------------- */
/* VFS-backed fs                                                              */
/* -------------------------------------------------------------------------- */

function __lumo_encoding_of(options) {
  if (typeof options === 'string') return options;
  if (options && typeof options === 'object' && typeof options.encoding === 'string') {
    return options.encoding;
  }
  return undefined;
}

function __lumo_data_payload(data, encoding) {
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
    return { data: __lumo_b64_encode(__lumo_to_bytes(data)), encoding: 'base64' };
  }
  const enc = __lumo_normalize_encoding(encoding);
  if (enc === 'utf-8') return { data: String(data), encoding: 'utf8' };
  // hex / latin1 / utf-16le / base64 must be decoded to bytes before the write;
  // passing the label through would store the literal text.
  return { data: __lumo_b64_encode(__lumo_to_bytes(data, enc)), encoding: 'base64' };
}

function __lumo_fs_call(kind, payload) {
  return __lumo_call('fs.' + kind, JSON.stringify(Object.assign({ cwd: __lumo_current_cwd }, payload)));
}

function __lumo_make_stats(raw, path) {
  return {
    dev: 0,
    ino: 0,
    mode: raw.mode || 0,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    size: raw.size || 0,
    blksize: 512,
    blocks: 0,
    atime: new Date(raw.mtime || 0),
    mtime: new Date(raw.mtime || 0),
    ctime: new Date(raw.mtime || 0),
    birthtime: new Date(raw.mtime || 0),
    atimeMs: raw.mtime || 0,
    mtimeMs: raw.mtime || 0,
    ctimeMs: raw.mtime || 0,
    birthtimeMs: raw.mtime || 0,
    path: path,
    isFile: () => !!raw.isFile,
    isDirectory: () => !!raw.isDirectory,
    isSymbolicLink: () => !!raw.isSymbolicLink,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function __lumo_make_dirent(raw, parentPath) {
  return {
    name: raw.name,
    parentPath: parentPath,
    path: parentPath === '/' ? '/' + raw.name : parentPath + '/' + raw.name,
    isFile: () => !!raw.isFile,
    isDirectory: () => !!raw.isDirectory,
    isSymbolicLink: () => !!raw.isSymbolicLink,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

const __lumo_fs_raw = {
  async readFile(path, options) {
    const encoding = __lumo_encoding_of(options);
    if (encoding) {
      const normalized = __lumo_normalize_encoding(encoding);
      if (normalized === 'utf-8' || normalized === 'latin1' || normalized === 'hex') {
        return JSON.parse(
          await __lumo_fs_call('read', { path: String(path), encoding: normalized === 'hex' ? 'hex' : normalized === 'latin1' ? 'latin1' : 'utf8' }),
        );
      }
      const base64 = JSON.parse(await __lumo_fs_call('read', { path: String(path), encoding: 'base64' }));
      return Buffer.from(base64, 'base64').toString(normalized);
    }
    // Node returns a Buffer when no encoding is given.
    const base64 = JSON.parse(await __lumo_fs_call('read', { path: String(path), encoding: 'base64' }));
    return Buffer.from(base64, 'base64');
  },
  async writeFile(path, data, options) {
    const encoding = __lumo_encoding_of(options);
    const payload = __lumo_data_payload(data, encoding);
    await __lumo_fs_call('write', Object.assign({ path: String(path) }, payload));
  },
  async appendFile(path, data, options) {
    const encoding = __lumo_encoding_of(options);
    const payload = __lumo_data_payload(data, encoding);
    await __lumo_fs_call('append', Object.assign({ path: String(path) }, payload));
  },
  async readdir(path, options) {
    const withFileTypes = !!(options && options.withFileTypes);
    const recursive = !!(options && options.recursive);
    const encoding = __lumo_encoding_of(options);
    const raw = JSON.parse(
      await __lumo_fs_call('readdir', { path: String(path), withFileTypes }),
    );
    const decorate = (entries, parentPath) =>
      entries.map((entry) =>
        withFileTypes ? __lumo_make_dirent(entry, parentPath) : encoding === 'buffer' ? Buffer.from(entry) : entry,
      );
    if (!recursive) {
      return decorate(raw, String(path));
    }
    // Node's recursive readdir reports paths relative to the root argument.
    const out = [];
    const walk = async (current, prefix) => {
      const entries = JSON.parse(
        await __lumo_fs_call('readdir', { path: current, withFileTypes: true }),
      );
      for (const entry of entries) {
        const childPath = current === '/' ? '/' + entry.name : current + '/' + entry.name;
        const relative = prefix ? prefix + '/' + entry.name : entry.name;
        out.push(
          withFileTypes
            ? __lumo_make_dirent({ ...entry, name: relative }, prefix ? String(path) : String(path))
            : encoding === 'buffer'
              ? Buffer.from(relative)
              : relative,
        );
        if (entry.isDirectory) await walk(childPath, relative);
      }
    };
    await walk(String(path), '');
    return out;
  },
  async stat(path) {
    return __lumo_make_stats(JSON.parse(await __lumo_fs_call('stat', { path: String(path) })), String(path));
  },
  async lstat(path) {
    return __lumo_make_stats(JSON.parse(await __lumo_fs_call('stat', { path: String(path) })), String(path));
  },
  async exists(path) {
    return JSON.parse(await __lumo_fs_call('exists', { path: String(path) }));
  },
  async access(path, mode) {
    if (!(await __lumo_fs_raw.exists(path))) {
      throw __lumo_make_error(
        'Error',
        "ENOENT: no such file or directory, access '" + path + "'",
        'ENOENT',
      );
    }
    if (mode !== undefined && mode !== fs.constants.F_OK) {
      // The VFS does not model permissions; Node would report EACCES here.
      return undefined;
    }
    return undefined;
  },
  async mkdir(path, options) {
    const resolved = JSON.parse(
      await __lumo_fs_call('mkdir', {
        path: String(path),
        recursive: !!(options && options.recursive),
      }),
    );
    // Node returns the first directory created when recursive is set.
    return options && options.recursive ? resolved : undefined;
  },
  async rm(path, options) {
    await __lumo_fs_call('rm', {
      path: String(path),
      recursive: options && options.recursive === true,
      force: options && options.force === true,
    });
  },
  async rmdir(path, options) {
    await __lumo_fs_call('rm', {
      path: String(path),
      recursive: !!(options && options.recursive),
      force: false,
    });
  },
  async unlink(path) {
    await __lumo_fs_call('rm', { path: String(path), recursive: false, force: false });
  },
  async rename(from, to) {
    await __lumo_fs_call('rename', { from: String(from), to: String(to) });
  },
  async copyFile(from, to) {
    await __lumo_fs_call('copy', { from: String(from), to: String(to) });
  },
  async cp(from, to) {
    await __lumo_fs_call('copy', { from: String(from), to: String(to) });
  },
  async chmod(path, mode) {
    await __lumo_fs_call('chmod', { path: String(path), mode: Number(mode) });
  },
  async utimes(path, atime, mtime) {
    const time = mtime instanceof Date ? mtime.getTime() : Number(mtime);
    await __lumo_fs_call('utimes', { path: String(path), mtime: time });
  },
  async truncate(path, length) {
    const target = String(path);
    if (length && length > 0) throw new Error('truncate: only truncation to length 0 is supported');
    await __lumo_fs_call('write', { path: target, data: '', encoding: 'utf8' });
  },
  async realpath(path) {
    return JSON.parse(await __lumo_fs_call('realpath', { path: String(path) }));
  },
  async mkdtemp(prefix) {
    const directory = String(prefix || '/tmp/') + Math.random().toString(36).slice(2, 10);
    await __lumo_fs_raw.mkdir(directory, { recursive: true });
    return directory;
  },
};

const __lumo_fs_promise_names = [
  'readFile', 'writeFile', 'appendFile', 'readdir', 'stat', 'lstat', 'access', 'mkdir', 'rm',
  'rmdir', 'unlink', 'rename', 'copyFile', 'cp', 'chmod', 'utimes', 'truncate', 'realpath', 'mkdtemp',
];

const fs = {
  constants: {
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
    COPYFILE_EXCL: 1,
    COPYFILE_FICLONE: 2,
    COPYFILE_FICLONE_FORCE: 4,
  },
  promises: {},
};

for (const name of __lumo_fs_promise_names) {
  const raw = __lumo_fs_raw[name];
  fs.promises[name] = function (...args) {
    return __lumo_track(raw.apply(null, args));
  };
  fs[name] = function (...args) {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
    const promise = raw.apply(null, args);
    if (typeof callback !== 'function') return __lumo_track(promise);
    // A callback-style call is unawaited by design; keep the script alive until
    // it completes, just as Node does for pending filesystem work.
    __lumo_pending_begin();
    promise.then(
      (value) => {
        try {
          callback(null, value);
        } finally {
          __lumo_pending_end();
        }
      },
      (error) => {
        try {
          callback(error);
        } finally {
          __lumo_pending_end();
        }
      },
    );
    return undefined;
  };
}

// Node's deprecated `fs.exists` callback receives only the boolean.
fs.exists = function exists(path, callback) {
  const promise = __lumo_fs_raw.exists(path);
  if (typeof callback !== 'function') return __lumo_track(promise);
  __lumo_pending_begin();
  promise.then(
    (value) => {
      try {
        callback(value);
      } finally {
        __lumo_pending_end();
      }
    },
    () => {
      try {
        callback(false);
      } finally {
        __lumo_pending_end();
      }
    },
  );
  return undefined;
};
fs.promises.exists = function exists(...args) {
  return __lumo_track(__lumo_fs_raw.exists.apply(null, args));
};

fs.createReadStream = function createReadStream(path, options) {
  const stream = new __lumo_readable();
  const encoding = options && typeof options.encoding === 'string' ? options.encoding : null;
  if (encoding) stream.setEncoding(encoding);
  __lumo_pending_begin();
  __lumo_fs_raw
    .readFile(path, encoding ? { encoding } : undefined)
    .then(
      (data) => {
        try {
          if (typeof data === 'string') {
            stream.push(data);
          } else {
            const bytes = __lumo_to_bytes(data);
            const size = (options && options.highWaterMark) || 64 * 1024;
            for (let i = 0; i < bytes.length; i += size) stream.push(bytes.subarray(i, i + size));
          }
          stream.push(null);
        } finally {
          __lumo_pending_end();
        }
      },
      (error) => {
        try {
          stream.destroy(error);
        } finally {
          __lumo_pending_end();
        }
      },
    );
  return stream;
};

fs.createWriteStream = function createWriteStream(path, options) {
  const encoding = options && typeof options.encoding === 'string' ? options.encoding : undefined;
  const stream = new __lumo_writable();
  let chain = Promise.resolve();
  stream.on('_write', (chunk) => {
    chain = chain.then(() => __lumo_fs_raw.writeFile(path, chunk, encoding));
  });
  const originalEnd = stream.end.bind(stream);
  stream.end = function (chunk, enc, callback) {
    const result = originalEnd(chunk, enc, callback);
    chain = chain.then(
      () => undefined,
      (error) => {
        stream.emit('error', error);
      },
    );
    return result;
  };
  return stream;
};

fs.open = function open(path, flags, callback) {
  if (typeof flags === 'function') {
    callback = flags;
    flags = 'r';
  }
  const handle = {
    path: String(path),
    async readFile(...args) {
      return __lumo_fs_raw.readFile(path, args[0]);
    },
    async writeFile(data, options) {
      return __lumo_fs_raw.writeFile(path, data, options);
    },
    async appendFile(data, options) {
      return __lumo_fs_raw.appendFile(path, data, options);
    },
    async stat() {
      return __lumo_fs_raw.stat(path);
    },
    createReadStream() {
      return fs.createReadStream(path);
    },
    createWriteStream() {
      return fs.createWriteStream(path);
    },
    async close() {
      return undefined;
    },
    fd: 3,
  };
  if (typeof callback === 'function') {
    queueMicrotask(() => callback(null, handle));
    return undefined;
  }
  return __lumo_track(Promise.resolve(handle));
};
fs.promises.open = fs.open;

fs.opendir = function opendir(path, options, callback) {
  const target = String(path);
  const build = async () => {
    const entries = await __lumo_fs_raw.readdir(target, { withFileTypes: true });
    let index = 0;
    return {
      path: target,
      async read() {
        if (index >= entries.length) return null;
        return entries[index++] || null;
      },
      async close() {
        index = entries.length;
      },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const entry = await this.read();
          if (!entry) return;
          yield entry;
        }
      },
    };
  };
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  if (typeof callback === 'function') {
    build().then(
      (directory) => queueMicrotask(() => callback(null, directory)),
      (error) => queueMicrotask(() => callback(error)),
    );
    return undefined;
  }
  return __lumo_track(build());
};
fs.promises.opendir = (...args) => __lumo_track(fs.opendir(...args));

// Directory watching needs a real filesystem event source, which IndexedDB has
// none of. Fail with the reason instead of a `TypeError`.
fs.watch = function watch(path) {
  throw new Error(
    "fs.watch is not available in the QuickJS shell ('" +
      path +
      "' lives in IndexedDB, which has no change events); poll with fs.stat instead",
  );
};
fs.watchFile = fs.watch;
fs.unwatchFile = function unwatchFile() {};

for (const name of ['readv', 'writev', 'statfs', 'mkfifo']) {
  fs[name] = function unsupportedFs() {
    throw new Error('fs.' + name + ' is not available in the QuickJS shell');
  };
}

// The VFS is a flat path→content store, so links cannot be represented.
const __lumo_link_error = (operation, path) => {
  throw __lumo_make_error(
    'Error',
    'ENOSYS: ' + operation + " '" + path + "' is not supported by the extension filesystem (flat IndexedDB store); copy the file with fs.copyFile or `cp` instead",
    'ENOSYS',
  );
};
fs.symlink = async (target, linkPath) => __lumo_link_error('symlink', linkPath);
fs.link = async (existing, next) => __lumo_link_error('link', next);
fs.readlink = async (path) => __lumo_link_error('readlink', path);

// Synchronous filesystem calls cannot be bridged without blocking the host;
// fail with the async replacement instead of `undefined is not a function`.
const __lumo_fs_sync_names = __lumo_fs_promise_names.concat(['exists', 'open', 'readlink', 'link', 'symlink']);
for (const name of __lumo_fs_sync_names) {
  fs[name + 'Sync'] = function unavailableSyncFs() {
    throw new Error(
      'fs.' + name + 'Sync is not available in the QuickJS shell (the VFS is IndexedDB-backed); use `await fs.' + name + '(...)`' +
        (name === 'readFile' ? ", e.g. const text = await fs.readFile(path, 'utf8');" : '.'),
    );
  };
}

/* -------------------------------------------------------------------------- */
/* child_process (exec via the same shell interpreter)                        */
/* -------------------------------------------------------------------------- */

let __lumo_exec_seq = 0;

function __lumo_quote_arg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function __lumo_exec_error(child) {
  if (child.exitCode === 0 && !child.killed) return null;
  const error = new Error('Command failed: ' + child.command + '\n' + child.stderr);
  error.code = child.exitCode;
  error.cmd = child.command;
  error.killed = child.killed;
  error.signal = null;
  error.stdout = child.stdout.text;
  error.stderr = child.stderr.text;
  return error;
}

class ChildProcess extends EventEmitter {
  constructor(command) {
    super();
    this.command = command;
    this.pid = 0;
    this.exitCode = null;
    this.killed = false;
    this.signalCode = null;
    this._input = [];
    this._id = 'exec-' + (++__lumo_exec_seq) + '-' + Date.now();
    this.stdin = new __lumo_writable();
    this.stdin.on('_write', (chunk) => this._input.push(String(chunk)));
    this.stdin.on('finish', () => {
      this._inputReady = true;
    });
    this.stdout = this._makeOutput('stdout');
    this.stderr = this._makeOutput('stderr');
  }
  _makeOutput(name) {
    const stream = new __lumo_readable();
    stream.text = '';
    stream._name = name;
    stream.on('data', (chunk) => {
      stream.text += typeof chunk === 'string' ? chunk : Buffer.from(__lumo_to_bytes(chunk)).toString();
    });
    return stream;
  }
  kill(signal) {
    if (this.exitCode !== null) return false;
    this.killed = true;
    this.signal = signal || 'SIGTERM';
    __lumo_call('exec.kill', JSON.stringify({ id: this._id })).catch(() => {});
    return true;
  }
  _settle(result) {
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    this.exitCode = result.exitCode === undefined ? 0 : result.exitCode;
    // Emit after the fact: the shell interpreter hands back the finished
    // output, so these are the same bytes Node would have streamed.
    if (stdout.length > 0) this.stdout.push(Buffer.from(stdout));
    this.stdout.push(null);
    if (stderr.length > 0) this.stderr.push(Buffer.from(stderr));
    this.stderr.push(null);
    this.emit('exit', this.exitCode, null);
    this.emit('close', this.exitCode, null);
  }
}

function exec(command, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = options || {};
  if (
    options.shell &&
    options.shell !== true &&
    !/^(?:\/bin\/)?(?:ba)?sh$/.test(String(options.shell))
  ) {
    throw new Error('exec: only the built-in shell is available; omit options.shell');
  }
  const text = String(command);
  if (text.trim() === '') throw new Error('exec: command is required');
  const child = new ChildProcess(text);
  const env = Object.assign({}, process.env, options.env || {});
  const payload = {
    id: child._id,
    command: text,
    cwd: options.cwd === undefined
      ? __lumo_current_cwd
      : __lumo_path.resolve(__lumo_current_cwd, String(options.cwd)),
    env,
    timeoutMs: options.timeout,
    stdin: options.input !== undefined ? String(options.input) : undefined,
  };
  // Like Node, an unawaited `exec()` keeps the script alive until the child
  // settles; the callback form relies on this.
  __lumo_pending_begin();
  const promise = __lumo_call('exec', JSON.stringify(payload)).then(
    (raw) => {
      try {
        child._settle(JSON.parse(raw));
        if (typeof callback === 'function') {
          callback(__lumo_exec_error(child), child.stdout.text, child.stderr.text);
        }
        return { stdout: child.stdout.text, stderr: child.stderr.text, code: child.exitCode };
      } finally {
        __lumo_pending_end();
      }
    },
    (error) => {
      try {
        child._settle({ stdout: '', stderr: __lumo_error_text(error), exitCode: 1 });
        if (typeof callback === 'function') callback(__lumo_exec_error(child), '', child.stderr.text);
        return { stdout: '', stderr: child.stderr.text, code: 1 };
      } finally {
        __lumo_pending_end();
      }
    },
  );
  const tracked = __lumo_track(promise);
  child.then = (resolve, reject) => tracked.then(resolve, reject);
  child.catch = (reject) => tracked.catch(reject);
  child.finally = (done) => tracked.finally(done);
  return child;
}

async function execAsync(command, options) {
  const result = await exec(command, options);
  if (result.code !== 0) {
    const error = new Error('Command failed: ' + command + '\n' + result.stderr);
    error.code = result.code;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result;
}

function execFile(file, args, options, callback) {
  if (typeof args === 'function') {
    callback = args;
    args = [];
    options = {};
  } else if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const command = [file].concat(args || []).map(__lumo_quote_arg).join(' ');
  return exec(command, options || {}, callback);
}

function spawn(command, args, options) {
  if (args && !Array.isArray(args) && typeof args === 'object') {
    options = args;
    args = [];
  }
  return exec([command].concat(args || []).map(__lumo_quote_arg).join(' '), options || {});
}

function execSync() {
  throw new Error(
    'execSync is not available in the QuickJS shell (it would block the browser); use `await exec(...)` or exec(command, callback)',
  );
}

function spawnSync() {
  return execSync();
}

/* -------------------------------------------------------------------------- */
/* zlib / querystring / string_decoder / perf_hooks                           */
/* -------------------------------------------------------------------------- */

function __lumo_gzip_sync(input, options) {
  const bytes = __lumo_to_bytes(input);
  const level = options && typeof options.level === 'number' ? options.level : 6;
  return Buffer.from(
    __lumo_sync_json('zlib.gzip', { data: __lumo_b64_encode(bytes), level }),
    'base64',
  );
}

function __lumo_gunzip_sync(input) {
  const bytes = __lumo_to_bytes(input);
  return Buffer.from(__lumo_sync_json('zlib.gunzip', { data: __lumo_b64_encode(bytes) }), 'base64');
}

/** A through-stream that compresses everything on `end()`. */
function __lumo_make_compress_stream(_unused, transform) {
  const stream = new __lumo_passthrough();
  const chunks = [];
  stream.write = (chunk) => {
    chunks.push(__lumo_to_bytes(chunk));
    return true;
  };
  stream.end = (chunk) => {
    if (chunk) chunks.push(__lumo_to_bytes(chunk));
    stream.push(transform(__lumo_concat_bytes(chunks)));
    stream.push(null);
    return stream;
  };
  return stream;
}

function __lumo_unsupported_zlib(name) {
  return function unsupported() {
    throw new Error(
      'zlib.' + name + ' is not available in the QuickJS shell; use zlib.gzipSync/gunzipSync or the gzip/gunzip commands',
    );
  };
}

const zlib = {
  gzipSync: __lumo_gzip_sync,
  gunzipSync: __lumo_gunzip_sync,
  gzip(input, options, callback) {
    if (typeof options === 'function') callback = options;
    queueMicrotask(() => {
      try {
        callback(null, __lumo_gzip_sync(input, options));
      } catch (error) {
        callback(error);
      }
    });
  },
  gunzip(input, callback) {
    queueMicrotask(() => {
      try {
        callback(null, __lumo_gunzip_sync(input));
      } catch (error) {
        callback(error);
      }
    });
  },
  createGzip(options) {
    return __lumo_make_compress_stream(undefined, (bytes) => __lumo_gzip_sync(bytes, options));
  },
  createGunzip() {
    return __lumo_make_compress_stream(undefined, (bytes) => __lumo_gunzip_sync(bytes));
  },
  deflateSync(input, options) {
    return Buffer.from(
      __lumo_sync_json('zlib.deflate', {
        data: __lumo_b64_encode(__lumo_to_bytes(input)),
        level: options && typeof options.level === 'number' ? options.level : 6,
      }),
      'base64',
    );
  },
  inflateSync(input) {
    return Buffer.from(
      __lumo_sync_json('zlib.inflate', { data: __lumo_b64_encode(__lumo_to_bytes(input)) }),
      'base64',
    );
  },
  deflate(input, options, callback) {
    if (typeof options === 'function') callback = options;
    queueMicrotask(() => {
      try {
        callback(null, zlib.deflateSync(input, options));
      } catch (error) {
        callback(error);
      }
    });
  },
  inflate(input, callback) {
    queueMicrotask(() => {
      try {
        callback(null, zlib.inflateSync(input));
      } catch (error) {
        callback(error);
      }
    });
  },
  createDeflate(options) {
    return __lumo_make_compress_stream(() => zlib.deflateSync(__lumo_concat_bytes([]), options), (bytes) =>
      zlib.deflateSync(bytes, options),
    );
  },
  createInflate() {
    return __lumo_make_compress_stream(undefined, (bytes) => zlib.inflateSync(bytes));
  },
  brotliCompressSync: __lumo_unsupported_zlib('brotliCompressSync'),
  brotliDecompressSync: __lumo_unsupported_zlib('brotliDecompressSync'),
  constants: { Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1 },
};

const querystring = {
  escape: (value) => __lumo_form_encode(value),
  unescape: (value) => __lumo_form_decode(value),
  stringify(obj, separator, equals) {
    const sep = separator === undefined ? '&' : separator;
    const eq = equals === undefined ? '=' : equals;
    const parts = [];
    for (const key of Object.keys(obj || {})) {
      const value = obj[key];
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        parts.push(
          querystring.escape(key) +
            eq +
            querystring.escape(item === undefined || item === null ? '' : item),
        );
      }
    }
    return parts.join(sep);
  },
  parse(text, separator, equals) {
    const sep = separator === undefined ? '&' : separator;
    const eq = equals === undefined ? '=' : equals;
    const out = {};
    const source = String(text || '');
    if (source === '') return out;
    for (const part of source.split(sep)) {
      if (part === '') continue;
      const index = part.indexOf(eq);
      const key = querystring.unescape(index === -1 ? part : part.slice(0, index));
      const value = querystring.unescape(index === -1 ? '' : part.slice(index + eq.length));
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        const existing = out[key];
        if (Array.isArray(existing)) existing.push(value);
        else out[key] = [existing, value];
      } else {
        out[key] = value;
      }
    }
    return out;
  },
};

class StringDecoder {
  constructor(encoding) {
    this.encoding = __lumo_normalize_encoding(encoding);
    this._buffered = new Uint8Array(0);
  }
  write(buffer) {
    const bytes = __lumo_to_bytes(buffer);
    if (this.encoding !== 'utf-8') {
      return Buffer.from(bytes).toString(this.encoding);
    }
    const combined = __lumo_concat_bytes([this._buffered, bytes]);
    // Hold back an incomplete trailing UTF-8 sequence.
    let cut = combined.length;
    for (let i = 1; i <= 3 && i <= combined.length; i += 1) {
      const byte = combined[combined.length - i];
      if ((byte & 0xc0) === 0x80) continue;
      const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      if (needed > i) cut = combined.length - i;
      break;
    }
    this._buffered = combined.slice(cut);
    return Buffer.from(combined.subarray(0, cut)).toString('utf8');
  }
  end(buffer) {
    const tail = buffer ? this.write(buffer) : '';
    const rest = this._buffered;
    this._buffered = new Uint8Array(0);
    return tail + Buffer.from(rest).toString('utf8');
  }
}

function __lumo_make_readline() {
  function createInterface(input, output, _terminal) {
    const stream = input && input.input ? input.input : input;
    const terminal = input && input.terminal !== undefined ? !!input.terminal : false;
    const outputStream = output || (input && input.output);
    const emitter = new EventEmitter();
    emitter.terminal = terminal;
    emitter.line = '';
    let buffer = '';
    let closed = false;
    const lines = [];
    let resolver = null;

    const flush = () => {
      if (emitter.listenerCount('line') === 0) return;
      while (lines.length > 0) emitter.emit('line', lines.shift());
    };

    const onData = (chunk) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(__lumo_to_bytes(chunk)).toString('utf8');
      buffer += text;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        let line = buffer.slice(0, index);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        lines.push(line);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
      flush();
      if (resolver) {
        const next = lines.shift();
        if (next !== undefined) {
          const resolve = resolver;
          resolver = null;
          resolve({ value: next, done: false });
        }
      }
    };

    const finish = () => {
      if (buffer.length > 0) {
        lines.push(buffer);
        buffer = '';
        flush();
      }
      if (closed) return;
      closed = true;
      if (resolver) {
        const next = lines.shift();
        const resolve = resolver;
        resolver = null;
        resolve(next === undefined ? { value: undefined, done: true } : { value: next, done: false });
      }
      emitter.emit('close');
    };

    if (stream && typeof stream.on === 'function') {
      stream.on('data', onData);
      stream.on('end', finish);
      stream.on('close', finish);
    } else {
      queueMicrotask(finish);
    }

    emitter.close = () => {
      finish();
      if (terminal && outputStream && typeof outputStream.write === 'function') outputStream.write('');
      return emitter;
    };
    emitter[Symbol.asyncIterator] = () => {
      return {
        next() {
          if (lines.length > 0) return Promise.resolve({ value: lines.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            resolver = resolve;
          });
        },
        return() {
          emitter.close();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    };
    return emitter;
  }
  return { createInterface, Interface: EventEmitter, clearLine() {}, cursorTo() {}, moveCursor() {} };
}

const readline = __lumo_make_readline();
const readlinePromises = {
  createInterface(input, output, terminal) {
    const emitter = readline.createInterface(input, output, terminal);
    emitter.question = (query) => {
      if (input && input.output && typeof input.output.write === 'function') input.output.write(query);
      const iterator = emitter[Symbol.asyncIterator]();
      return iterator.next().then((result) => (result.done ? '' : result.value));
    };
    return emitter;
  },
};

const perf_hooks = {
  performance,
  PerformanceObserver: class PerformanceObserver {
    observe() {}
    disconnect() {}
  },
  performanceNow: () => performance.now(),
};

/* -------------------------------------------------------------------------- */
/* Headers / Request / Response / fetch                                       */
/* -------------------------------------------------------------------------- */

class Headers {
  constructor(init) {
    this._list = [];
    if (!init) return;
    if (Array.isArray(init)) {
      for (const pair of init) this.append(pair[0], pair[1]);
      return;
    }
    if (typeof init.forEach === 'function' && !(init instanceof Headers)) {
      init.forEach((value, key) => this.append(key, value));
      return;
    }
    if (init instanceof Headers) {
      for (const pair of init._list) this._list.push([pair[0], pair[1]]);
      return;
    }
    for (const key of Object.keys(init)) this.append(key, init[key]);
  }
  append(name, value) {
    this._list.push([String(name).toLowerCase(), String(value)]);
  }
  delete(name) {
    const key = String(name).toLowerCase();
    this._list = this._list.filter((pair) => pair[0] !== key);
  }
  get(name) {
    const key = String(name).toLowerCase();
    const values = this._list.filter((pair) => pair[0] === key).map((pair) => pair[1]);
    if (values.length === 0) return null;
    if (key === 'set-cookie') return values[0];
    return values.join(', ');
  }
  getSetCookie() {
    return this._list.filter((pair) => pair[0] === 'set-cookie').map((pair) => pair[1]);
  }
  has(name) {
    return this._list.some((pair) => pair[0] === String(name).toLowerCase());
  }
  set(name, value) {
    const key = String(name).toLowerCase();
    const index = this._list.findIndex((pair) => pair[0] === key);
    if (index === -1) this._list.push([key, String(value)]);
    else this._list[index] = [key, String(value)];
  }
  forEach(callback, thisArg) {
    for (const [key, value] of this._list) callback.call(thisArg, value, key, this);
  }
  entries() {
    return this._list.map((pair) => [pair[0], pair[1]])[Symbol.iterator]();
  }
  keys() {
    return this._list.map((pair) => pair[0])[Symbol.iterator]();
  }
  values() {
    return this._list.map((pair) => pair[1])[Symbol.iterator]();
  }
  [Symbol.iterator]() {
    return this.entries();
  }
}

class __lumo_byte_stream {
  constructor(bytes) {
    this._bytes = bytes;
  }
  getReader() {
    let offset = 0;
    const bytes = this._bytes;
    return {
      async read() {
        if (offset >= bytes.length) return { done: true, value: undefined };
        const size = Math.min(64 * 1024, bytes.length - offset);
        const value = bytes.slice(offset, offset + size);
        offset += size;
        return { done: false, value };
      },
      releaseLock() {},
      cancel() {
        offset = bytes.length;
      },
    };
  }
  async *[Symbol.asyncIterator]() {
    const reader = this.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  }
}

class Blob {
  constructor(parts, options) {
    const chunks = (parts || []).map((part) =>
      typeof part === 'string' ? __lumo_utf8_encode(part) : __lumo_to_bytes(part),
    );
    this._bytes = __lumo_concat_bytes(chunks);
    this.type = (options && options.type) || '';
    this.size = this._bytes.length;
  }
  async text() {
    return Buffer.from(this._bytes).toString('utf8');
  }
  async arrayBuffer() {
    return this._bytes.slice().buffer;
  }
  bytes() {
    return this._bytes.slice();
  }
  slice(start, end) {
    return new Blob([this._bytes.slice(start, end)], { type: this.type });
  }
}

class FormData {
  constructor() {
    this._entries = [];
  }
  append(name, value) {
    this._entries.push([String(name), value]);
  }
  set(name, value) {
    this.delete(name);
    this.append(name, value);
  }
  get(name) {
    const found = this._entries.find((entry) => entry[0] === String(name));
    return found ? found[1] : null;
  }
  getAll(name) {
    return this._entries.filter((entry) => entry[0] === String(name)).map((entry) => entry[1]);
  }
  has(name) {
    return this._entries.some((entry) => entry[0] === String(name));
  }
  delete(name) {
    this._entries = this._entries.filter((entry) => entry[0] !== String(name));
  }
  entries() {
    return this._entries.map((entry) => [entry[0], entry[1]])[Symbol.iterator]();
  }
  [Symbol.iterator]() {
    return this.entries();
  }
}

class Request {
  constructor(input, init) {
    init = init || {};
    this.url = typeof input === 'string' ? input : String(input);
    this.method = String(init.method || 'GET').toUpperCase();
    this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
    this.body = init.body;
    this.signal = init.signal || null;
    this.redirect = init.redirect || 'follow';
    this.credentials = init.credentials || 'same-origin';
    this.bodyUsed = false;
    if (typeof this.body === 'string') this._text = this.body;
    else if (this.body !== undefined && this.body !== null) this._text = Buffer.from(__lumo_to_bytes(this.body)).toString('utf8');
    else this._text = '';
  }
  async text() {
    this.bodyUsed = true;
    return this._text;
  }
  async json() {
    this.bodyUsed = true;
    return JSON.parse(this._text);
  }
  clone() {
    return new Request(this.url, {
      method: this.method,
      headers: this.headers,
      body: this.body,
      signal: this.signal,
      redirect: this.redirect,
      credentials: this.credentials,
    });
  }
}

/**
 * A `response.body` that loads its bytes on first read.
 *
 * It holds the owning Response directly (a plain data cycle, which the GC
 * collects) instead of a getter closure — a per-response closure that closes
 * over `this` survives into `JS_FreeRuntime` often enough to trip QuickJS's
 * leaked-object assertion.
 */
class __lumo_lazy_byte_stream {
  constructor(owner) {
    this._owner = owner;
    this._bytes = null;
  }
  async _ensure() {
    if (!this._bytes) this._bytes = await this._owner._load();
    return this._bytes;
  }
  getReader() {
    const self = this;
    let offset = 0;
    return {
      async read() {
        const bytes = await self._ensure();
        if (offset >= bytes.length) return { done: true, value: undefined };
        const size = Math.min(64 * 1024, bytes.length - offset);
        const value = bytes.slice(offset, offset + size);
        offset += size;
        return { done: false, value: value };
      },
      releaseLock() {},
      async cancel() {
        offset = Number.MAX_SAFE_INTEGER;
      },
    };
  }
  async *[Symbol.asyncIterator]() {
    const reader = this.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  }
}

class Response {
  constructor(body, init) {
    init = init || {};
    const isNode = body && typeof body === 'object' && 'status' in body && 'headers' in body;
    if (isNode) {
      // Internal: built from the host bridge payload.
      this._raw = body;
      this.ok = !!body.ok;
      this.status = body.status;
      this.statusText = body.statusText || '';
      this.url = body.url || '';
      this.redirected = !!body.redirected;
      this.type = body.type || 'basic';
      this.headers = new Headers(body.headers);
      this._bodyPath = body.bodyPath || null;
      this._bytes = body.base64 === undefined ? null : __lumo_b64_decode(body.base64);
      this._text = body.text === undefined || body.text === null ? null : body.text;
      this.truncated = !!body.truncated;
      this.size = body.size === undefined ? (this._bytes ? this._bytes.length : 0) : body.size;
    } else {
      this._bytes =
        body === undefined || body === null
          ? new Uint8Array(0)
          : typeof body === 'string'
            ? __lumo_utf8_encode(body)
            : __lumo_to_bytes(body);
      this._text = Buffer.from(this._bytes).toString('utf8');
      this.ok = init.status === undefined || (init.status >= 200 && init.status < 300);
      this.status = init.status === undefined ? 200 : init.status;
      this.statusText = init.statusText || '';
      this.url = '';
      this.redirected = false;
      this.type = 'default';
      this.headers = new Headers(init.headers);
      this.truncated = false;
      this.size = this._bytes.length;
    }
    this.bodyUsed = false;
    // `body` stays lazy (a spilled body has not been read yet), but it is a
    // plain field so no per-instance getter closure is created.
    this.body = new __lumo_lazy_byte_stream(this);
  }
  async _load() {
    if (this._bytes) return this._bytes;
    if (this._bodyPath) {
      this._bytes = await fs.readFile(this._bodyPath);
      return this._bytes;
    }
    this._bytes = new Uint8Array(0);
    return this._bytes;
  }
  async text() {
    this.bodyUsed = true;
    if (this._text !== null) return this._text;
    this._text = Buffer.from(await this._load()).toString('utf8');
    return this._text;
  }
  async json() {
    return JSON.parse(await this.text());
  }
  async arrayBuffer() {
    this.bodyUsed = true;
    return (await this._load()).slice().buffer;
  }
  async bytes() {
    this.bodyUsed = true;
    return (await this._load()).slice();
  }
  async blob() {
    this.bodyUsed = true;
    return new Blob([await this._load()], { type: this.headers.get('content-type') || '' });
  }
  async formData() {
    throw new Error(
      'response.formData() is not available in the QuickJS shell; parse the body yourself (response.text() + the boundary in content-type)',
    );
  }
  clone() {
    if (this._raw) return new Response(this._raw);
    return new Response(this._bytes, { headers: this.headers, status: this.status });
  }
}

async function __lumo_fetch(input, init) {
  init = init || {};
  const url = typeof input === 'string' ? input : input && input.url ? String(input.url) : String(input);
  const signal = init.signal || (input && input.signal) || null;
  if (signal && signal.aborted) throw __lumo_abort_error();
  const abortId = signal ? 'fetch-' + (++__lumo_exec_seq) + '-' + Date.now() : undefined;
  let onAbort;
  if (signal && abortId) {
    onAbort = () => {
      __lumo_call('fetch.abort', JSON.stringify({ id: abortId })).catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const body = init.body;
  const payload = {
    url,
    method: init.method,
    headers: init.headers instanceof Headers ? Array.from(init.headers.entries()) : init.headers,
    timeoutMs: init.timeout,
    abortId,
  };
  if (body !== undefined && body !== null) {
    if (typeof body === 'string') {
      payload.body = body;
    } else if (body instanceof URLSearchParams) {
      payload.body = body.toString();
      payload.headers = payload.headers || [['content-type', 'application/x-www-form-urlencoded;charset=UTF-8']];
    } else if (body instanceof FormData) {
      throw new Error(
        'fetch: FormData bodies are not supported in the QuickJS shell; build the encoded body yourself',
      );
    } else if (body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof Buffer) {
      payload.body = __lumo_b64_encode(__lumo_to_bytes(body));
      payload.bodyEncoding = 'base64';
    } else {
      payload.body = String(body);
    }
  }
  if (init.redirect !== undefined) payload.redirect = init.redirect;
  if (init.credentials !== undefined) payload.credentials = init.credentials;
  if (init.cache !== undefined) payload.cache = init.cache;
  if (init.mode !== undefined) payload.mode = init.mode;
  if (init.keepalive !== undefined) payload.keepalive = init.keepalive;
  try {
    const raw = await __lumo_call('fetch', JSON.stringify(payload));
    return new Response(JSON.parse(raw));
  } catch (error) {
    if (signal && signal.aborted) throw __lumo_abort_error();
    throw error;
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

const fetch = __lumo_pub(__lumo_fetch);

/* -------------------------------------------------------------------------- */
/* crypto                                                                     */
/* -------------------------------------------------------------------------- */

function __lumo_crypto_bytes(length) {
  return Buffer.from(__lumo_sync_json('crypto.randomBytes', { length: length }), 'base64');
}

const crypto = {
  randomUUID() {
    return __lumo_sync_json('crypto.randomUUID', {});
  },
  randomBytes(size, callback) {
    const length = size === undefined ? 16 : Number(size);
    if (typeof callback === 'function') {
      queueMicrotask(() => {
        try {
          callback(null, __lumo_crypto_bytes(length));
        } catch (error) {
          callback(error);
        }
      });
      return undefined;
    }
    return __lumo_crypto_bytes(length);
  },
  randomInt(min, max, callback) {
    let low = 0;
    let high = Number(max);
    if (max === undefined || typeof max === 'function') {
      callback = max;
      high = Number(min);
    } else {
      low = Number(min);
    }
    const value = __lumo_sync_json('crypto.randomInt', { min: low, max: high });
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(null, value));
      return undefined;
    }
    return value;
  },
  randomFillSync(array) {
    crypto.getRandomValues(array);
    return array;
  },
  getRandomValues(array) {
    const bytes = __lumo_crypto_bytes(array.byteLength);
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
    return array;
  },
  createHash(algorithm) {
    return __lumo_hash_object(algorithm);
  },
  createHmac(algorithm, key, options) {
    return __lumo_hmac_object(algorithm, key, options && options.encoding);
  },
  timingSafeEqual(a, b) {
    const left = __lumo_to_bytes(a);
    const right = __lumo_to_bytes(b);
    if (left.length !== right.length) {
      throw new RangeError('Input buffers must have the same byte length');
    }
    let diff = 0;
    for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
    return diff === 0;
  },

  randomFill(buffer, offset, size, callback) {
    if (typeof offset === 'function') {
      callback = offset;
      offset = 0;
      size = buffer.length - offset;
    } else if (typeof size === 'function') {
      callback = size;
      size = buffer.length - (offset || 0);
    }
    const start = offset === undefined ? 0 : Number(offset);
    const length = size === undefined ? buffer.length - start : Number(size);
    const fill = () => {
      const bytes = __lumo_crypto_bytes(length);
      new Uint8Array(buffer.buffer, buffer.byteOffset + start, length).set(bytes);
      return buffer;
    };
    if (typeof callback === 'function') {
      queueMicrotask(() => {
        try {
          callback(null, fill());
        } catch (error) {
          callback(error);
        }
      });
      return undefined;
    }
    return fill();
  },
  randomFillSync(buffer, offset, size) {
    return crypto.randomFill(buffer, offset, size);
  },
  pbkdf2Sync(password, salt, iterations, keylen, digest) {
    return Buffer.from(
      __lumo_pbkdf2(digest || 'sha1', __lumo_to_bytes(password), __lumo_to_bytes(salt), Number(iterations), Number(keylen)),
    );
  },
  pbkdf2(password, salt, iterations, keylen, digest, callback) {
    if (typeof digest === 'function') {
      callback = digest;
      digest = undefined;
    }
    queueMicrotask(() => {
      try {
        callback(null, crypto.pbkdf2Sync(password, salt, iterations, keylen, digest));
      } catch (error) {
        callback(error);
      }
    });
  },
  hkdfSync(digest, ikm, salt, info, keylen) {
    return __lumo_hkdf(
      digest || 'sha256',
      __lumo_to_bytes(ikm),
      __lumo_to_bytes(salt || new Uint8Array(0)),
      __lumo_to_bytes(info || new Uint8Array(0)),
      Number(keylen),
    ).buffer;
  },
  hkdf(digest, ikm, salt, info, keylen, callback) {
    queueMicrotask(() => {
      try {
        callback(null, crypto.hkdfSync(digest, ikm, salt, info, keylen));
      } catch (error) {
        callback(error);
      }
    });
  },
  createCipheriv() {
    throw new Error(
      'crypto.createCipheriv is not available in the QuickJS shell; use crypto.webcrypto.subtle (or the shell `openssl`-free path: fetch/curl) instead',
    );
  },
  createDecipheriv() {
    throw new Error('crypto.createDecipheriv is not available in the QuickJS shell; use crypto.webcrypto.subtle');
  },
  createSign() {
    throw new Error('crypto.createSign is not available in the QuickJS shell; use crypto.webcrypto.subtle');
  },
  createVerify() {
    throw new Error('crypto.createVerify is not available in the QuickJS shell; use crypto.webcrypto.subtle');
  },
  generateKeyPairSync() {
    throw new Error('crypto.generateKeyPairSync is not available in the QuickJS shell; use crypto.webcrypto.subtle.generateKey');
  },
  getHashes() {
    return Object.keys(__lumo_hash_specs);
  },
  getCiphers() {
    return [];
  },
};

crypto.webcrypto = {
  getRandomValues: crypto.getRandomValues,
  randomUUID: crypto.randomUUID,
  subtle: {
    async digest(algorithm, data) {
      const name = typeof algorithm === 'string' ? algorithm : algorithm && algorithm.name;
      const spec = __lumo_hash_spec(name);
      const out = spec.fn(__lumo_to_bytes(data));
      return out.slice().buffer;
    },
    async importKey(format, keyData, algorithm) {
      return {
        type: 'secret',
        format,
        algorithm,
        _key: __lumo_to_bytes(keyData),
      };
    },
    async sign(algorithm, key, data) {
      const name = (algorithm && algorithm.name) || algorithm;
      const out = __lumo_hmac(
        __lumo_hash_spec(name).fn,
        __lumo_hash_spec(name).blockSize,
        key._key || __lumo_to_bytes(key),
        __lumo_to_bytes(data),
      );
      return out.slice().buffer;
    },
    async verify(algorithm, key, signature, data) {
      const expected = await crypto.webcrypto.subtle.sign(algorithm, key, data);
      const a = new Uint8Array(expected);
      const b = __lumo_to_bytes(signature);
      return crypto.timingSafeEqual(a, b);
    },
  },
};

/* -------------------------------------------------------------------------- */
/* tools / mcp                                                                */
/* -------------------------------------------------------------------------- */

function __lumo_server(id) {
  return __lumo_servers.find((server) => server.id === id) || null;
}

function __lumo_tool_names(serverId) {
  const server = __lumo_server(serverId);
  return server ? server.tools.slice() : [];
}

function __lumo_server_proxy(serverId) {
  return new Proxy({}, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined;
      return function tool(params) {
        return __lumo_track(
          __lumo_call('tool', JSON.stringify({ server: serverId, tool: property, params })).then((raw) =>
            JSON.parse(raw),
          ),
        );
      };
    },
    has(_target, property) {
      return typeof property === 'string' && __lumo_tool_names(serverId).indexOf(property) !== -1;
    },
    ownKeys() {
      return __lumo_tool_names(serverId);
    },
    getOwnPropertyDescriptor() {
      return { enumerable: true, configurable: true };
    },
  });
}

const tools = new Proxy({}, {
  get(_target, property) {
    if (typeof property !== 'string') return undefined;
    return __lumo_server(property) ? __lumo_server_proxy(property) : undefined;
  },
  has(_target, property) {
    return typeof property === 'string' && __lumo_server(property) !== null;
  },
  ownKeys() {
    return __lumo_servers.map((server) => server.id);
  },
  getOwnPropertyDescriptor() {
    return { enumerable: true, configurable: true };
  },
});

function __lumo_make_mcp() {
  return {
    servers() {
      return __lumo_servers.slice();
    },
    async list() {
      return __lumo_servers.slice();
    },
    async tools(server) {
      const found = __lumo_server(String(server));
      if (!found) throw new Error('Unknown server "' + server + '"');
      return found.tools.slice();
    },
    async describe(server, tool) {
      return JSON.parse(
        await __lumo_call('mcp.describe', JSON.stringify({ server: String(server), tool: String(tool) })),
      );
    },
    call(server, tool, params) {
      return __lumo_track(
        __lumo_call('tool', JSON.stringify({ server: String(server), tool: String(tool), params })).then(
          (raw) => JSON.parse(raw),
        ),
      );
    },
  };
}

const mcp = __lumo_make_mcp();

const sleep = __lumo_pub(function sleep(ms) {
  return __lumo_call('sleep', JSON.stringify({ ms: Math.max(0, Number(ms) || 0) }));
});

/* -------------------------------------------------------------------------- */
/* assert                                                                     */
/* -------------------------------------------------------------------------- */

class AssertionError extends Error {
  constructor(options) {
    const details = options && options.message ? options.message : 'Assertion failed';
    super(details);
    this.name = 'AssertionError';
    this.code = 'ERR_ASSERTION';
    this.actual = options && options.actual;
    this.expected = options && options.expected;
    this.operator = options && options.operator;
    this.generatedMessage = false;
  }
}

function __lumo_assert(condition, message) {
  if (!condition) throw new AssertionError({ message: message || 'Assertion failed', actual: condition, expected: true, operator: '==' });
}
__lumo_assert.ok = __lumo_assert;
__lumo_assert.AssertionError = AssertionError;
__lumo_assert.equal = (actual, expected, message) => {
  if (actual != expected) { // eslint-disable-line eqeqeq
    throw new AssertionError({
      message: message || 'Expected values to be loosely equal',
      actual,
      expected,
      operator: '==',
    });
  }
};
__lumo_assert.notEqual = (actual, expected, message) => {
  if (actual == expected) { // eslint-disable-line eqeqeq
    throw new AssertionError({ message: message || 'Expected values to be loosely unequal', actual, expected, operator: '!=' });
  }
};
__lumo_assert.strictEqual = (actual, expected, message) => {
  if (!Object.is(actual, expected)) {
    throw new AssertionError({
      message: message || 'Expected values to be strictly equal',
      actual,
      expected,
      operator: 'strictEqual',
    });
  }
};
__lumo_assert.notStrictEqual = (actual, expected, message) => {
  if (Object.is(actual, expected)) {
    throw new AssertionError({ message: message || 'Expected values to be strictly unequal', actual, expected, operator: 'notStrictEqual' });
  }
};
__lumo_assert.deepStrictEqual = (actual, expected, message) => {
  if (!__lumo_deep_equal(actual, expected, [])) {
    throw new AssertionError({
      message: message || 'Expected values to be deeply equal',
      actual,
      expected,
      operator: 'deepStrictEqual',
    });
  }
};
__lumo_assert.notDeepStrictEqual = (actual, expected, message) => {
  if (__lumo_deep_equal(actual, expected, [])) {
    throw new AssertionError({ message: message || 'Expected values to be deeply unequal', actual, expected, operator: 'notDeepStrictEqual' });
  }
};
__lumo_assert.fail = (message) => {
  throw new AssertionError({ message: message || 'Failed', operator: 'fail' });
};
__lumo_assert.throws = (fn, expected, message) => {
  let error;
  let threw = false;
  try {
    fn();
  } catch (caught) {
    threw = true;
    error = caught;
  }
  if (!threw) throw new AssertionError({ message: (typeof expected === 'string' && expected) || message || 'Missing expected exception' });
  const matcher =
    typeof expected === 'function'
      ? expected
      : expected instanceof RegExp
        ? (value) => expected.test(value && value.message ? value.message : String(value))
        : expected && expected.name
          ? (value) => value && value.name === expected.name
          : null;
  if (matcher && typeof matcher === 'function' && matcher.prototype && /Error/.test(matcher.name)) {
    if (!(error instanceof matcher)) {
      throw new AssertionError({
        message: message || 'Expected function to throw ' + matcher.name,
        actual: error,
      });
    }
  } else if (typeof expected === 'function' && !/Error/.test(expected.name)) {
    if (!expected(error)) {
      throw new AssertionError({ message: message || 'Expected function to throw a matching error', actual: error });
    }
  } else if (expected instanceof RegExp && !expected.test(error && error.message ? error.message : String(error))) {
    throw new AssertionError({ message: message || 'Expected function to throw matching exception', actual: error });
  } else if (typeof expected === 'string' && message === undefined && !String(error && error.message).includes(expected)) {
    throw new AssertionError({ message: expected, actual: error });
  }
};
__lumo_assert.doesNotThrow = (fn, message) => {
  try {
    fn();
  } catch (error) {
    throw new AssertionError({ message: (typeof message === 'string' && message) || 'Got unwanted exception', actual: error });
  }
};
__lumo_assert.rejects = async (asyncFn, expected, message) => {
  const fn = typeof asyncFn === 'function' ? asyncFn : () => Promise.reject(asyncFn);
  let error;
  let rejected = false;
  try {
    await fn();
  } catch (caught) {
    rejected = true;
    error = caught;
  }
  if (!rejected) {
    throw new AssertionError({ message: (typeof expected === 'string' && expected) || message || 'Missing expected rejection' });
  }
  if (expected instanceof RegExp && !expected.test(error && error.message)) {
    throw new AssertionError({ message: message || 'Expected rejection to match' + ' ' + expected, actual: error });
  }
  if (expected && expected.name && /Error/.test(expected.name) && !(error instanceof expected)) {
    throw new AssertionError({ message: message || 'Expected rejection of type ' + expected.name, actual: error });
  }
  return error;
};
__lumo_assert.doesNotReject = async (asyncFn, message) => {
  try {
    await (typeof asyncFn === 'function' ? asyncFn() : asyncFn);
  } catch (error) {
    throw new AssertionError({ message: (typeof message === 'string' && message) || 'Got unwanted rejection', actual: error });
  }
};
__lumo_assert.match = (value, regexp, message) => {
  if (!regexp.test(String(value))) {
    throw new AssertionError({ message: message || 'The input did not match the regular expression', actual: value, expected: regexp, operator: 'match' });
  }
};
__lumo_assert.ifError = (value) => {
  if (value !== null && value !== undefined) {
    throw value instanceof Error ? value : new AssertionError({ message: 'ifError got unwanted exception: ' + String(value), actual: value });
  }
};
__lumo_assert.strict = __lumo_assert;

/* -------------------------------------------------------------------------- */
/* Modules: builtins, VFS `require`, ESM interop                              */
/* -------------------------------------------------------------------------- */

const __lumo_builtin_names = [
  'path', 'os', 'util', 'events', 'fs', 'fs/promises', 'crypto', 'buffer', 'child_process',
  'url', 'timers', 'timers/promises', 'process', 'console', 'assert', 'assert/strict', 'zlib',
  'stream', 'querystring', 'string_decoder', 'perf_hooks', 'constants', 'readline',
  'readline/promises', 'module',
];

const __lumo_module_map = Object.create(null);
for (const entry of __lumo_config.modules || []) __lumo_module_map[entry.path] = entry.source;
const __lumo_module_cache = Object.create(null);

function __lumo_builtin(id) {
  switch (id) {
    case 'path':
      return __lumo_path;
    case 'os':
      return os;
    case 'util':
      return util;
    case 'events':
      return { EventEmitter, once: EventEmitter.once };
    case 'fs':
      return fs;
    case 'fs/promises':
      return fs.promises;
    case 'crypto':
      return crypto;
    case 'buffer':
      return { Buffer, atob, btoa, Blob, File: Blob };
    case 'child_process':
      return { exec, execAsync, execFile, spawn, execSync, spawnSync, ChildProcess };
    case 'url':
      return {
        URL,
        URLSearchParams,
        pathToFileURL,
        fileURLToPath,
        urlToHttpOptions,
        parse: urlParse,
        format: urlFormat,
        resolve: urlResolve,
      };
    case 'timers':
      return { setTimeout, setInterval, clearTimeout, clearInterval, setImmediate, clearImmediate };
    case 'timers/promises':
      return {
        setTimeout(ms, value) {
          return __lumo_track(
            new Promise((resolve) => setTimeout(() => resolve(value), ms)),
          );
        },
        setImmediate(value) {
          return __lumo_track(new Promise((resolve) => setTimeout(() => resolve(value), 0)));
        },
      };
    case 'process':
      return process;
    case 'console':
      return console;
    case 'assert':
    case 'assert/strict':
      return __lumo_assert;
    case 'zlib':
      return zlib;
    case 'readline':
      return readline;
    case 'readline/promises':
      return readlinePromises;
    case 'module':
      return {
        createRequire(base) {
          const dir = base && String(base).startsWith('file://')
            ? fileURLToPath(String(base)).replace(/\/[^/]*$/, '') || '/'
            : __lumo_script_dir;
          return (spec) => __lumo_require_from(spec, dir, base);
        },
        builtinModules: __lumo_builtin_names.slice(),
        isBuiltin: (spec) => __lumo_builtin_names.indexOf(String(spec).replace(/^node:/, '')) !== -1,
      };
    case 'stream':
      return {
        Readable: __lumo_readable,
        Writable: __lumo_writable,
        Duplex: __lumo_duplex,
        Transform: __lumo_transform,
        PassThrough: __lumo_passthrough,
        Stream: EventEmitter,
        pipeline(...args) {
          const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
          let current = args[0];
          for (let i = 1; i < args.length; i += 1) current = current.pipe(args[i]);
          if (callback) queueMicrotask(() => callback(null));
          return current;
        },
        finished(stream, callback) {
          if (typeof callback === 'function') stream.once('close', () => callback(null));
          return () => undefined;
        },
      };
    case 'querystring':
      return querystring;
    case 'string_decoder':
      return { StringDecoder };
    case 'perf_hooks':
      return perf_hooks;
    case 'constants':
      return fs.constants;
    default:
      throw new Error("Cannot find builtin module '" + id + "'");
  }
}

function __lumo_load_module(path) {
  const cached = __lumo_module_cache[path];
  if (cached) return cached.exports;
  const source = __lumo_module_map[path];
  if (source === undefined) throw new Error("Cannot find module '" + path + "'");
  if (path.slice(-5) === '.json') {
    const exports = JSON.parse(source);
    __lumo_module_cache[path] = { exports, loaded: true, id: path };
    return exports;
  }
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  const module = { exports: {}, id: path, filename: path, loaded: false, paths: [] };
  __lumo_module_cache[path] = module;
  // `new Function` runs inside QuickJS, not the extension realm; the extension
  // CSP restriction on eval does not apply to the VM.
  const factory = new Function('exports', 'require', 'module', '__filename', '__dirname', source);
  try {
    factory(
      module.exports,
      (spec) => __lumo_require_from(spec, dir, path),
      module,
      path,
      dir,
    );
  } catch (error) {
    delete __lumo_module_cache[path];
    throw error;
  }
  module.loaded = true;
  return module.exports;
}

function __lumo_require_from(spec, fromDir, parentPath) {
  const id = String(spec);
  const bare = id.startsWith('node:') ? id.slice(5) : id;
  if (__lumo_builtin_names.indexOf(bare) !== -1) return __lumo_builtin(bare);
  if (id.charAt(0) === '.' || id.charAt(0) === '/') {
    const base = __lumo_path.resolve(fromDir, id);
    for (const extension of ['', '.js', '.mjs', '.cjs', '.json', '/index.js', '/index.json']) {
      const candidate = base + extension;
      if (__lumo_module_map[candidate] !== undefined) return __lumo_load_module(candidate);
    }
    throw new Error(
      "Cannot find module '" + id + "' required from '" + (parentPath || __lumo_script_dir) + "'",
    );
  }
  if (bare === 'fs/promises' || __lumo_builtin_names.indexOf(bare) !== -1) return __lumo_builtin(bare);
  throw new Error(
    "Cannot find module '" + id + "'. The browser runtime has no node_modules; builtins available: " +
      __lumo_builtin_names.join(', '),
  );
}

function require(spec) {
  return __lumo_require_from(spec, __lumo_script_dir, undefined);
}
require.resolve = (spec) => String(spec);
require.main = module;
require.cache = __lumo_module_cache;
require.extensions = {};

/** Namespace object for `import` statements downgraded by the host. */
function __lumo_esm(spec) {
  const module = require(spec);
  if (module === null || (typeof module !== 'object' && typeof module !== 'function')) {
    return { default: module };
  }
  const namespace = {};
  for (const key of Object.keys(module)) namespace[key] = module[key];
  namespace.default =
    module && Object.prototype.hasOwnProperty.call(module, 'default') ? module.default : module;
  return namespace;
}

function __lumo_path_to_file_url(path) {
  return new URL('file://' + __lumo_path.resolve(__lumo_current_cwd, String(path)));
}

function pathToFileURL(path) {
  return __lumo_path_to_file_url(path);
}

function fileURLToPath(url) {
  const text = url instanceof URL ? url.href : String(url);
  if (text.indexOf('file://') !== 0) throw new TypeError('The URL must be of scheme file');
  return decodeURIComponent(text.slice(7));
}


/** Legacy `url.parse` — deprecated in Node but still widespread in scripts. */
function urlParse(input, parseQueryString, _slashesDenoteHost) {
  const text = String(input);
  let parsed;
  try {
    parsed = new URL(text, 'file:///');
  } catch {
    return { href: text, path: text, pathname: text, protocol: null, host: null };
  }
  const query = parsed.search ? parsed.search.slice(1) : null;
  return {
    protocol: parsed.protocol,
    slashes: parsed._hasAuthority,
    auth: parsed.username ? parsed.username + (parsed.password ? ':' + parsed.password : '') : null,
    host: parsed.host,
    port: parsed.port || null,
    hostname: parsed.hostname || null,
    hash: parsed.hash || null,
    search: parsed.search || null,
    query: parseQueryString ? new URLSearchParams(query || '').toString() : query,
    pathname: parsed.pathname,
    path: parsed.pathname + (parsed.search || ''),
    href: parsed.toString(),
  };
}

function urlFormat(target) {
  if (typeof target === 'string') return target;
  if (target instanceof URL) return target.toString();
  const protocol = target.protocol || 'https:';
  const slashes = target.slashes !== false && protocol !== 'mailto:';
  const auth = target.auth ? target.auth + '@' : '';
  const host = target.host || (target.hostname || '') + (target.port ? ':' + target.port : '');
  const pathname = target.pathname || '';
  let search = target.search || '';
  if (!search && target.query) {
    search = '?' + (typeof target.query === 'string' ? target.query : new URLSearchParams(target.query).toString());
  }
  const hash = target.hash || '';
  const path = target.path !== undefined ? target.path : pathname + search;
  return protocol + (slashes ? '//' + auth + host : auth + host) + path + hash;
}

function urlResolve(from, to) {
  return new URL(String(to), new URL(String(from), 'file:///')).toString();
}
function urlToHttpOptions(url) {
  const parsed = url instanceof URL ? url : new URL(String(url));
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    hash: parsed.hash,
    search: parsed.search,
    pathname: parsed.pathname,
    path: parsed.pathname + parsed.search,
    href: parsed.href,
    port: parsed.port,
    auth: parsed.username ? parsed.username + ':' + parsed.password : undefined,
  };
}

function __lumo_make_child_process() {
  return { exec, execAsync, execFile, spawn, execSync, spawnSync, ChildProcess };
}

/* -------------------------------------------------------------------------- */
/* globals                                                                    */
/* -------------------------------------------------------------------------- */

function __lumo_install_global(name, value) {
  try {
    globalThis[name] = value;
  } catch {
    // A frozen global is not fatal; the lexical binding still works.
  }
}

Error.captureStackTrace = function captureStackTrace(target) {
  __lumo_capture_stack(target);
};
Error.stackTraceLimit = 10;

__lumo_install_global('console', console);
__lumo_install_global('process', process);
__lumo_install_global('Buffer', Buffer);
__lumo_install_global('TextEncoder', TextEncoder);
__lumo_install_global('TextDecoder', TextDecoder);
__lumo_install_global('atob', atob);
__lumo_install_global('btoa', btoa);
__lumo_install_global('URL', URL);
__lumo_install_global('URLSearchParams', URLSearchParams);
__lumo_install_global('AbortController', AbortController);
__lumo_install_global('AbortSignal', AbortSignal);
__lumo_install_global('Headers', Headers);
__lumo_install_global('Request', Request);
__lumo_install_global('Response', Response);
__lumo_install_global('Blob', Blob);
__lumo_install_global('FormData', FormData);
__lumo_install_global('performance', performance);
__lumo_install_global('crypto', crypto);
__lumo_install_global('structuredClone', structuredClone);
__lumo_install_global('setTimeout', setTimeout);
__lumo_install_global('setInterval', setInterval);
__lumo_install_global('clearTimeout', clearTimeout);
__lumo_install_global('clearInterval', clearInterval);
__lumo_install_global('setImmediate', setImmediate);
__lumo_install_global('clearImmediate', clearImmediate);
__lumo_install_global('queueMicrotask', queueMicrotask);
__lumo_install_global('require', require);
__lumo_install_global('module', module);
__lumo_install_global('exports', exports);
__lumo_install_global('__filename', __filename);
__lumo_install_global('__dirname', __dirname);
__lumo_install_global('Intl', Intl);
__lumo_install_global('fetch', fetch);
__lumo_install_global('fs', fs);
__lumo_install_global('sleep', sleep);
__lumo_install_global('tools', tools);
__lumo_install_global('mcp', mcp);
__lumo_install_global('global', globalThis);

// Declared late but referenced by the tracking helpers above.
__lumo_install_global('__lumo_run_exit_hooks', __lumo_run_exit_hooks);
