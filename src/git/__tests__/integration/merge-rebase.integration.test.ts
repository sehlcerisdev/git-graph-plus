import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, currentBranch, head, runGit, seedBranches } from './helpers';

describe('GitService integration — merge / rebase / cherry-pick / revert', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
  });
  afterEach(() => repo.cleanup());

  describe('merge', () => {
    it('fast-forwards when target is ahead of HEAD', async () => {
      const { mainTip, featureTip } = seedBranches(repo.path);
      // main is at mainTip (3rd commit), feature has 2 extra. Reset main to base to allow ff.
      runGit(repo.path, ['reset', '--hard', mainTip]);
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic-only');
      const topicTip = head(repo.path);
      runGit(repo.path, ['checkout', 'main']);

      await svc.merge('topic');
      expect(head(repo.path)).toBe(topicTip);
      void featureTip;
    });

    it('no-ff creates a merge commit even when fast-forward possible', async () => {
      commit(repo.path, 'init');
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic-only');
      const topicTip = head(repo.path);
      runGit(repo.path, ['checkout', 'main']);

      await svc.merge('topic', { noFf: true });
      const newHead = head(repo.path);
      expect(newHead).not.toBe(topicTip);
      // Merge commit has 2 parents
      const parents = runGit(repo.path, ['log', '-1', '--format=%P']).trim().split(/\s+/);
      expect(parents.length).toBe(2);
    });

    it('records an in-progress merge state on conflict', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'left']);
      commit(repo.path, 'left edit', { 'a.txt': 'left\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'right edit', { 'a.txt': 'right\n' });

      await expect(svc.merge('left')).rejects.toThrow();
      const state = await svc.getOperationState();
      expect(state.type).toBe('merge');

      await svc.abortMerge();
      const cleared = await svc.getOperationState();
      expect(cleared.type).toBeNull();
    });
  });

  describe('rebase', () => {
    it('replays HEAD onto target', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n' });
      const baseCommit = head(repo.path);
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic 1', { 't1.txt': '1\n' });
      const topic1 = head(repo.path);
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main 2', { 'm2.txt': '2\n' });
      const mainTip = head(repo.path);

      runGit(repo.path, ['checkout', 'topic']);
      await svc.rebase('main');

      // After rebase: topic's tip parent should be mainTip
      const newParents = runGit(repo.path, ['log', '-1', '--format=%P']).trim().split(/\s+/);
      expect(newParents[0]).toBe(mainTip);
      // Original topic1 commit hash is gone (recomposed)
      expect(head(repo.path)).not.toBe(topic1);
      void baseCommit;
    });

    it('abortRebase restores state on conflict', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic edit', { 'a.txt': 'topic\n' });
      const topicTip = head(repo.path);
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edit', { 'a.txt': 'main\n' });

      runGit(repo.path, ['checkout', 'topic']);
      await expect(svc.rebase('main')).rejects.toThrow();

      const state = await svc.getOperationState();
      expect(state.type).toBe('rebase');

      await svc.abortRebase();
      // After abort, we're back to topic's original tip
      expect(head(repo.path)).toBe(topicTip);
    });
  });

  describe('cherryPick', () => {
    it('applies a commit from another branch', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n' });
      runGit(repo.path, ['checkout', '-b', 'feature']);
      const pickMe = commit(repo.path, 'feature change', { 'feat.txt': 'x\n' });
      runGit(repo.path, ['checkout', 'main']);

      await svc.cherryPick(pickMe);

      const subject = runGit(repo.path, ['log', '-1', '--format=%s']).trim();
      expect(subject).toBe('feature change');
      // The picked file should be present on main now
      expect(readFileSync(join(repo.path, 'feat.txt'), 'utf-8')).toBe('x\n');
    });

    it('with noCommit stages changes without committing', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n' });
      runGit(repo.path, ['checkout', '-b', 'feature']);
      const pickMe = commit(repo.path, 'feature change', { 'feat.txt': 'x\n' });
      runGit(repo.path, ['checkout', 'main']);

      const beforeTip = head(repo.path);
      await svc.cherryPick(pickMe, { noCommit: true });

      expect(head(repo.path)).toBe(beforeTip); // no new commit
      const { staged } = await svc.getUncommittedDiff();
      expect(staged.some(s => s.path === 'feat.txt')).toBe(true);
    });
  });

  describe('revert', () => {
    it('creates an inverse commit', async () => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      const target = commit(repo.path, 'second', { 'a.txt': 'two\n' });

      await svc.revert(target);

      // After revert, a.txt should be back to "one"
      expect(readFileSync(join(repo.path, 'a.txt'), 'utf-8')).toBe('one\n');
      // And a new commit recorded
      const subject = runGit(repo.path, ['log', '-1', '--format=%s']).trim();
      expect(subject).toMatch(/Revert/i);
    });

    it('with noCommit stages the inverse without committing', async () => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      const target = commit(repo.path, 'second', { 'a.txt': 'two\n' });
      const beforeTip = head(repo.path);

      await svc.revert(target, { noCommit: true });

      expect(head(repo.path)).toBe(beforeTip);
      const { staged } = await svc.getUncommittedDiff();
      expect(staged.some(s => s.path === 'a.txt')).toBe(true);
    });
  });

  describe('predictConflicts', () => {
    it('reports no conflict for non-overlapping changes', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n' });
      runGit(repo.path, ['checkout', '-b', 'left']);
      commit(repo.path, 'left adds b', { 'b.txt': 'b\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main adds c', { 'c.txt': 'c\n' });

      const result = await svc.predictConflicts(head(repo.path), 'left');
      expect(result.hasConflict).toBe(false);
      expect(result.files).toEqual([]);
    });

    it('reports conflicting files', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'left']);
      commit(repo.path, 'left edit', { 'a.txt': 'left\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edit', { 'a.txt': 'main\n' });

      const result = await svc.predictConflicts(head(repo.path), 'left');
      expect(result.hasConflict).toBe(true);
      expect(result.files).toContain('a.txt');
    });
  });

  describe('predictRebaseConflicts', () => {
    it('detects conflict when topic edits same file as base advanced', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic edit', { 'a.txt': 'topic\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edit', { 'a.txt': 'main\n' });

      const result = await svc.predictRebaseConflicts('topic', 'main');
      expect(result.hasConflict).toBe(true);
    });

    it('clean rebase reports no conflict', async () => {
      commit(repo.path, 'init', { 'a.txt': 'a\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic adds t', { 't.txt': 't\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main adds m', { 'm.txt': 'm\n' });

      const result = await svc.predictRebaseConflicts('topic', 'main');
      expect(result.hasConflict).toBe(false);
    });

    it('returns no-conflict for a fast-forward (no commits to replay)', async () => {
      // When merge-base equals topic, there are zero commits to rebase, so
      // the function should short-circuit to no-conflict instead of running
      // merge-tree on an empty range.
      commit(repo.path, 'init');
      runGit(repo.path, ['branch', 'topic']);
      // main moves forward; topic stays. From topic's POV the rebase is a no-op.
      commit(repo.path, 'main advance');

      const result = await svc.predictRebaseConflicts('topic', 'main');
      expect(result.hasConflict).toBe(false);
      expect(result.files).toEqual([]);
    });

    it('aggregates conflict files across multiple commits in the topic', async () => {
      // Multi-commit topic with each commit touching a different conflicting
      // file. Verifies the per-commit walk loop merges files into a Set.
      commit(repo.path, 'init', { 'a.txt': 'base\n', 'b.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic edits a', { 'a.txt': 'topic-a\n' });
      commit(repo.path, 'topic edits b', { 'b.txt': 'topic-b\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edits a', { 'a.txt': 'main-a\n' });
      commit(repo.path, 'main edits b', { 'b.txt': 'main-b\n' });

      const result = await svc.predictRebaseConflicts('topic', 'main');
      expect(result.hasConflict).toBe(true);
      // Both files should be reported (deduped via the Set).
      expect(result.files.sort()).toEqual(['a.txt', 'b.txt']);
    });
  });

  describe('getConflictFiles + continueOperation', () => {
    it('lists files with conflict markers during merge', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'left']);
      commit(repo.path, 'left', { 'a.txt': 'left\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'right', { 'a.txt': 'right\n' });

      await expect(svc.merge('left')).rejects.toThrow();
      const conflicts = await svc.getConflictFiles();
      expect(conflicts).toContain('a.txt');

      // resolve and continue
      const { writeFileSync } = await import('fs');
      writeFileSync(join(repo.path, 'a.txt'), 'merged\n');
      await svc.stageFile('a.txt');
      await svc.continueOperation();

      expect(currentBranch(repo.path)).toBe('main');
      expect((await svc.getOperationState()).type).toBeNull();
    });
  });

  describe('log() — stash insertion', () => {
    it('inserts stash entries into the commit list near their base commit', async () => {
      commit(repo.path, 'init', { 'a.txt': 'one\n' });
      const beforeStash = head(repo.path);
      // Dirty the tree and stash
      const { writeFileSync } = await import('fs');
      writeFileSync(`${repo.path}/a.txt`, 'two\n');
      await svc.stashSave('wip-stash-1');

      const commits = await svc.log();
      const stashRow = commits.find(c => c.refs.some(r => r.type === 'stash'));
      expect(stashRow).toBeDefined();
      // Stash's first parent should be the commit it was based on.
      expect(stashRow?.parents).toEqual([beforeStash]);
      // The subject is overridden to the stash message.
      expect(stashRow?.subject).toContain('wip-stash-1');
    });
  });

  describe('interactiveRebase', () => {
    it('reorders commits per the todo list', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      const c1 = commit(repo.path, 'commit A', { 'a.txt': 'A\n' });
      const c2 = commit(repo.path, 'commit B', { 'b.txt': 'B\n' });

      // Reorder: pick B before A
      await svc.interactiveRebase(base, [
        { action: 'pick', hash: c2, subject: 'commit B' },
        { action: 'pick', hash: c1, subject: 'commit A' },
      ]);

      const subjects = runGit(repo.path, ['log', '--format=%s', `${base}..HEAD`])
        .trim().split('\n');
      // git log is reverse-chrono, so newest first
      expect(subjects[0]).toBe('commit A');
      expect(subjects[1]).toBe('commit B');
    });

    it('drops commits marked drop', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      const c1 = commit(repo.path, 'keep me', { 'a.txt': 'A\n' });
      const c2 = commit(repo.path, 'drop me', { 'b.txt': 'B\n' });

      await svc.interactiveRebase(base, [
        { action: 'pick', hash: c1, subject: 'keep me' },
        { action: 'drop', hash: c2, subject: 'drop me' },
      ]);

      const subjects = runGit(repo.path, ['log', '--format=%s', `${base}..HEAD`])
        .trim().split('\n');
      expect(subjects).toEqual(['keep me']);
    });

    it('reword updates the commit message via exec amend', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      const c1 = commit(repo.path, 'old subject', { 'a.txt': 'A\n' });

      await svc.interactiveRebase(base, [
        { action: 'reword', hash: c1, subject: 'old subject', message: 'shiny new subject' },
      ]);

      const subject = runGit(repo.path, ['log', '-1', '--format=%s']).trim();
      expect(subject).toBe('shiny new subject');
    });

    it('squash collapses commits and uses the provided final message', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      const c1 = commit(repo.path, 'A', { 'a.txt': 'A\n' });
      const c2 = commit(repo.path, 'B', { 'b.txt': 'B\n' });
      const c3 = commit(repo.path, 'C', { 'c.txt': 'C\n' });

      await svc.interactiveRebase(base, [
        { action: 'pick', hash: c1, subject: 'A', message: 'combined ABC' },
        { action: 'squash', hash: c2, subject: 'B' },
        { action: 'squash', hash: c3, subject: 'C' },
      ]);

      // All three commits should now be one commit with the supplied message.
      const subjects = runGit(repo.path, ['log', '--format=%s', `${base}..HEAD`])
        .trim().split('\n').filter(Boolean);
      expect(subjects.length).toBe(1);
      expect(subjects[0]).toBe('combined ABC');
    });

    it('fixup discards the squashed commits message (no exec amend)', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      const c1 = commit(repo.path, 'keeper', { 'a.txt': 'A\n' });
      const c2 = commit(repo.path, 'absorbed', { 'b.txt': 'B\n' });

      await svc.interactiveRebase(base, [
        { action: 'pick', hash: c1, subject: 'keeper' },
        { action: 'fixup', hash: c2, subject: 'absorbed' },
      ]);

      const subjects = runGit(repo.path, ['log', '--format=%s', `${base}..HEAD`])
        .trim().split('\n').filter(Boolean);
      expect(subjects.length).toBe(1);
      expect(subjects[0]).toBe('keeper');
    });

    it('rejects when first todo entry is squash', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      const c1 = commit(repo.path, 'A', { 'a.txt': 'A\n' });
      await expect(svc.interactiveRebase(base, [
        { action: 'squash', hash: c1, subject: 'A' },
      ])).rejects.toThrow('cannot be squash or fixup');
    });

    it('rejects invalid hex hash before spawning git', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      await expect(svc.interactiveRebase(base, [
        { action: 'pick', hash: 'not-a-hash', subject: 'x' },
      ])).rejects.toThrow('Invalid commit hash');
    });
  });

  describe('getRebaseCommits', () => {
    it('lists commits that would be rebased onto base', async () => {
      commit(repo.path, 'init');
      const base = head(repo.path);
      commit(repo.path, 'a', { 'a.txt': 'a\n' });
      commit(repo.path, 'b', { 'b.txt': 'b\n' });

      const commits = await svc.getRebaseCommits(base);
      // Two commits between base and HEAD
      expect(commits.length).toBe(2);
      const subjects = commits.map(c => c.subject);
      expect(subjects).toContain('a');
      expect(subjects).toContain('b');
    });

    it('returns empty when HEAD is at base', async () => {
      commit(repo.path, 'only');
      const commits = await svc.getRebaseCommits(head(repo.path));
      expect(commits).toEqual([]);
    });
  });

  describe('rebase state machine — continueRebase / skipRebase', () => {
    it('continueRebase resumes after resolving conflict', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic edit', { 'a.txt': 'topic\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edit', { 'a.txt': 'main\n' });

      runGit(repo.path, ['checkout', 'topic']);
      await expect(svc.rebase('main')).rejects.toThrow();
      expect((await svc.getOperationState()).type).toBe('rebase');

      // Resolve and continue
      const { writeFileSync } = await import('fs');
      writeFileSync(`${repo.path}/a.txt`, 'resolved\n');
      await svc.stageFile('a.txt');
      await svc.continueRebase();

      expect((await svc.getOperationState()).type).toBeNull();
    });

    it('skipRebase drops the offending commit and finishes', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic edit', { 'a.txt': 'topic\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main edit', { 'a.txt': 'main\n' });

      runGit(repo.path, ['checkout', 'topic']);
      await expect(svc.rebase('main')).rejects.toThrow();

      await svc.skipRebase();
      expect((await svc.getOperationState()).type).toBeNull();
    });
  });

  describe('abortOperation (generic)', () => {
    it('aborts a merge in progress', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'left']);
      commit(repo.path, 'left', { 'a.txt': 'left\n' });
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'right', { 'a.txt': 'right\n' });

      await expect(svc.merge('left')).rejects.toThrow();
      expect((await svc.getOperationState()).type).toBe('merge');

      await svc.abortOperation();
      expect((await svc.getOperationState()).type).toBeNull();
    });

    it('aborts a rebase in progress', async () => {
      commit(repo.path, 'init', { 'a.txt': 'base\n' });
      runGit(repo.path, ['checkout', '-b', 'topic']);
      commit(repo.path, 'topic', { 'a.txt': 'topic\n' });
      const topicTip = head(repo.path);
      runGit(repo.path, ['checkout', 'main']);
      commit(repo.path, 'main', { 'a.txt': 'main\n' });

      runGit(repo.path, ['checkout', 'topic']);
      await expect(svc.rebase('main')).rejects.toThrow();
      await svc.abortOperation();
      expect((await svc.getOperationState()).type).toBeNull();
      expect(head(repo.path)).toBe(topicTip);
    });
  });
});
