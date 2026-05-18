import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitService, GitError } from '../git-service';

function mockExec(service: GitService, fn: (args: string[]) => Promise<string>) {
  (service as unknown as { exec: (args: string[]) => Promise<string> }).exec = fn;
}

describe('GitService — rootPath', () => {
  it('returns the path passed to the constructor', () => {
    const s = new GitService('/some/path');
    expect(s.rootPath).toBe('/some/path');
  });
});

describe('GitService — submoduleStatus', () => {
  let service: GitService;
  beforeEach(() => { service = new GitService('/tmp/repo'); });

  it('returns [] for empty output', async () => {
    mockExec(service, async () => '');
    expect(await service.submoduleStatus()).toEqual([]);
  });

  it('parses clean status (leading space)', async () => {
    // The leading space is the status indicator for "clean"; include a second
    // line so .trim() doesn't strip the indicator on the only entry.
    mockExec(service, async () => '+modified1234 sub/m\n abcdef1234 sub/path (heads/main)');
    const result = await service.submoduleStatus();
    expect(result[1]).toEqual({ hash: 'abcdef1234', path: 'sub/path', status: 'clean' });
  });

  it('parses modified, uninitialized, and conflict states', async () => {
    mockExec(service, async () => [
      '+abcdef1234 sub/a',
      '-abcdef1234 sub/b',
      'Uabcdef1234 sub/c',
    ].join('\n'));
    const result = await service.submoduleStatus();
    expect(result.map(r => r.status)).toEqual(['modified', 'uninitialized', 'conflict']);
  });

  it('handles malformed lines (no match) with status "?"', async () => {
    mockExec(service, async () => 'garbage line\n abcdef1234 sub/valid');
    const result = await service.submoduleStatus();
    expect(result[0].status).toBe('?');
    expect(result[1].status).toBe('clean');
  });
});

describe('GitService — submoduleUpdate', () => {
  let service: GitService;
  beforeEach(() => { service = new GitService('/tmp/repo'); });

  it('runs without --init by default', async () => {
    const calls: string[][] = [];
    mockExec(service, async (args) => { calls.push(args); return 'ok'; });
    const out = await service.submoduleUpdate();
    expect(out).toBe('ok');
    expect(calls[0]).toEqual(['submodule', 'update']);
  });

  it('adds --init --recursive when init=true', async () => {
    const calls: string[][] = [];
    mockExec(service, async (args) => { calls.push(args); return 'ok'; });
    await service.submoduleUpdate(true);
    expect(calls[0]).toEqual(['submodule', 'update', '--init', '--recursive']);
  });
});

