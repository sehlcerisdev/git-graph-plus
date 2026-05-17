import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, head, runGit } from './helpers';

describe('GitService integration — remote operations (local bare)', () => {
  let workRepo: TempRepo;
  let bareRepo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    workRepo = createTempRepo();
    bareRepo = createTempRepo({ bare: true });
    svc = new GitService(workRepo.path);
    // Seed local with a commit and point its origin at the bare repo.
    commit(workRepo.path, 'init', { 'a.txt': 'a\n' });
    runGit(workRepo.path, ['remote', 'add', 'origin', bareRepo.path]);
  });
  afterEach(() => {
    workRepo.cleanup();
    bareRepo.cleanup();
  });

  describe('push / fetch / pull round-trip', () => {
    it('push uploads commits to bare and sets upstream', async () => {
      await svc.push('origin', 'main', { setUpstream: true });

      // The bare repo's main ref now points at our HEAD.
      const bareHead = runGit(bareRepo.path, ['rev-parse', 'refs/heads/main']).trim();
      expect(bareHead).toBe(head(workRepo.path));
    });

    it('fetch downloads new commits from another clone', async () => {
      // First push from work → bare
      await svc.push('origin', 'main', { setUpstream: true });

      // Set up a second clone, commit there, push back to bare
      const otherRepo = createTempRepo();
      try {
        runGit(otherRepo.path, ['remote', 'add', 'origin', bareRepo.path]);
        runGit(otherRepo.path, ['fetch', 'origin']);
        runGit(otherRepo.path, ['checkout', '-b', 'main', 'origin/main']);
        commit(otherRepo.path, 'from other', { 'b.txt': 'b\n' });
        const otherHead = head(otherRepo.path);
        runGit(otherRepo.path, ['push', 'origin', 'main']);

        // Now fetch from our service
        await svc.fetch('origin');

        // origin/main should now reference the new commit
        const refSha = runGit(workRepo.path, ['rev-parse', 'refs/remotes/origin/main']).trim();
        expect(refSha).toBe(otherHead);
      } finally {
        otherRepo.cleanup();
      }
    });

    it('pull --rebase replays local commits on top of fetched remote', async () => {
      await svc.push('origin', 'main', { setUpstream: true });

      // Make a divergent commit elsewhere and push it to bare
      const otherRepo = createTempRepo();
      try {
        runGit(otherRepo.path, ['remote', 'add', 'origin', bareRepo.path]);
        runGit(otherRepo.path, ['fetch', 'origin']);
        runGit(otherRepo.path, ['checkout', '-b', 'main', 'origin/main']);
        commit(otherRepo.path, 'upstream change', { 'upstream.txt': 'u\n' });
        runGit(otherRepo.path, ['push', 'origin', 'main']);

        // Local-only commit
        commit(workRepo.path, 'local change', { 'local.txt': 'l\n' });

        await svc.pull('origin', 'main', { rebase: true });

        // Both files should now be present on local, in a linear history
        expect(existsSync(join(workRepo.path, 'upstream.txt'))).toBe(true);
        expect(existsSync(join(workRepo.path, 'local.txt'))).toBe(true);
        const parents = runGit(workRepo.path, ['log', '-1', '--format=%P']).trim().split(/\s+/);
        expect(parents.length).toBe(1); // linear, no merge commit
      } finally {
        otherRepo.cleanup();
      }
    });
  });

  describe('tag push / delete', () => {
    it('pushTag uploads a tag to the remote', async () => {
      await svc.push('origin', 'main', { setUpstream: true });
      runGit(workRepo.path, ['tag', 'v1.0']);
      await svc.pushTag('v1.0', 'origin');

      const remoteTag = runGit(bareRepo.path, ['rev-parse', 'refs/tags/v1.0']).trim();
      expect(remoteTag).toBe(head(workRepo.path));
    });

    it('deleteRemoteTag removes the remote tag', async () => {
      await svc.push('origin', 'main', { setUpstream: true });
      runGit(workRepo.path, ['tag', 'v0.1']);
      await svc.pushTag('v0.1', 'origin');

      await svc.deleteRemoteTag('v0.1', 'origin');
      const refs = runGit(bareRepo.path, ['for-each-ref', 'refs/tags']).trim();
      expect(refs).not.toContain('v0.1');
    });

    it('pushAllTags uploads every local tag', async () => {
      await svc.push('origin', 'main', { setUpstream: true });
      runGit(workRepo.path, ['tag', 'v0.1']);
      runGit(workRepo.path, ['tag', 'v0.2']);

      await svc.pushAllTags('origin');
      const remoteTags = runGit(bareRepo.path, ['for-each-ref', '--format=%(refname:short)', 'refs/tags']).trim();
      expect(remoteTags).toContain('v0.1');
      expect(remoteTags).toContain('v0.2');
    });
  });

  describe('deleteRemoteBranch', () => {
    it('removes a branch from the remote', async () => {
      await svc.push('origin', 'main', { setUpstream: true });
      runGit(workRepo.path, ['checkout', '-b', 'feature']);
      commit(workRepo.path, 'feature commit', { 'f.txt': 'f\n' });
      await svc.push('origin', 'feature', { setUpstream: true });

      await svc.deleteRemoteBranch('feature', 'origin');
      const refs = runGit(bareRepo.path, ['for-each-ref', 'refs/heads']).trim();
      expect(refs).not.toContain('feature');
    });
  });

  describe('setUpstream', () => {
    it('configures upstream tracking', async () => {
      await svc.push('origin', 'main', { setUpstream: true });
      runGit(workRepo.path, ['checkout', '-b', 'topic']);
      // push topic without -u first so we can test setUpstream() afterwards
      runGit(workRepo.path, ['push', 'origin', 'topic']);

      await svc.setUpstream('topic', 'origin', 'topic');

      const upstream = runGit(workRepo.path, ['rev-parse', '--abbrev-ref', 'topic@{upstream}']).trim();
      expect(upstream).toBe('origin/topic');
    });
  });
});

