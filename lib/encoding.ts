/**
 * Byte <-> string codecs shared by the file store, the shell and the MCP bridge.
 *
 * The shell speaks three shapes at once: `Uint8Array` for binary content, latin1
 * "byte strings" for just-bash pipes, and base64 for MCP image parts. Each of
 * those was previously implemented at the call site (six copies, with slightly
 * different edge behaviour); a chunked implementation also matters for
 * multi-megabyte screenshots, where `String.fromCharCode(...bytes)` overflows the
 * call stack and a per-byte loop takes seconds.
 */

const CHUNK = 0x8000;

/** Decode base64 (standard or URL-safe) into bytes. */
export function bytesFromBase64(data: string): Uint8Array {
  const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encode bytes as base64, in slices so a large image does not overflow the stack. */
export function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Bytes -> the latin1 "byte string" just-bash uses for binary pipe payloads. */
export function latin1FromBytes(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/** latin1 "byte string" ("\x00".."\xff", one code unit per byte) -> bytes. */
export function bytesFromLatin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

/** Write side of `hex` decoding: `"0aff"` -> two bytes. */
export function bytesFromHex(text: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(text.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
    bytes[i] = Number.isNaN(byte) ? 0 : byte;
  }
  return bytes;
}

/** ASCII write side: each code unit becomes one byte, truncated to 7 bits. */
export function bytesFromAscii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0x7f;
  return bytes;
}

/** Encode text as UTF-8 bytes. */
export function bytesFromText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Decode UTF-8 bytes, honouring the shell's `BufferEncoding` names. */
export function textFromBytes(bytes: Uint8Array, encoding?: string | null): string {
  switch (encoding) {
    case 'base64':
      return base64FromBytes(bytes);
    case 'hex':
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    case 'binary':
    case 'latin1':
      return latin1FromBytes(bytes);
    case 'ascii':
      return Array.from(bytes, (byte) => (byte <= 0x7f ? String.fromCharCode(byte) : '?')).join('');
    default:
      return new TextDecoder('utf-8').decode(bytes);
  }
}
