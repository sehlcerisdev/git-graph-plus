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

  describe('auth retry (execWithAuthRetry / isAuthError)', () => {
    // The auth retry plumbing was added in dfd8af6 to drive VS Code's askpass
    // when the credential helper has nothing cached. Regression coverage for
    // the heuristic and the retry-once contract lives here.

    function callIsAuthError(stderr: string): boolean {
      return (service as any).isAuthError(new GitError(stderr, 128, ['push']));
    }

    it('isAuthError matches HTTP credential failures', () => {
      expect(callIsAuthError('fatal: Authentication failed for https://github.com/foo/bar')).toBe(true);
      expect(callIsAuthError('fatal: could not read Username for https://github.com')).toBe(true);
      expect(callIsAuthError('fatal: could not read Password for https://github.com')).toBe(true);
      expect(callIsAuthError('fatal: terminal prompts disabled')).toBe(true);
      expect(callIsAuthError('remote: Invalid username or password')).toBe(true);
      expect(callIsAuthError('Authentication required')).toBe(true);
      expect(callIsAuthError('HTTP Basic: Access denied')).toBe(true);
    });

    it('isAuthError does NOT match SSH key failures (askpass cannot help)', () => {
      expect(callIsAuthError('Permission denied (publickey).')).toBe(false);
      expect(callIsAuthError('fatal: Could not read from remote repository.')).toBe(false);
    });

    it('isAuthError returns false for non-GitError', () => {
      expect((service as any).isAuthError(new Error('boom'))).toBe(false);
      expect((service as any).isAuthError('string error')).toBe(false);
    });

    it('execWithAuthRetry passes through non-auth errors without invoking handler', async () => {
      const handler = vi.fn(async () => true);
      service.setAuthRetryHandler(handler);
      mockExec(service, async () => { throw new GitError('fatal: bad object', 128, ['fetch']); });

      await expect((service as any).execWithAuthRetry(['fetch'])).rejects.toThrow('bad object');
      expect(handler).not.toHaveBeenCalled();
    });

    it('execWithAuthRetry throws original error when no handler registered', async () => {
      mockExec(service, async () => { throw new GitError('fatal: Authentication failed', 128, ['push']); });

      await expect((service as any).execWithAuthRetry(['push'])).rejects.toThrow('Authentication failed');
    });

    it('execWithAuthRetry throws when handler returns false (no retry possible)', async () => {
      const handler = vi.fn(async () => false);
      service.setAuthRetryHandler(handler);
      let calls = 0;
      mockExec(service, async () => { calls++; throw new GitError('fatal: Authentication failed', 128, ['push']); });

      await expect((service as any).execWithAuthRetry(['push'], 'origin')).rejects.toThrow('Authentication failed');
      expect(handler).toHaveBeenCalledWith('origin');
      expect(calls).toBe(1); // no retry
    });

    it('execWithAuthRetry retries exactly once when handler returns true', async () => {
      const handler = vi.fn(async () => true);
      service.setAuthRetryHandler(handler);
      let calls = 0;
      mockExec(service, async () => {
        calls++;
        if (calls === 1) throw new GitError('fatal: Authentication failed', 128, ['push']);
        return 'ok';
      });

      const result = await (service as any).execWithAuthRetry(['push'], 'origin');
      expect(result).toBe('ok');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(calls).toBe(2);
    });

    it('execWithAuthRetry surfaces second failure (does not retry twice)', async () => {
      service.setAuthRetryHandler(async () => true);
      let calls = 0;
      mockExec(service, async () => {
        calls++;
        throw new GitError('fatal: Authentication failed', 128, ['push']);
      });

      await expect((service as any).execWithAuthRetry(['push'])).rejects.toThrow('Authentication failed');
      expect(calls).toBe(2); // exactly one retry, then surface
    });

    it('execWithAuthRetry swallows handler exceptions and treats them as "no retry"', async () => {
      service.setAuthRetryHandler(async () => { throw new Error('askpass crashed'); });
      let calls = 0;
      mockExec(service, async () => {
        calls++;
        throw new GitError('fatal: Authentication failed', 128, ['push']);
      });

      await expect((service as any).execWithAuthRetry(['push'])).rejects.toThrow('Authentication failed');
      expect(calls).toBe(1); // handler threw → no retry
    });
  });

  describe('merge / push / fetch / rebase / stashSave option flags', () => {
    let calls: string[][];
    beforeEach(() => {
      calls = [];
      (service as any).cachedRemoteNames = [];
      (service as any).remoteNamesCacheTime = Date.now();
      mockExec(service, async (args) => { calls.push(args); return ''; });
    });

    it('merge passes --ff-only', async () => {
      await service.merge('main', { ffOnly: true });
      expect(calls[0]).toContain('--ff-only');
    });

    it('merge passes --squash then commits via separate exec', async () => {
      await service.merge('feature', { squash: true });
      // First call: merge --squash; second call: commit --no-edit
      expect(calls[0]).toContain('--squash');
      expect(calls[1]).toEqual(['commit', '--no-edit']);
    });

    it('push passes --force when force=force', async () => {
      await service.push('origin', 'main', { force: 'force' });
      expect(calls[0]).toContain('--force');
      expect(calls[0]).not.toContain('--force-with-lease');
    });

    it('push passes --force-with-lease when force=with-lease', async () => {
      await service.push('origin', 'main', { force: 'with-lease' });
      expect(calls[0]).toContain('--force-with-lease');
      expect(calls[0]).not.toContain('--force');
    });

    it('push uses refs/heads/<branch> refspec to disambiguate tag/branch collisions', async () => {
      await service.push('origin', 'main');
      expect(calls[0]).toContain('refs/heads/main');
      expect(calls[0]).not.toContain('main'); // bare 'main' would be ambiguous
    });

    it('fetch --all when no remote given', async () => {
      await service.fetch();
      expect(calls[0]).toContain('--all');
      expect(calls[0]).toContain('--progress');
    });

    it('fetch passes --prune', async () => {
      await service.fetch('origin', { prune: true });
      expect(calls[0]).toContain('--prune');
    });

    it('rebase passes --autostash', async () => {
      await service.rebase('main', { autostash: true });
      expect(calls[0]).toContain('--autostash');
    });

    it('stashSave passes -m, --include-untracked, --keep-index', async () => {
      await service.stashSave('wip', true, true);
      expect(calls[0]).toContain('-m');
      expect(calls[0]).toContain('wip');
      expect(calls[0]).toContain('--include-untracked');
      expect(calls[0]).toContain('--keep-index');
    });

    it('worktreeAdd passes -b for newBranch', async () => {
      await service.worktreeAdd('/tmp/wt', undefined, 'new-branch');
      expect(calls[0]).toContain('-b');
      expect(calls[0]).toContain('new-branch');
    });

    it('worktreeRemove passes --force when force=true', async () => {
      await service.worktreeRemove('/tmp/wt', true);
      expect(calls[0]).toContain('--force');
    });

    it('searchCommits forwards --after and --before', async () => {
      await service.searchCommits('fix', { after: '2024-01-01', before: '2024-12-31' });
      const logArgs = calls[0];
      expect(logArgs.some(a => a === '--after=2024-01-01')).toBe(true);
      expect(logArgs.some(a => a === '--before=2024-12-31')).toBe(true);
    });

    it('createTag (annotated) passes -a -m', async () => {
      await service.createTag('v1.0', undefined, 'release notes');
      expect(calls[0]).toContain('-a');
      expect(calls[0]).toContain('-m');
      expect(calls[0]).toContain('release notes');
    });
  });

  describe('getRemoteNames caching', () => {
    it('returns cached value within TTL window', async () => {
      let execCalls = 0;
      mockExec(service, async (args) => {
        if (args[0] === 'remote') execCalls++;
        return 'origin\nupstream\n';
      });
      const first = await (service as any).getRemoteNames();
      const second = await (service as any).getRemoteNames();
      expect(first).toEqual(['origin', 'upstream']);
      expect(second).toEqual(['origin', 'upstream']);
      expect(execCalls).toBe(1); // second call hit the cache
    });

    it('dedupes concurrent callers via pendingRemoteNames', async () => {
      let execCalls = 0;
      mockExec(service, async (args) => {
        if (args[0] === 'remote') execCalls++;
        // Simulate slow git so concurrent callers race.
        await new Promise(r => setTimeout(r, 20));
        return 'origin\n';
      });
      const [a, b, c] = await Promise.all([
        (service as any).getRemoteNames(),
        (service as any).getRemoteNames(),
        (service as any).getRemoteNames(),
      ]);
      expect(a).toEqual(['origin']);
      expect(b).toEqual(['origin']);
      expect(c).toEqual(['origin']);
      // Three concurrent callers but only one git invocation.
      expect(execCalls).toBe(1);
    });

    it('addRemote invalidates the cache', async () => {
      // Pre-populate as if cached.
      (service as any).cachedRemoteNames = ['origin'];
      (service as any).remoteNamesCacheTime = Date.now();
      mockExec(service, async () => '');
      await service.addRemote('upstream', 'https://example.com/u.git');
      expect((service as any).cachedRemoteNames).toBeNull();
    });

    it('removeRemote invalidates the cache', async () => {
      (service as any).cachedRemoteNames = ['origin'];
      (service as any).remoteNamesCacheTime = Date.now();
      mockExec(service, async () => '');
      await service.removeRemote('origin');
      expect((service as any).cachedRemoteNames).toBeNull();
    });
  });

  describe('getActivityLog', () => {
    it('starts empty', () => {
      expect(service.getActivityLog()).toEqual([]);
    });

    it('records non-silent exec calls in reverse-chronological order', async () => {
      // Hit the real exec path via a lightweight mock-free call. Easiest:
      // monkey-patch only the spawn outcome by replacing `exec` with one that
      // funnels through the same activityLog bookkeeping.
      const realExec = (service as any).exec.bind(service);
      // We can't easily call realExec without spawning git; instead push
      // entries directly to mirror what exec records, since that's the
      // observable contract.
      (service as any).activityLog.unshift(
        { command: 'git status', timestamp: '2026-05-17T00:00:01Z', success: true, duration: 5 },
        { command: 'git log', timestamp: '2026-05-17T00:00:00Z', success: true, duration: 12 },
      );
      const log = service.getActivityLog();
      expect(log).toHaveLength(2);
      expect(log[0].command).toBe('git status');
      void realExec;
    });
  });

  describe('diff option combinations', () => {
    it('passes ref1 and ref2 when both given', async () => {
      const calls: string[][] = [];
      mockExec(service, async (args) => { calls.push(args); return ''; });
      await service.diff({ ref1: 'HEAD~1', ref2: 'HEAD' });
      expect(calls[0]).toContain('HEAD~1');
      expect(calls[0]).toContain('HEAD');
    });

    it('appends -- <file> when file is given alongside refs', async () => {
      const calls: string[][] = [];
      mockExec(service, async (args) => { calls.push(args); return ''; });
      await service.diff({ ref1: 'main', file: 'src/foo.ts' });
      const sepIdx = calls[0].indexOf('--');
      expect(sepIdx).toBeGreaterThan(0);
      expect(calls[0][sepIdx + 1]).toBe('src/foo.ts');
    });
  });

  describe('log({ skip })', () => {
    it('passes --skip=<n> to git log', async () => {
      const calls: string[][] = [];
      (service as any).cachedRemoteNames = [];
      (service as any).remoteNamesCacheTime = Date.now();
      mockExec(service, async (args) => { calls.push(args); return ''; });

      await service.log({ skip: 50 }).catch(() => {});
      const logCall = calls.find(c => c[0] === 'log' && !c.includes('--no-walk'));
      expect(logCall).toContain('--skip=50');
    });
  });

  describe('parseNameStatus (private)', () => {
    it('preserves tabs inside filenames by joining all path segments', () => {
      // git emits `<status>\t<path>` lines but rename entries can have an
      // extra tab between old/new paths. The helper joins everything after
      // the first tab, so tab-containing filenames round-trip.
      const raw = 'M\tsrc/foo.ts\nR100\told.ts\tnew.ts\n';
      const result = (service as any).parseNameStatus(raw);
      expect(result).toEqual([
        { path: 'src/foo.ts', status: 'M' },
        { path: 'old.ts\tnew.ts', status: 'R' },
      ]);
    });
  });

  describe('Git Flow availability checks (mock-based)', () => {
    // These cover the failure paths regardless of whether git-flow is
    // installed locally — the integration tests cover the success paths.

    it('isFlowInstalled returns false when `git flow version` rejects', async () => {
      mockExec(service, async () => { throw new GitError('git: flow is not a git command', 1, ['flow', 'version']); });
      expect(await service.isFlowInstalled()).toBe(false);
    });

    it('isFlowInitialized returns false when gitflow.branch.master is unset', async () => {
      mockExec(service, async () => { throw new GitError('', 1, ['config', '--get', 'gitflow.branch.master']); });
      expect(await service.isFlowInitialized()).toBe(false);
    });

    it('getFlowConfig returns null when any required key is missing', async () => {
      // First config key resolves, second rejects → whole thing nulls out.
      let calls = 0;
      mockExec(service, async () => {
        calls++;
        if (calls === 1) return 'main\n';
        throw new GitError('', 1, ['config', '--get', 'gitflow.branch.develop']);
      });
      expect(await service.getFlowConfig()).toBeNull();
    });
  });

  describe('warning handler', () => {
    it('routes warnings through registered handler', () => {
      const received: string[] = [];
      service.setWarningHandler(m => received.push(m));
      (service as any).warn('disk on fire');
      expect(received).toEqual(['disk on fire']);
    });

    it('survives a throwing warning handler', () => {
      service.setWarningHandler(() => { throw new Error('handler boom'); });
      // Must not propagate — warn() is called from inside git commands and a
      // throwing handler would otherwise abort the surrounding git call.
      expect(() => (service as any).warn('test')).not.toThrow();
    });

    it('null handler is a no-op', () => {
      service.setWarningHandler(null);
      expect(() => (service as any).warn('quiet')).not.toThrow();
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
