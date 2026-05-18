import { describe, it, expect } from 'vitest';
import { getGravatarUrl } from '../gravatar';

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
});