describe('GitService — LFS', () => {
  let service: GitService;
  beforeEach(() => { service = new GitService('/tmp/repo'); });

  it('lfsLsFiles returns parsed entries on success', async () => {
    mockExec(service, async () => '7fa22a8f5f * banner.png\n5f70bf18a0 - data.bin\n');
    const result = await service.lfsLsFiles();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ oid: '7fa22a8f5f', path: 'banner.png' });
  });

  it('lfsLsFiles returns [] when git-lfs is not installed (exitCode null)', async () => {
    mockExec(service, async (args) => { throw new GitError('command not found', null, args); });
    expect(await service.lfsLsFiles()).toEqual([]);
  });

  it('lfsLsFiles swallows expected configuration errors silently', async () => {
    const warn = vi.fn();
    service.setWarningHandler(warn);
    mockExec(service, async (args) => {
      throw new GitError('missing protocol: unsupported file:// remote', 2, args);
    });
    expect(await service.lfsLsFiles()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('lfsLsFiles warns on unexpected failures', async () => {
    const warn = vi.fn();
    service.setWarningHandler(warn);
    mockExec(service, async (args) => { throw new GitError('catastrophic boom', 1, args); });
    expect(await service.lfsLsFiles()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('lfsLock posts the file via git lfs lock', async () => {
    const calls: string[][] = [];
    mockExec(service, async (args) => { calls.push(args); return 'locked'; });
    await service.lfsLock('assets/big.bin');
    expect(calls[0]).toEqual(['lfs', 'lock', 'assets/big.bin']);
  });

  it('lfsUnlock posts the file via git lfs unlock', async () => {
    const calls: string[][] = [];
    mockExec(service, async (args) => { calls.push(args); return ''; });
    await service.lfsUnlock('a.bin');
    expect(calls[0]).toEqual(['lfs', 'unlock', 'a.bin']);
  });

  it('lfsUnlock appends --force when force=true', async () => {
    const calls: string[][] = [];
    mockExec(service, async (args) => { calls.push(args); return ''; });
    await service.lfsUnlock('a.bin', true);
    expect(calls[0]).toEqual(['lfs', 'unlock', 'a.bin', '--force']);
  });

  it('lfsLocks returns parsed locks on success', async () => {
    mockExec(service, async () => 'logo.png\talice\tID:1\n');
    const result = await service.lfsLocks();
    expect(result).toEqual([{ path: 'logo.png', owner: 'alice', id: 'ID:1' }]);
  });

  it('lfsLocks returns [] when git-lfs not installed', async () => {
    mockExec(service, async (args) => { throw new GitError('spawn failed', null, args); });
    expect(await service.lfsLocks()).toEqual([]);
  });

  it('lfsLocks swallows known expected errors and surfaces unexpected ones', async () => {
    const warn = vi.fn();
    service.setWarningHandler(warn);
    mockExec(service, async (args) => { throw new GitError('lfs.url not configured', 1, args); });
    expect(await service.lfsLocks()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();

    mockExec(service, async (args) => { throw new GitError('unexpected error condition', 1, args); });
    expect(await service.lfsLocks()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('lfsLsFiles recognises additional expected error patterns', async () => {
    const warn = vi.fn();
    service.setWarningHandler(warn);
    const expected = [
      'standalone transfer agent required',
      'no such remote',
      "'origin' does not appear to be a git repository",
      'this operation requires existing locks',
      'not a git repository',
    ];
    for (const msg of expected) {
      warn.mockClear();
      mockExec(service, async (args) => { throw new GitError(msg, 1, args); });
      await service.lfsLsFiles();
      expect(warn).not.toHaveBeenCalled();
    }
  });
});

describe('GitService — git-flow shortcuts', () => {
  let service: GitService;
  beforeEach(() => { service = new GitService('/tmp/repo'); });

  it('flowFeatureStart runs git flow feature start <name>', async () => {
    const calls: string[][] = [];
    mockExec(service, async (args) => { calls.push(args); return 'ok'; });
    await service.flowFeatureStart('login');
    expect(calls[0]).toEqual(['flow', 'feature', 'start', 'login']);
  });

  it('flowFeatureFinish runs git flow feature finish <name>', async () => {
    const calls: string[][] = [];
    mockExec(service, async (args) => { calls.push(args); return ''; });
    await service.flowFeatureFinish('login');
    expect(calls[0]).toEqual(['flow', 'feature', 'finish', 'login']);
  });

  it('flowReleaseStart and flowReleaseFinish include -m message for finish', async () => {
    const calls: string[][] = [];
    mockExec(service, async (args) => { calls.push(args); return ''; });
    await service.flowReleaseStart('1.0');
    await service.flowReleaseFinish('1.0');
    expect(calls[0]).toEqual(['flow', 'release', 'start', '1.0']);
    expect(calls[1]).toEqual(['flow', 'release', 'finish', '-m', '1.0', '1.0']);
  });

  it('flowHotfixStart and flowHotfixFinish behave the same way', async () => {
    const calls: string[][] = [];
    mockExec(service, async (args) => { calls.push(args); return ''; });
    await service.flowHotfixStart('1.0.1');
    await service.flowHotfixFinish('1.0.1');
    expect(calls[0]).toEqual(['flow', 'hotfix', 'start', '1.0.1']);
    expect(calls[1]).toEqual(['flow', 'hotfix', 'finish', '-m', '1.0.1', '1.0.1']);
  });
});

describe('GitService — getFlowBranches', () => {
  let service: GitService;
  beforeEach(() => { service = new GitService('/tmp/repo'); });

  it('returns empty groups when flow config is not set', async () => {
    mockExec(service, async () => { throw new GitError('not set', 1, []); });
    const result = await service.getFlowBranches();
    expect(result).toEqual({ features: [], releases: [], hotfixes: [] });
  });

  it('groups branches by configured prefixes', async () => {
    const responses: Record<string, string> = {
      'config --get gitflow.branch.master': 'main',
      'config --get gitflow.branch.develop': 'develop',
      'config --get gitflow.prefix.feature': 'feature/',
      'config --get gitflow.prefix.release': 'release/',
      'config --get gitflow.prefix.hotfix': 'hotfix/',
      'config --get gitflow.prefix.versiontag': 'v',
      'branch --list': [
        '* develop',
        '  feature/login',
        '  feature/signup',
        '  release/1.0',
        '  hotfix/1.0.1',
        '  main',
      ].join('\n'),
    };
    mockExec(service, async (args) => {
      const key = args.join(' ');
      if (key in responses) return responses[key];
      return '';
    });
    const result = await service.getFlowBranches();
    expect(result.features).toEqual(['feature/login', 'feature/signup']);
    expect(result.releases).toEqual(['release/1.0']);
    expect(result.hotfixes).toEqual(['hotfix/1.0.1']);
  });
});

describe('GitService — argument validation', () => {
  let service: GitService;
  beforeEach(() => { service = new GitService('/tmp/repo'); });

  it('rejects refs that start with a dash (looks like a CLI flag)', async () => {
    await expect(service.checkout('--upload-pack=foo')).rejects.toThrow();
  });

  it('rejects paths that start with a dash', async () => {
    await expect(service.lsTree('HEAD', '--bad-flag')).rejects.toThrow();
  });
});
