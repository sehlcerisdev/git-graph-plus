import { describe, it, expect } from 'vitest';
import { md5 } from '../md5';

// Known MD5 vectors from RFC 1321 + Gravatar reference values. If our
// implementation drifts, gravatar URLs change for every user — visible
// regression in the commit detail panel.
describe('md5', () => {
  it('hashes the empty string', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('hashes "a"', () => {
    expect(md5('a')).toBe('0cc175b9c0f1b6a831c399e269772661');
  });

  it('hashes "abc"', () => {
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('hashes the standard "message digest" vector', () => {
    expect(md5('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
  });

  it('hashes lowercase alphabet', () => {
    expect(md5('abcdefghijklmnopqrstuvwxyz')).toBe('c3fcd3d76192e4007dfb496cca67e13b');
  });

  it('hashes the canonical Gravatar example email', () => {
    // From https://docs.gravatar.com/api/avatars/hash/
    expect(md5('MyEmailAddress@example.com'.trim().toLowerCase()))
      .toBe('0bc83cb571cd1c50ba6f3e8a78ef1346');
  });

  it('handles non-ASCII via UTF-8 encoding', () => {
    // "한글" UTF-8 = E1 9C 95 EA B7 80 → MD5 differs from latin-only path
    const result = md5('한글');
    expect(result).toMatch(/^[0-9a-f]{32}$/);
    // Verify it's not the empty hash (regression: utf8 path returning '')
    expect(result).not.toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('handles 2-byte UTF-8 characters (Latin-1 supplement range)', () => {
    // "é" (U+00E9) encodes as 0xc3 0xa9 — exercises the 0x80..0x800 branch
    const result = md5('é');
    expect(result).toMatch(/^[0-9a-f]{32}$/);
    expect(result).not.toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('handles surrogate-pair characters (4-byte UTF-8)', () => {
    // "💩" (U+1F4A9) is a high+low surrogate pair, encoded as 4-byte UTF-8.
    // This exercises the surrogate-pair branch (0xd800..0xe000 path).
    const result = md5('💩');
    expect(result).toMatch(/^[0-9a-f]{32}$/);
    expect(result).not.toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('handles mixed ASCII + 2-byte + surrogate-pair input', () => {
    const result = md5('hi 한글 💩');
    expect(result).toMatch(/^[0-9a-f]{32}$/);
  });
});
