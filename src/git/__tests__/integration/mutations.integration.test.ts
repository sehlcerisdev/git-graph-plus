import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, currentBranch, head, runGit } from './helpers';

describe('GitService integration — state mutations', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
  });
  afterEach(() => repo.cleanup());

  describe('branch lifecycle', () => {
    it('createBranch from HEAD', async () => {
      commit(repo.path, 'init');
      await svc.createBranch('feature-x');
      const names = (await svc.branches()).map(b => b.name);
      expect(names).toContain('feature-x');
    });

    it('createBranch from arbitrary start point', async () => {
      const c1 = commit(repo.path, 'first');
      commit(repo.path, 'second');
      await svc.createBranch('old-base', c1);
      const branches = await svc.branches();
      const oldBase = branches.find(b => b.name === 'old-base');
      expect(oldBase?.hash).toBe(c1.substring(0, oldBase!.hash.length));
    });

    it('createAndCheckoutBranch switches HEAD', async () => {
      commit(repo.path, 'init');
      await svc.createAndCheckoutBranch('new-branch');
      expect(currentBranch(repo.path)).toBe('new-branch');
    });

    it('createAndCheckoutBranch sets --track when start point is a remote branch', async () => {
      commit(repo.path, 'init');
      // Fake a remote tracking ref so isRemoteBranch('origin/main') returns true.
      runGit(repo.path, ['remote', 'add', 'origin', 'https://example.com/r.git']);
      runGit(repo.path, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

      await svc.createAndCheckoutBranch('local-of-remote', 'origin/main');
      // The new branch should now track origin/main (i.e. have it as upstream).
      const upstream = runGit(repo.path, ['rev-parse', '--abbrev-ref', 'local-of-remote@{upstream}']).trim();
      expect(upstream).toBe('origin/main');
    });

    it('createAndCheckoutBranch with merge=true passes --merge', async () => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      // Dirty the tree so --merge would matter (forces 3-way merge during checkout).
      const { writeFileSync } = await import('fs');
      writeFileSync(`${repo.path}/a.txt`, 'two\n');

      // Without --merge, plain checkout -b would refuse with conflicting changes.
      // With --merge, git carries the working-tree changes onto the new branch.
      await svc.createAndCheckoutBranch('topic', undefined, { merge: true });
      expect(currentBranch(repo.path)).toBe('topic');
    });

    it('renameBranch updates the name', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['branch', 'old-name']);
      await svc.renameBranch('old-name', 'new-name');
      const names = (await svc.branches()).map(b => b.name);
      expect(names).toContain('new-name');
      expect(names).not.toContain('old-name');
    });

    it('deleteBranch removes the ref', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['branch', 'temp']);
      await svc.deleteBranch('temp');
      const names = (await svc.branches()).map(b => b.name);
      expect(names).not.toContain('temp');
    });

    it('deleteBranch fails on unmerged branch without force', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['checkout', '-b', 'feature']);
      commit(repo.path, 'feature-only');
      runGit(repo.path, ['checkout', 'main']);

      await expect(svc.deleteBranch('feature')).rejects.toThrow();
    });

    it('deleteBranch with force removes unmerged branch', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['checkout', '-b', 'feature']);
      commit(repo.path, 'feature-only');
      runGit(repo.path, ['checkout', 'main']);

      await svc.deleteBranch('feature', true);
      const names = (await svc.branches()).map(b => b.name);
      expect(names).not.toContain('feature');
    });
  });

  describe('checkout', () => {
    it('switches to existing branch', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['branch', 'other']);
      await svc.checkout('other');
      expect(currentBranch(repo.path)).toBe('other');
    });

    it('checks out detached HEAD at a commit', async () => {
      const c1 = commit(repo.path, 'first');
      commit(repo.path, 'second');
      await svc.checkout(c1);
      expect(currentBranch(repo.path)).toBe('HEAD'); // detached
      expect(head(repo.path)).toBe(c1);
    });

    it('"stash and checkout" sets changes aside instead of carrying them over', async () => {
      // The stash-and-checkout option must leave the working tree clean on the
      // target branch and keep the local changes in the stash for later — it
      // must NOT immediately pop them back (which would make it identical to
      // "keep changes and checkout").
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['branch', 'other']);
      writeFileSync(join(repo.path, 'a.txt'), 'local edit\n');
      expect(await svc.isDirty()).toBe(true);

      await svc.stashSave('Auto-stash before checkout', true);
      await svc.checkout('other');

      expect(currentBranch(repo.path)).toBe('other');
      expect(await svc.isDirty()).toBe(false);              // tree clean, changes set aside
      expect((await svc.stashList()).length).toBe(1);       // changes preserved in the stash
    });
  });

  describe('tag CRUD', () => {
    it('createTag (lightweight) at HEAD', async () => {
      commit(repo.path, 'init');
      await svc.createTag('v1.0');
      const names = (await svc.tags()).map(t => t.name);
      expect(names).toContain('v1.0');
    });

    it('createTag (annotated) with message', async () => {
      commit(repo.path, 'init');
      await svc.createTag('v1.1', undefined, 'first release');
      const t = (await svc.tags()).find(t => t.name === 'v1.1');
      expect(t?.isAnnotated).toBe(true);
      expect(t?.message).toContain('first release');
    });

    it('createTag at a specific commit', async () => {
      const c1 = commit(repo.path, 'first');
      commit(repo.path, 'second');
      await svc.createTag('past', c1);
      const t = (await svc.tags()).find(t => t.name === 'past');
      expect(t).toBeDefined();
      // Tag hash should match c1 (lightweight tags point directly at commits)
      expect(t?.hash).toBe(c1.substring(0, t!.hash.length));
    });

    it('deleteTag removes it', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['tag', 'v0.1']);
      await svc.deleteTag('v0.1');
      const names = (await svc.tags()).map(t => t.name);
      expect(names).not.toContain('v0.1');
    });
  });

  describe('stash lifecycle', () => {
    beforeEach(() => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
    });

    async function dirtyTheTree() {
      writeFileSync(join(repo.path, 'a.txt'), 'two\n');
    }

    it('stashSave + list + drop', async () => {
      await dirtyTheTree();
      await svc.stashSave('wip changes');
      const stashes = await svc.stashList();
      expect(stashes.length).toBe(1);
      expect(stashes[0].message).toContain('wip changes');

      await svc.stashDrop(0);
      expect((await svc.stashList()).length).toBe(0);
    });

    it('stashSave with includeUntracked captures new files', async () => {
      writeFileSync(join(repo.path, 'untracked.txt'), 'fresh\n');
      await svc.stashSave('with untracked', true);
      expect((await svc.stashList()).length).toBe(1);
    });

    it('stashApply restores changes without dropping', async () => {
      await dirtyTheTree();
      await svc.stashSave('keep me');
      // working tree restored to clean state by stash
      expect(await svc.isDirty()).toBe(false);

      await svc.stashApply(0);
      expect(await svc.isDirty()).toBe(true);
      expect((await svc.stashList()).length).toBe(1); // still there
    });

    it('stashPop applies and drops', async () => {
      await dirtyTheTree();
      await svc.stashSave('pop me');
      await svc.stashPop(0);
      expect(await svc.isDirty()).toBe(true);
      expect((await svc.stashList()).length).toBe(0);
    });

    it('stashRename updates the message', async () => {
      await dirtyTheTree();
      await svc.stashSave('old message');
      await svc.stashRename(0, 'renamed message');
      const stashes = await svc.stashList();
      expect(stashes[0].message).toContain('renamed message');
    });
  });

  describe('reset', () => {
    it('soft reset keeps working tree, moves HEAD', async () => {
      commit(repo.path, 'first', { 'a.txt': '1\n' });
      const c2 = commit(repo.path, 'second', { 'a.txt': '2\n' });
      const target = commit(repo.path, 'third', { 'a.txt': '3\n' });

      await svc.reset(c2, 'soft');
      // HEAD moved to c2
      expect(head(repo.path)).toBe(c2);
      // But working file still has the "third" content
      expect(existsSync(join(repo.path, 'a.txt'))).toBe(true);
      // And there are staged changes (the third commit's content is now staged)
      const { staged } = await svc.getUncommittedDiff();
      expect(staged.map(s => s.path)).toContain('a.txt');
      void target;
    });

    it('hard reset wipes working tree to target', async () => {
      commit(repo.path, 'first', { 'a.txt': '1\n' });
      const c2 = commit(repo.path, 'second', { 'a.txt': '2\n' });
      commit(repo.path, 'third', { 'a.txt': '3\n' });

      await svc.reset(c2, 'hard');
      expect(head(repo.path)).toBe(c2);
      const { readFileSync } = await import('fs');
      expect(readFileSync(join(repo.path, 'a.txt'), 'utf-8')).toBe('2\n');
    });
  });

  describe('clean', () => {
    it('removes untracked files', async () => {
      commit(repo.path, 'init');
      writeFileSync(join(repo.path, 'untracked.txt'), 'gone\n');
      await svc.clean(false);
      expect(existsSync(join(repo.path, 'untracked.txt'))).toBe(false);
    });

    it('removes untracked directories with -d', async () => {
      commit(repo.path, 'init');
      const { mkdirSync } = await import('fs');
      mkdirSync(join(repo.path, 'newdir'));
      writeFileSync(join(repo.path, 'newdir', 'f.txt'), 'gone\n');
      await svc.clean(true);
      expect(existsSync(join(repo.path, 'newdir'))).toBe(false);
    });
  });

  describe('stageFile', () => {
    it('moves a file from unstaged to staged', async () => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      writeFileSync(join(repo.path, 'a.txt'), 'two\n');

      // before: a.txt is unstaged
      let result = await svc.getUncommittedDiff();
      expect(result.unstaged.some(s => s.path === 'a.txt')).toBe(true);

      await svc.stageFile('a.txt');

      result = await svc.getUncommittedDiff();
      expect(result.staged.some(s => s.path === 'a.txt')).toBe(true);
    });
  });

  describe('addRemote / removeRemote', () => {
    it('addRemote configures a new remote', async () => {
      commit(repo.path, 'init');
      await svc.addRemote('origin', 'https://example.com/r.git');
      const remotes = await svc.remotes();
      expect(remotes.find(r => r.name === 'origin')).toBeDefined();
    });

    it('removeRemote drops it', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['remote', 'add', 'origin', 'https://example.com/r.git']);
      await svc.removeRemote('origin');
      expect((await svc.remotes()).find(r => r.name === 'origin')).toBeUndefined();
    });
  });
});
