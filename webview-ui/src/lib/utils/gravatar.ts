import { md5 } from './md5';

// LRU cap so a long session with thousands of distinct contributors doesn't
// grow the cache unboundedly. 500 (email, size) entries is more than enough
// for the visible window of a typical repo; older entries fall out when the
// cache hits the cap (Map preserves insertion order, so the first key is
// the oldest).
const MAX_CACHE_ENTRIES = 500;
const cache = new Map<string, string>();

export function getGravatarUrl(email: string, size: number = 40): string {
  const key = `${email}:${size}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    // LRU: refresh recency by deleting and re-inserting.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const hash = md5(email.trim().toLowerCase());
  const url = `https://www.gravatar.com/avatar/${hash}?s=${size}&d=retro`;
  cache.set(key, url);
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return url;
}

/** Exposed for tests. */
export function _gravatarCacheSize(): number { return cache.size; }
export function _clearGravatarCache(): void { cache.clear(); }
