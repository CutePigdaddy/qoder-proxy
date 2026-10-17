import { describe, expect, it } from 'vitest';
import { decodeQoderBody, encodeQoderBody } from '../../src/qoder/bodyCodec.js';

describe('encodeQoderBody', () => {
  it('round-trips arbitrary payloads', () => {
    for (const sample of ['a', 'ab', 'abc', 'hello world', JSON.stringify({ a: 1, b: 'x'.repeat(50) })]) {
      const encoded = encodeQoderBody(sample);
      expect(decodeQoderBody(encoded).toString('utf8')).toBe(sample);
    }
  });

  it('keeps the base64 payload length', () => {
    const input = 'the quick brown fox jumps over the lazy dog';
    const encoded = encodeQoderBody(input);
    expect(encoded.length).toBe(Buffer.from(input).toString('base64').length);
  });

  it('replaces padding with $', () => {
    // "a" -> base64 "YQ==" which has two padding characters.
    const encoded = encodeQoderBody('a');
    expect(encoded.length).toBe(4);
    expect(encoded.split('$').length - 1).toBe(2);
  });

  it('is deterministic', () => {
    expect(encodeQoderBody('stable')).toBe(encodeQoderBody('stable'));
  });

  it('only emits characters from the custom alphabet or padding marker', () => {
    const custom = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
    const encoded = encodeQoderBody('abcdefghijklmnopqrstuvwxyz0123456789');
    for (const ch of encoded) {
      expect(ch === '$' || custom.includes(ch)).toBe(true);
    }
  });
});
