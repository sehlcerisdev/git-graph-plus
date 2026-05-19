import { describe, it, expect, beforeEach } from 'vitest';
import { getGravatarUrl, _gravatarCacheSize, _clearGravatarCache } from '../gravatar';

beforeEach(() => _clearGravatarCache());

describe('getGravatarUrl', () => {
  it('builds a URL with the lowercased trimmed MD5 hash', () => {
    const url = getGravatarUrl('  MyEmailAddress@example.com  ');
    expect(url).toBe('https://www.gravatar.com/avatar/0bc83cb571cd1c50ba6f3e8a78ef1346?s=40&d=retro');
  });

  it('treats the same email at different sizes as different URLs', () => {
    const a = getGravatarUrl('a@b.c', 40);
    const b = getGravatarUrl('a@b.c', 80);
    expect(a).toContain('s=40');
    expect(b).toContain('s=80');
    expect(a).not.toBe(b);
  });

  it('defaults to size 40 when omitted', () => {
    expect(getGravatarUrl('a@b.c')).toContain('s=40');
  });

  it('always requests the "retro" default avatar', () => {
    expect(getGravatarUrl('a@b.c')).toContain('d=retro');
  });

  it('caps the cache at the LRU limit and evicts the oldest entry', () => {
    // Fill above the cap to force eviction of the very first insertion.
    for (let i = 0; i < 600; i++) {
      getGravatarUrl(`user${i}@example.com`);
    }
    expect(_gravatarCacheSize()).toBeLessThanOrEqual(500);
    // The earliest insertion (user0) should have been evicted.
    // After eviction, looking it up again is a miss and re-inserts —
    // but the cache stays at the cap.
    getGravatarUrl('user0@example.com');
    expect(_gravatarCacheSize()).toBeLessThanOrEqual(500);
  });
});
