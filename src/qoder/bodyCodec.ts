/**
 * Qoder's WAF body codec, used when the request URL carries `Encode=1`.
 *
 * Base64 first, then rotate by thirds (last third, middle third, first third),
 * then substitute every character through a permuted alphabet. Padding `=` maps
 * to `$`. The gateway decodes with the inverse, so the transformation must match
 * byte for byte.
 */

const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

if (CUSTOM_ALPHABET.length !== STD_ALPHABET.length) {
  throw new Error('body codec alphabets must be the same length');
}

export function encodeQoderBody(input: string | Buffer): string {
  const std = Buffer.from(input).toString('base64');
  const n = std.length;
  const third = Math.floor(n / 3);
  const rearranged = std.slice(n - third) + std.slice(third, n - third) + std.slice(0, third);

  let out = '';
  for (let i = 0; i < n; i++) {
    const ch = rearranged[i];
    if (ch === undefined) break;
    if (ch === '=') {
      out += '$';
      continue;
    }
    const idx = STD_ALPHABET.indexOf(ch);
    out += idx >= 0 ? (CUSTOM_ALPHABET[idx] as string) : ch;
  }
  return out;
}

/** Inverse of {@link encodeQoderBody}; used by tests and the capture tooling. */
export function decodeQoderBody(encoded: string): Buffer {
  let substituted = '';
  for (const ch of encoded) {
    if (ch === '$') {
      substituted += '=';
      continue;
    }
    const idx = CUSTOM_ALPHABET.indexOf(ch);
    substituted += idx >= 0 ? (STD_ALPHABET[idx] as string) : ch;
  }
  const n = substituted.length;
  const third = Math.floor(n / 3);
  const middleLength = n - 2 * third;
  const last = substituted.slice(0, third);
  const middle = substituted.slice(third, third + middleLength);
  const first = substituted.slice(third + middleLength);
  return Buffer.from(first + middle + last, 'base64');
}
