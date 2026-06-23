import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit } from './helpers';

// Two edits far enough apart (line 2 and line 14) that git keeps them in
// separate hunks rather than merging them.
const BASE_F = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\nlambda\nmu\nnu\nxi\nomicron\npi\n';
const CHANGED_F = 'alpha\nbeta2\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\nlambda\nmu\nnu\nxi2\nomicron\npi\n';
const BASE_G = 'one\ntwo\nthree\nfour\nfive\n';
const CHANGED_G = 'one\ntwo\nINSERTED-A\nINSERTED-B\nthree\nfour\nfive\n';

function read(repo: TempRepo, file: string): string {
  return readFileSync(join(repo.path, file), 'utf-8');
}

describe('GitService integration — revertCommitChanges', () => {
  let repo: TempRepo;
  let svc: GitService;
  let hash: string;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
    commit(repo.path, 'base', { 'f.txt': BASE_F, 'g.txt': BASE_G });
    // One commit touching two files: f.txt with two separated hunks, g.txt
    // with a single pure-addition hunk.
    hash = commit(repo.path, 'change', { 'f.txt': CHANGED_F, 'g.txt': CHANGED_G });
  });
  afterEach(() => repo.cleanup());

  it('reverts a whole file back to its pre-commit state in the working tree', async () => {
    await svc.revertCommitChanges(hash, 'f.txt');
    expect(read(repo, 'f.txt')).toBe(BASE_F);
    // Lands as an unstaged working-tree change, not a commit.
    const status = runGit(repo.path, ['status', '--porcelain', 'f.txt']);
    expect(status.trim()).toBe('M f.txt');
    expect(runGit(repo.path, ['rev-parse', 'HEAD']).trim()).toBe(hash);
  });

  it('reverts a single hunk, leaving the other hunk intact', async () => {
    const diff = (await svc.showCommitDiff(hash, 'f.txt'))[0];
    expect(diff.hunks.length).toBe(2);
    // Hunk 0 covers "beta", hunk 1 covers "xi".
    await svc.revertCommitChanges(hash, 'f.txt', { hunkIndex: 0 });

    const result = read(repo, 'f.txt');
    expect(result).toContain('\nbeta\n'); // hunk 0 reverted
    expect(result).toContain('\nxi2\n'); // hunk 1 untouched
  });

  it('reverts a single added line, leaving its sibling addition intact', async () => {
    const hunk = (await svc.showCommitDiff(hash, 'g.txt'))[0].hunks[0];
    const idxB = hunk.lines.findIndex((l) => l.type === 'add' && l.content === 'INSERTED-B');
    expect(idxB).toBeGreaterThanOrEqual(0);

    await svc.revertCommitChanges(hash, 'g.txt', { hunkIndex: 0, lineIndices: [idxB] });

    const result = read(repo, 'g.txt');
    expect(result).toContain('INSERTED-A');
    expect(result).not.toContain('INSERTED-B');
  });

  it('reverts the addition of a file created by the commit (deletes it)', async () => {
    const added = commit(repo.path, 'add new', { 'new.txt': 'fresh\n' });
    expect(existsSync(join(repo.path, 'new.txt'))).toBe(true);
    await svc.revertCommitChanges(added, 'new.txt');
    // Reversing a file-creation diff removes the file from the working tree.
    expect(existsSync(join(repo.path, 'new.txt'))).toBe(false);
  });

  it('throws when the file was not changed by the commit', async () => {
    await expect(svc.revertCommitChanges(hash, 'does-not-exist.txt')).rejects.toThrow();
  });
});