describe('GitService integration — worktrees', () => {
  let mainRepo: TempRepo;
  let svc: GitService;
  let extraPaths: string[] = [];

  beforeEach(() => {
    mainRepo = createTempRepo();
    svc = new GitService(mainRepo.path);
    commit(mainRepo.path, 'init', { 'a.txt': 'a\n' });
    extraPaths = [];
  });
  afterEach(() => {
    // Worktrees living outside mainRepo.path need explicit cleanup.
    for (const p of extraPaths) {
      try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    mainRepo.cleanup();
  });

  function siblingPath(name: string): string {
    // place the worktree as a sibling of the main repo so it's still cleaned up
    // by the harness's tmpdir teardown but doesn't sit inside the repo itself.
    const p = `${mainRepo.path}-${name}`;
    extraPaths.push(p);
    return p;
  }

  describe('worktreeList', () => {
    it('returns the main worktree initially', async () => {
      const list = await svc.worktreeList();
      expect(list.length).toBe(1);
      expect(list[0].isMain).toBe(true);
    });
  });

  describe('worktreeAdd / worktreeRemove', () => {
    it('adds a new worktree on a new branch', async () => {
      const wtPath = siblingPath('wt1');
      await svc.worktreeAdd(wtPath, undefined, 'feature-wt');

      const list = await svc.worktreeList();
      expect(list.length).toBe(2);
      const newWt = list.find(w => !w.isMain);
      expect(newWt).toBeDefined();
      expect(newWt?.branch).toContain('feature-wt');
      expect(existsSync(wtPath)).toBe(true);

      // Branch is now reported by branches()
      const branchNames = (await svc.branches()).map(b => b.name);
      expect(branchNames).toContain('feature-wt');
    });

    it('worktreeRemove drops it', async () => {
      const wtPath = siblingPath('wt2');
      await svc.worktreeAdd(wtPath, undefined, 'feature-wt');
      await svc.worktreeRemove(wtPath);

      const list = await svc.worktreeList();
      expect(list.length).toBe(1);
      expect(existsSync(wtPath)).toBe(false);
    });

    it('worktreePrune cleans up missing worktree metadata', async () => {
      const wtPath = siblingPath('wt3');
      await svc.worktreeAdd(wtPath, undefined, 'feature-wt');

      // Delete the worktree directory out from under git, then prune.
      rmSync(wtPath, { recursive: true, force: true });
      await svc.worktreePrune();

      const list = await svc.worktreeList();
      expect(list.length).toBe(1); // only main remains
    });
  });
});
