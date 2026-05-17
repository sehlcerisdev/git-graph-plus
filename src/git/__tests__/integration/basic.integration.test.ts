import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit, seedBranches } from './helpers';

describe('GitService integration — basic queries', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
  });
  afterEach(() => repo.cleanup());

  describe('log', () => {
    it('returns commits in reverse chronological order', async () => {
      commit(repo.path, 'first', { 'a.txt': '1\n' });
      commit(repo.path, 'second', { 'a.txt': '2\n' });
      const tip = commit(repo.path, 'third', { 'a.txt': '3\n' });

      const commits = await svc.log();
      expect(commits.length).toBeGreaterThanOrEqual(3);
      expect(commits[0].hash).toBe(tip);
      expect(commits[0].subject).toBe('third');
      expect(commits[1].subject).toBe('second');
      expect(commits[2].subject).toBe('first');
    });

    it('respects limit option', async () => {
      for (let i = 0; i < 5; i++) commit(repo.path, `c${i}`);
      const commits = await svc.log({ limit: 2 });
      expect(commits.length).toBeLessThanOrEqual(2);
    });

    it('captures parent relationships across merges', async () => {
      const { mainTip, featureTip } = seedBranches(repo.path);
      runGit(repo.path, ['merge', '--no-ff', '-m', 'merge feature', 'feature']);

      const commits = await svc.log();
      const mergeCommit = commits[0];
      // Merge commit has two parents (main tip + feature tip)
      expect(mergeCommit.parents.length).toBe(2);
      expect(mergeCommit.parents).toContain(mainTip);
      expect(mergeCommit.parents).toContain(featureTip);
    });
  });

  describe('branches', () => {
    it('reports the initial branch with HEAD marker', async () => {
      commit(repo.path, 'init');
      const branches = await svc.branches();
      const current = branches.find(b => b.current);
      expect(current).toBeDefined();
      expect(current?.name).toBe('main');
    });

    it('lists multiple local branches', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['branch', 'feature-a']);
      runGit(repo.path, ['branch', 'feature-b']);
      const branches = await svc.branches();
      const names = branches.map(b => b.name);
      expect(names).toContain('main');
      expect(names).toContain('feature-a');
      expect(names).toContain('feature-b');
    });
  });

  describe('tags', () => {
    it('lists lightweight and annotated tags', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['tag', 'v1.0.0']);
      runGit(repo.path, ['tag', '-a', 'v1.1.0', '-m', 'annotated tag']);
      const tags = await svc.tags();
      const names = tags.map(t => t.name);
      expect(names).toContain('v1.0.0');
      expect(names).toContain('v1.1.0');
    });

    it('returns empty array when no tags', async () => {
      commit(repo.path, 'init');
      const tags = await svc.tags();
      expect(tags).toEqual([]);
    });
  });

  describe('remotes', () => {
    it('returns empty array when no remotes', async () => {
      commit(repo.path, 'init');
      const remotes = await svc.remotes();
      expect(remotes).toEqual([]);
    });

    it('lists configured remotes with URLs', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['remote', 'add', 'origin', 'https://example.com/r.git']);
      runGit(repo.path, ['remote', 'add', 'upstream', 'https://example.com/u.git']);
      const remotes = await svc.remotes();
      expect(remotes.find(r => r.name === 'origin')?.fetchUrl).toContain('example.com/r.git');
      expect(remotes.find(r => r.name === 'upstream')?.fetchUrl).toContain('example.com/u.git');
    });
  });

  describe('isDirty / status', () => {
    it('false when working tree clean', async () => {
      commit(repo.path, 'init');
      expect(await svc.isDirty()).toBe(false);
    });

    it('true when unstaged changes exist', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n' });
      // mutate working tree
      const { writeFileSync } = await import('fs');
      writeFileSync(`${repo.path}/a.txt`, 'mutated\n');
      expect(await svc.isDirty()).toBe(true);
    });

    it('ignores untracked files (matches git status -uno semantics)', async () => {
      commit(repo.path, 'init');
      const { writeFileSync } = await import('fs');
      writeFileSync(`${repo.path}/new.txt`, 'new\n');
      // isDirty is used to block checkout, which git itself permits when only
      // untracked files exist (they don't conflict with switching refs).
      expect(await svc.isDirty()).toBe(false);
    });
  });

  describe('getUncommittedDiff', () => {
    it('separates staged from unstaged changes', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
      const { writeFileSync } = await import('fs');
      writeFileSync(`${repo.path}/a.txt`, 'staged change\n');
      runGit(repo.path, ['add', 'a.txt']);
      writeFileSync(`${repo.path}/b.txt`, 'unstaged change\n');

      const result = await svc.getUncommittedDiff();
      expect(result.staged.map(s => s.path)).toContain('a.txt');
      expect(result.unstaged.map(s => s.path)).toContain('b.txt');
    });
  });

  describe('getReflog', () => {
    it('returns reflog entries with hashes and messages', async () => {
      commit(repo.path, 'first');
      commit(repo.path, 'second');
      runGit(repo.path, ['checkout', '-b', 'feature']);
      commit(repo.path, 'on feature');
      runGit(repo.path, ['checkout', 'main']);

      const { entries } = await svc.getReflog(10);
      expect(entries.length).toBeGreaterThan(0);
      // Most recent should be the checkout back to main
      expect(entries[0].message).toMatch(/checkout|moving from feature/i);
      // Each entry should have a non-empty hash
      for (const e of entries) {
        expect(e.hash).toMatch(/^[0-9a-f]{40}$/);
        expect(e.shortHash.length).toBeGreaterThan(0);
      }
    });

    it('respects the limit parameter', async () => {
      for (let i = 0; i < 10; i++) commit(repo.path, `c${i}`);
      const { entries } = await svc.getReflog(3);
      expect(entries.length).toBeLessThanOrEqual(3);
    });
  });

  describe('diffFiles', () => {
    it('lists files changed between two commits', async () => {
      const c1 = commit(repo.path, 'first', { 'a.txt': 'a\n' });
      commit(repo.path, 'add b', { 'b.txt': 'b\n' });

      const files = await svc.diffFiles(c1, 'HEAD');
      const paths = files.map(f => f.path);
      expect(paths).toContain('b.txt');
    });
  });

  describe('showCommitFiles', () => {
    it('lists files changed in a single commit', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n' });
      const target = commit(repo.path, 'add two', { 'b.txt': 'b\n', 'c.txt': 'c\n' });
      const files = await svc.showCommitFiles(target);
      const paths = files.map(f => f.path);
      expect(paths).toContain('b.txt');
      expect(paths).toContain('c.txt');
    });

    it('falls back to --root for the initial commit (no parent)', async () => {
      // The default `hash^..hash` form fails on a root commit because it has
      // no parent. The diff-tree --root fallback path is what makes the first
      // commit's file list show up in the UI.
      const root = commit(repo.path, 'genesis', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
      const files = await svc.showCommitFiles(root);
      const paths = files.map(f => f.path);
      expect(paths).toContain('a.txt');
      expect(paths).toContain('b.txt');
    });
  });

  describe('showCommitDiff', () => {
    it('returns diff hunks for a commit', async () => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      const target = commit(repo.path, 'modify', { 'a.txt': 'two\n' });

      const diffs = await svc.showCommitDiff(target);
      expect(diffs.length).toBeGreaterThan(0);
      const aDiff = diffs.find(d => d.file === 'a.txt');
      expect(aDiff).toBeDefined();
    });

    it('falls back to git show for the initial commit (no parent)', async () => {
      // Same fallback motivation as showCommitFiles above — `hash^..hash`
      // requires a parent. The git-show form handles the root case.
      const root = commit(repo.path, 'genesis', { 'a.txt': 'one\n' });
      const diffs = await svc.showCommitDiff(root);
      expect(diffs.length).toBeGreaterThan(0);
      expect(diffs[0].file).toBe('a.txt');
    });
  });

  describe('diff (working tree)', () => {
    it('returns empty array when clean', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n' });
      const diffs = await svc.diff();
      expect(diffs).toEqual([]);
    });

    it('reports unstaged file changes', async () => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      const { writeFileSync } = await import('fs');
      writeFileSync(`${repo.path}/a.txt`, 'two\n');
      const diffs = await svc.diff();
      expect(diffs.length).toBeGreaterThan(0);
      expect(diffs[0].file).toBe('a.txt');
    });

    it('filters by file path', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
      const { writeFileSync } = await import('fs');
      writeFileSync(`${repo.path}/a.txt`, 'changed\n');
      writeFileSync(`${repo.path}/b.txt`, 'changed\n');
      const diffs = await svc.diff({ file: 'a.txt' });
      expect(diffs.length).toBe(1);
      expect(diffs[0].file).toBe('a.txt');
    });
  });

  describe('diffCommits', () => {
    it('returns diff between two commits', async () => {
      const c1 = commit(repo.path, 'first', { 'a.txt': 'one\n' });
      const c2 = commit(repo.path, 'second', { 'a.txt': 'two\n' });
      const diffs = await svc.diffCommits(c1, c2);
      expect(diffs.length).toBeGreaterThan(0);
      expect(diffs[0].file).toBe('a.txt');
    });
  });

  describe('diffCommitToWorking', () => {
    it('returns diff between a past commit and current working tree', async () => {
      const c1 = commit(repo.path, 'first', { 'a.txt': 'one\n' });
      commit(repo.path, 'second', { 'a.txt': 'two\n' });
      const { writeFileSync } = await import('fs');
      writeFileSync(`${repo.path}/a.txt`, 'three\n');

      const diffs = await svc.diffCommitToWorking(c1);
      // Should reflect both the c2 change and the unstaged change vs c1.
      expect(diffs.length).toBeGreaterThan(0);
      expect(diffs[0].file).toBe('a.txt');
    });
  });

  describe('getUncommittedFileDiff', () => {
    it('returns staged diff when staged=true', async () => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      const { writeFileSync } = await import('fs');
      writeFileSync(`${repo.path}/a.txt`, 'two\n');
      runGit(repo.path, ['add', 'a.txt']);

      const staged = await svc.getUncommittedFileDiff('a.txt', true);
      expect(staged).not.toBeNull();
      expect(staged?.file).toBe('a.txt');

      // unstaged view should be empty since we already staged
      const unstaged = await svc.getUncommittedFileDiff('a.txt', false);
      expect(unstaged?.hunks.length ?? 0).toBe(0);
    });

    it('returns full diff for new untracked file', async () => {
      commit(repo.path, 'init');
      const { writeFileSync } = await import('fs');
      writeFileSync(`${repo.path}/new.txt`, 'hello\n');
      const diff = await svc.getUncommittedFileDiff('new.txt', false);
      expect(diff).not.toBeNull();
      expect(diff?.file).toContain('new.txt');
    });
  });

  describe('isRemoteBranch', () => {
    it('returns true for refs prefixed with a known remote', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['remote', 'add', 'origin', 'https://example.com/r.git']);
      // Manually create a fake remote tracking ref
      runGit(repo.path, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      expect(await svc.isRemoteBranch('origin/main')).toBe(true);
    });

    it('returns false for plain branch names', async () => {
      commit(repo.path, 'init');
      expect(await svc.isRemoteBranch('main')).toBe(false);
    });

    it('returns false when no slash', async () => {
      commit(repo.path, 'init');
      expect(await svc.isRemoteBranch('anything')).toBe(false);
    });
  });

  describe('getRemoteUrl', () => {
    it('returns the configured fetch URL', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['remote', 'add', 'origin', 'https://example.com/r.git']);
      const url = await svc.getRemoteUrl('origin');
      expect(url).toBe('https://example.com/r.git');
    });

    it('throws for an unknown remote', async () => {
      commit(repo.path, 'init');
      await expect(svc.getRemoteUrl('nope')).rejects.toThrow();
    });
  });

  describe('formatPatch', () => {
    it('returns a unified patch for a commit', async () => {
      commit(repo.path, 'init');
      const target = commit(repo.path, 'add file', { 'a.txt': 'a\n' });
      const patch = await svc.formatPatch(target);
      expect(patch).toContain('From ' + target);
      expect(patch).toContain('Subject: [PATCH] add file');
      expect(patch).toContain('+a');
    });
  });

  describe('getImageBase64', () => {
    it('round-trips a binary file through git show', async () => {
      // A small PNG-shaped byte buffer is enough; we only care about
      // base64 round-trip integrity, not image validity.
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
      const { writeFileSync } = await import('fs');
      writeFileSync(`${repo.path}/icon.png`, bytes);
      runGit(repo.path, ['add', 'icon.png']);
      runGit(repo.path, ['commit', '-m', 'add icon']);

      const b64 = await svc.getImageBase64('HEAD', 'icon.png');
      expect(Buffer.from(b64, 'base64').equals(bytes)).toBe(true);
    });

    it('throws GitError when file does not exist at the ref', async () => {
      commit(repo.path, 'init');
      await expect(svc.getImageBase64('HEAD', 'missing.png')).rejects.toThrow();
    });
  });

  describe('lsTree', () => {
    it('lists top-level entries at a ref', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
      const entries = await svc.lsTree('HEAD');
      const names = entries.map(e => e.name);
      expect(names).toContain('a.txt');
      expect(names).toContain('b.txt');
      expect(entries.every(e => e.type === 'blob' || e.type === 'tree')).toBe(true);
    });

    it('descends into subdirectories', async () => {
      commit(repo.path, 'init', { 'src/x.ts': 'x\n', 'src/y.ts': 'y\n' });
      const entries = await svc.lsTree('HEAD');
      const src = entries.find(e => e.name === 'src');
      expect(src?.type).toBe('tree');
    });
  });
});
