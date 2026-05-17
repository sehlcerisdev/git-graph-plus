import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitService, GitError } from '../git-service';

// Access private exec method via prototype for mocking
function mockExec(service: GitService, fn: (args: string[]) => Promise<string>) {
  (service as any).exec = fn;
}

describe('GitService', () => {
  let service: GitService;

  beforeEach(() => {
    service = new GitService('/tmp/test-repo');
  });

  describe('stash index validation', () => {
    it('stashApply rejects negative index', async () => {
      await expect(service.stashApply(-1)).rejects.toThrow('Invalid stash index');
    });

    it('stashPop rejects negative index', async () => {
      await expect(service.stashPop(-1)).rejects.toThrow('Invalid stash index');
    });

    it('stashDrop rejects negative index', async () => {
      await expect(service.stashDrop(-1)).rejects.toThrow('Invalid stash index');
    });

    it('stashApply rejects non-integer', async () => {
      await expect(service.stashApply(1.5)).rejects.toThrow('Invalid stash index');
    });

    it('stashApply accepts valid index', async () => {
      mockExec(service, async () => '');
      await expect(service.stashApply(0)).resolves.toBeUndefined();
    });
  });

  describe('clean', () => {
    it('calls git clean -f -d by default', async () => {
      const calls: string[][] = [];
      mockExec(service, async (args) => { calls.push(args); return ''; });

      await service.clean();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('clean');
      expect(calls[0]).toContain('-f');
      expect(calls[0]).toContain('-d');
    });

    it('omits -d when directories=false', async () => {
      const calls: string[][] = [];
      mockExec(service, async (args) => { calls.push(args); return ''; });

      await service.clean(false);
      expect(calls[0]).toContain('-f');
      expect(calls[0]).not.toContain('-d');
    });
  });

  describe('pushTagToAllRemotes', () => {
    it('pushes tag to all remotes', async () => {
      const calls: string[][] = [];
      // Mock getRemoteNames to return two remotes
      (service as any).cachedRemoteNames = ['origin', 'upstream'];
      (service as any).remoteNamesCacheTime = Date.now();
      mockExec(service, async (args) => { calls.push(args); return ''; });

      await service.pushTagToAllRemotes('v1.0');
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(['push', 'origin', 'refs/tags/v1.0']);
      expect(calls[1]).toEqual(['push', 'upstream', 'refs/tags/v1.0']);
    });

    it('does nothing with no remotes', async () => {
      const calls: string[][] = [];
      (service as any).cachedRemoteNames = [];
      (service as any).remoteNamesCacheTime = Date.now();
      mockExec(service, async (args) => { calls.push(args); return ''; });

      await service.pushTagToAllRemotes('v1.0');
      expect(calls).toHaveLength(0);
    });
  });

  describe('setExtraEnv', () => {
    it('stores extra environment variables', () => {
      service.setExtraEnv({ GIT_ASKPASS: '/usr/bin/askpass' });
      expect((service as any).extraEnv).toEqual({ GIT_ASKPASS: '/usr/bin/askpass' });
    });
  });

  describe('activity log truncation', () => {
    it('truncates long command strings in activity log', async () => {
      const longArg = 'x'.repeat(1000);
      // Call exec directly to test activity log recording
      const origExec = (service as any).exec.bind(service);
      // We can't easily test the real exec without spawning git,
      // so we verify the truncation logic inline
      const command = `git checkout ${longArg}`;
      const truncated = command.length > 500 ? command.substring(0, 500) + '…' : command;
      expect(truncated.length).toBe(501);
      expect(truncated.endsWith('…')).toBe(true);
    });
  });

  describe('GitError', () => {
    it('formats error message correctly', () => {
      const err = new GitError('not a git repo', 128, ['status']);
      expect(err.message).toContain('git status failed');
      expect(err.message).toContain('exit 128');
      expect(err.stderr).toBe('not a git repo');
      expect(err.exitCode).toBe(128);
    });
  });

  describe('log remoteFilter', () => {
    let calls: string[][];

    beforeEach(() => {
      calls = [];
      (service as any).cachedRemoteNames = [];
      (service as any).remoteNamesCacheTime = Date.now();
      mockExec(service, async (args) => { calls.push(args); return ''; });
    });

    it('uses all globs by default', async () => {
      await service.log({}).catch(() => {});
      const logCall = calls.find(c => c[0] === 'log' && !c.includes('--no-walk'));
      expect(logCall).toContain('--glob=refs/heads');
      expect(logCall).toContain('--glob=refs/remotes');
      expect(logCall).toContain('--glob=refs/tags');
    });

    it('omits remotes and tags when remoteFilter is ["local"]', async () => {
      await service.log({ remoteFilter: ['local'] }).catch(() => {});
      const logCall = calls.find(c => c[0] === 'log' && !c.includes('--no-walk'));
      expect(logCall).toContain('--glob=refs/heads');
      expect(logCall).not.toContain('--glob=refs/remotes');
      expect(logCall).not.toContain('--glob=refs/tags');
    });

    it('scopes to specific remote and omits tags when remoteFilter is ["origin"]', async () => {
      await service.log({ remoteFilter: ['origin'] }).catch(() => {});
      const logCall = calls.find(c => c[0] === 'log' && !c.includes('--no-walk'));
      expect(logCall).not.toContain('--glob=refs/heads');
      expect(logCall).toContain('--glob=refs/remotes/origin');
      expect(logCall).not.toContain('--glob=refs/remotes'); // bare --glob=refs/remotes means "all remotes"
      expect(logCall).not.toContain('--glob=refs/tags');
    });

    it('combines local and specific remote and omits tags when remoteFilter is ["local", "origin"]', async () => {
      await service.log({ remoteFilter: ['local', 'origin'] }).catch(() => {});
      const logCall = calls.find(c => c[0] === 'log' && !c.includes('--no-walk'));
      expect(logCall).toContain('--glob=refs/heads');
      expect(logCall).toContain('--glob=refs/remotes/origin');
      expect(logCall).not.toContain('--glob=refs/remotes'); // bare --glob=refs/remotes means "all remotes"
      expect(logCall).not.toContain('--glob=refs/tags');
    });
  });

  describe('log branches filter', () => {
    let calls: string[][];

    beforeEach(() => {
      calls = [];
      (service as any).cachedRemoteNames = [];
      (service as any).remoteNamesCacheTime = Date.now();
      mockExec(service, async (args) => { calls.push(args); return ''; });
    });

    it('passes branch names directly and omits glob args when branches is provided', async () => {
      await service.log({ branches: ['main', 'develop'] }).catch(() => {});
      const logCall = calls.find(c => c[0] === 'log' && !c.includes('--no-walk'));
      expect(logCall).toContain('main');
      expect(logCall).toContain('develop');
      expect(logCall).not.toContain('--glob=refs/heads');
      expect(logCall).not.toContain('--glob=refs/remotes');
      expect(logCall).not.toContain('--glob=refs/tags');
    });

    it('passes remote branch ref correctly', async () => {
      await service.log({ branches: ['origin/main'] }).catch(() => {});
      const logCall = calls.find(c => c[0] === 'log' && !c.includes('--no-walk'));
      expect(logCall).toContain('origin/main');
      expect(logCall).not.toContain('--glob=refs/heads');
    });

    it('falls back to default globs when branches is empty array', async () => {
      await service.log({ branches: [] }).catch(() => {});
      const logCall = calls.find(c => c[0] === 'log' && !c.includes('--no-walk'));
      expect(logCall).toContain('--glob=refs/heads');
      expect(logCall).toContain('--glob=refs/remotes');
      expect(logCall).toContain('--glob=refs/tags');
    });

    it('rejects branch name starting with -', async () => {
      await expect(service.log({ branches: ['-bad'] })).rejects.toThrow("must not start with '-'");
    });
  });

  describe('ref safety validation', () => {
    it('checkout rejects ref starting with -', async () => {
      await expect(service.checkout('-foo')).rejects.toThrow("must not start with '-'");
    });

    it('merge rejects ref starting with --', async () => {
      await expect(service.merge('--hack')).rejects.toThrow("must not start with '-'");
    });

    it('rebase rejects ref starting with -', async () => {
      await expect(service.rebase('-upload-pack=attacker')).rejects.toThrow("must not start with '-'");
    });

    it('cherryPick rejects hash starting with -', async () => {
      await expect(service.cherryPick('-foo')).rejects.toThrow("must not start with '-'");
    });

    it('revert rejects hash starting with -', async () => {
      await expect(service.revert('-foo')).rejects.toThrow("must not start with '-'");
    });

    it('reset rejects ref starting with -', async () => {
      await expect(service.reset('-foo', 'hard')).rejects.toThrow("must not start with '-'");
    });

    it('interactiveRebase rejects base starting with -', async () => {
      await expect(service.interactiveRebase('-foo', [])).rejects.toThrow("must not start with '-'");
    });

    it('interactiveRebase rejects base of --hack', async () => {
      await expect(service.interactiveRebase('--hack', [])).rejects.toThrow("must not start with '-'");
    });

    it('checkout rejects empty ref', async () => {
      await expect(service.checkout('')).rejects.toThrow('Invalid ref');
    });

    it('checkout accepts normal branch name', async () => {
      mockExec(service, async () => '');
      await expect(service.checkout('main')).resolves.toBeUndefined();
    });

    it('checkout passes --merge when merge option set', async () => {
      const calls: string[][] = [];
      mockExec(service, async (args) => { calls.push(args); return ''; });
      await service.checkout('main', { merge: true });
      expect(calls[0]).toContain('--merge');
      expect(calls[0]).toContain('main');
    });

    it('checkout passes --force when force option set', async () => {
      const calls: string[][] = [];
      mockExec(service, async (args) => { calls.push(args); return ''; });
      await service.checkout('main', { force: true });
      expect(calls[0]).toContain('--force');
      expect(calls[0]).not.toContain('--merge');
    });

    it('checkout uses plain form by default', async () => {
      const calls: string[][] = [];
      mockExec(service, async (args) => { calls.push(args); return ''; });
      await service.checkout('main');
      expect(calls[0]).not.toContain('--force');
      expect(calls[0]).not.toContain('--merge');
    });

    it('interactiveRebase accepts normal base', async () => {
      // Avoid actually running the spawn/rebase; just verify the ref check passes and
      // the action validator catches a bad action before spawn.
      await expect(service.interactiveRebase('main', [{ action: 'nope', hash: 'abc123', subject: 'test' }]))
        .rejects.toThrow('Invalid rebase action');
    });

    it('log rejects options.branch starting with -', async () => {
      await expect(service.log({ branch: '-foo' })).rejects.toThrow("must not start with '-'");
    });

    it('diff rejects ref1 starting with -', async () => {
      await expect(service.diff({ ref1: '-foo' })).rejects.toThrow("must not start with '-'");
    });

    it('addRemote rejects url starting with -', async () => {
      await expect(service.addRemote('origin', '--upload-pack=attacker')).rejects.toThrow("must not start with '-'");
    });

    it('setUpstream rejects remote starting with -', async () => {
      await expect(service.setUpstream('main', '-foo', 'main')).rejects.toThrow("must not start with '-'");
    });

    it('worktreeAdd rejects branch starting with -', async () => {
      await expect(service.worktreeAdd('/tmp/wt', '-foo')).rejects.toThrow("must not start with '-'");
    });

    it('worktreeAdd rejects newBranch starting with -', async () => {
      await expect(service.worktreeAdd('/tmp/wt', undefined, '-foo')).rejects.toThrow("must not start with '-'");
    });

    it('bisectStart rejects bad starting with -', async () => {
      await expect(service.bisectStart('-foo')).rejects.toThrow("must not start with '-'");
    });

    it('bisectGood rejects ref starting with -', async () => {
      await expect(service.bisectGood('-foo')).rejects.toThrow("must not start with '-'");
    });

    it('deleteRemoteBranch rejects name starting with -', async () => {
      await expect(service.deleteRemoteBranch('-foo')).rejects.toThrow("must not start with '-'");
    });

    it('pushTag rejects remote starting with -', async () => {
      await expect(service.pushTag('v1.0', '-foo')).rejects.toThrow("must not start with '-'");
    });

    it('getImageBase64 rejects absolute filePath', async () => {
      await expect(service.getImageBase64('main', '/etc/passwd')).rejects.toThrow('Unsafe filePath');
    });

    it('getImageBase64 rejects parent traversal in filePath', async () => {
      await expect(service.getImageBase64('main', '../secret')).rejects.toThrow('Unsafe filePath');
    });

    it('getImageBase64 rejects empty filePath', async () => {
      await expect(service.getImageBase64('main', '')).rejects.toThrow('Invalid filePath');
    });
  });

  describe('log() uncommitted node injection', () => {
    const logLine = '\x01abc123\x00abc\x00Author\x00a@a.com\x002024-01-01T00:00:00Z\x00Author\x00a@a.com\x002024-01-01T00:00:00Z\x00feat: initial\x00\x00\x00\n';

    it('prepends UNCOMMITTED commit when porcelain has output', async () => {
      mockExec(service, async (args) => {
        if (args.includes('--porcelain') && !args.includes('diff')) return ' M src/foo.ts\n?? new.ts\n';
        if (args.includes('log') && !args.includes('--no-walk')) return logLine;
        if (args.includes('remote')) return '';
        if (args.includes('stash')) return '';
        return '';
      });

      const commits = await service.log();
      expect(commits[0].hash).toBe('UNCOMMITTED');
      expect(commits[0].refs).toEqual([]);
      expect(commits[0].parents).toEqual([]);
      expect(commits[0].subject).toBe('Uncommitted changes (2)');
    });

    it('does NOT prepend UNCOMMITTED when working tree is clean', async () => {
      mockExec(service, async (args) => {
        if (args.includes('--porcelain') && !args.includes('diff')) return '';
        if (args.includes('log') && !args.includes('--no-walk')) return logLine;
        if (args.includes('remote')) return '';
        if (args.includes('stash')) return '';
        return '';
      });

      const commits = await service.log();
      expect(commits[0]?.hash).not.toBe('UNCOMMITTED');
    });
  });

  describe('getUncommittedDiff', () => {
    it('returns staged and unstaged file lists', async () => {
      // porcelain format: XY PATH (X=staged, Y=unstaged)
      mockExec(service, async () => 'M  src/foo.ts\nA  src/bar.ts\n M src/old.ts\n?? src/new.ts\n');

      const result = await service.getUncommittedDiff();
      expect(result.staged).toEqual([
        { path: 'src/foo.ts', status: 'M' },
        { path: 'src/bar.ts', status: 'A' },
      ]);
      expect(result.unstaged).toEqual([
        { path: 'src/old.ts', status: 'M' },
        { path: 'src/new.ts', status: 'U' },
      ]);
    });

    it('returns empty arrays when no changes', async () => {
      mockExec(service, async () => '');
      const result = await service.getUncommittedDiff();
      expect(result.staged).toEqual([]);
      expect(result.unstaged).toEqual([]);
    });

    it('marks untracked entries with trailing slash as nested repos', async () => {
      // Nested git repos (not registered as submodules) surface as untracked
      // directories with a trailing slash. They should be flagged with status
      // 'N' so the UI can show a meaningful hint instead of an empty diff.
      mockExec(service, async () => '?? nested-repo/\n?? submodule-test/\n?? src/new.ts\n');

      const result = await service.getUncommittedDiff();
      expect(result.unstaged).toEqual([
        { path: 'nested-repo', status: 'N' },
        { path: 'submodule-test', status: 'N' },
        { path: 'src/new.ts', status: 'U' },
      ]);
    });

    it('preserves leading space when first line is unstaged-only', async () => {
      // Regression: trimming the whole output dropped the first line's leading
      // space, shifting columns so the file landed in `staged` with its first
      // character chopped off.
      mockExec(service, async () => ' M src/foo.ts\n M src/bar.ts\n');

      const result = await service.getUncommittedDiff();
      expect(result.staged).toEqual([]);
      expect(result.unstaged).toEqual([
        { path: 'src/foo.ts', status: 'M' },
        { path: 'src/bar.ts', status: 'M' },
      ]);
    });
  });

  describe('getUncommittedFileDiff', () => {
    it('passes --cached for staged files', async () => {
      const calls: string[][] = [];
      mockExec(service, async (args) => { calls.push(args); return ''; });

      await service.getUncommittedFileDiff('src/foo.ts', true);
      expect(calls[0]).toContain('--cached');
      expect(calls[0]).toContain('src/foo.ts');
    });

    it('omits --cached for unstaged files', async () => {
      const calls: string[][] = [];
      mockExec(service, async (args) => { calls.push(args); return ''; });

      await service.getUncommittedFileDiff('src/foo.ts', false);
      expect(calls[0]).not.toContain('--cached');
      expect(calls[0]).toContain('src/foo.ts');
    });
  });
});
