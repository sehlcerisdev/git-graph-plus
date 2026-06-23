import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AvatarCache, type AvatarFetcher } from '../avatar-cache';

// A fake fetcher that records every URL it is asked to fetch and returns a
// fixed PNG payload, so tests never touch the network.
function makeFetcher(): { fetcher: AvatarFetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: AvatarFetcher = async (url) => {
    calls.push(url);
    return { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png' };
  };
  return { fetcher, calls };
}

describe('AvatarCache', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ggp-avatar-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('fetches an avatar once and returns a base64 data URI', async () => {
    const { fetcher, calls } = makeFetcher();
    const cache = new AvatarCache(null, fetcher);

    const uri = await cache.get('Alice@Example.com', 32);

    expect(uri).toMatch(/^data:image\/png;base64,/);
    expect(calls).toHaveLength(1);
    // Email is hashed lowercase+trimmed per the gravatar spec.
    expect(calls[0]).toContain('https://www.gravatar.com/avatar/');
    expect(calls[0]).toContain('s=32');
  });

  it('serves repeat requests from memory without re-fetching', async () => {
    const { fetcher, calls } = makeFetcher();
    const cache = new AvatarCache(null, fetcher);

    await cache.get('alice@example.com', 32);
    await cache.get('  Alice@Example.com  ', 32); // same identity after normalization

    expect(calls).toHaveLength(1);
  });

  it('de-duplicates concurrent requests for the same avatar', async () => {
    const { fetcher, calls } = makeFetcher();
    const cache = new AvatarCache(null, fetcher);

    const [a, b] = await Promise.all([
      cache.get('alice@example.com', 32),
      cache.get('alice@example.com', 32),
    ]);

    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  it('persists to disk so a fresh instance avoids the network', async () => {
    const { fetcher: f1, calls: c1 } = makeFetcher();
    const first = new AvatarCache(tmpDir, f1);
    await first.get('alice@example.com', 32);
    expect(c1).toHaveLength(1);

    const { fetcher: f2, calls: c2 } = makeFetcher();
    const second = new AvatarCache(tmpDir, f2);
    const uri = await second.get('alice@example.com', 32);

    expect(uri).toMatch(/^data:image\/png;base64,/);
    expect(c2).toHaveLength(0); // served from disk, no fetch
  });

  it('returns null when the fetch fails', async () => {
    const failing: AvatarFetcher = async () => null;
    const cache = new AvatarCache(null, failing);

    expect(await cache.get('alice@example.com', 32)).toBeNull();
  });

  it('re-fetches once a cached entry exceeds its TTL', async () => {
    const { fetcher: f1 } = makeFetcher();
    await new AvatarCache(tmpDir, f1).get('alice@example.com', 32);

    // Age the cached file well past any reasonable TTL.
    const [name] = await fs.readdir(tmpDir);
    const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365);
    await fs.utimes(path.join(tmpDir, name), old, old);

    const { fetcher: f2, calls: c2 } = makeFetcher();
    const uri = await new AvatarCache(tmpDir, f2).get('alice@example.com', 32);

    expect(uri).toMatch(/^data:image\/png;base64,/);
    expect(c2).toHaveLength(1); // stale -> re-fetched
  });

  it('serves the stale cached copy when a refresh fails', async () => {
    const { fetcher: f1 } = makeFetcher();
    await new AvatarCache(tmpDir, f1).get('alice@example.com', 32);

    const [name] = await fs.readdir(tmpDir);
    const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365);
    await fs.utimes(path.join(tmpDir, name), old, old);

    const failing: AvatarFetcher = async () => null;
    const uri = await new AvatarCache(tmpDir, failing).get('alice@example.com', 32);

    expect(uri).toMatch(/^data:image\/png;base64,/); // stale copy, not null
  });

  it('prunes the disk cache so it does not grow unbounded', async () => {
    const { fetcher } = makeFetcher();
    const cache = new AvatarCache(tmpDir, fetcher, { maxDiskEntries: 2 });

    await cache.get('a@example.com', 32);
    await cache.get('b@example.com', 32);
    await cache.get('c@example.com', 32);
    await cache.get('d@example.com', 32);

    const files = await fs.readdir(tmpDir);
    expect(files.length).toBeLessThanOrEqual(2);
  });
});
