// Portable git-operation message dispatcher.
//
// Contains the body of MainPanel's former handleMessage() switch, with every
// vscode.* touchpoint replaced by a DispatcherHost call. MUST NOT import
// `vscode` — it is shared by the VS Code panel and a future standalone web
// server. Keep the case order identical to upstream MainPanel.handleMessage so
// upstream edits are mechanical to forward-port.

import * as path from 'path';
import { readFile } from 'fs/promises';
import { GitService, GitError } from '../git/git-service';
import { formatGitError, isAuthFailure, transportFromRemoteUrl } from '../git/git-error-formatter';
import { splitUpstreamRef } from '../git/git-parser';
import { buildFullGraph } from '../git/git-graph-builder';
import type { WebviewMessage } from '../utils/message-bus';
import {
  resolveRepoRelativePath as resolveRepoRelativePathUtil,
  assertSafeArgPath as assertSafeArgPathUtil,
} from '../utils/path-validation';
import { SequenceGuard } from '../utils/sequence-guard';
import type { DispatcherHost } from './dispatcher-host';

export class GitDispatcher {
  // Two independent guards: selecting a commit (loads its file list) and
  // selecting a file (loads that file's diff) are different axes, so a file
  // request must not invalidate a pending commit-files request and vice versa.
  // getFileDiff and getUncommittedFileDiff share `fileDiffSequence` because
  // both deliver `fileDiffData` to the same panel — a newer file selection
  // should supersede an older one regardless of committed/uncommitted source.
  private commitFilesSequence = new SequenceGuard();
  private fileDiffSequence = new SequenceGuard();
  private multiCommitSectionsSequence = new SequenceGuard();
  private logSequence = 0;
  private searchSequence = 0;

  constructor(
    private gitService: GitService,
    private readonly host: DispatcherHost,
  ) {}

  /** Update the GitService after a repo switch (host owns repo lifecycle). */
  public setGitService(svc: GitService): void {
    this.gitService = svc;
  }

  private get repoPath(): string {
    return this.host.getRepoPath();
  }

  private resolveRepoRelativePath(rel: unknown, op: string): string {
    return resolveRepoRelativePathUtil(this.repoPath, rel, op);
  }

  private assertSafeArgPath(p: unknown, op: string): string {
    return assertSafeArgPathUtil(p, op);
  }

  // Loose like MainPanel's former post(): some payloads (e.g. fileDiffData's
  // `key`) are wider than the ExtensionMessage union; the webview tolerates the
  // extra fields. Cast at the host boundary rather than narrowing every payload.
  private post(msg: unknown): void {
    this.host.post(msg as Parameters<DispatcherHost['post']>[0]);
  }

  public async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'getLog': {
          const sortOrder = this.host.getConfig().graphSortOrder;
          const requestedLimit = message.payload.limit ?? 1000;
          this.host.state.currentLimit = requestedLimit;
          const saved = this.host.getSavedFilters();
          // On first load, apply saved filter if the webview didn't specify one.
          const effectiveFilter = this.host.state.isFirstGetLog && message.payload.remoteFilter === undefined
            ? saved.remoteFilter
            : message.payload.remoteFilter;
          const effectiveBranchFilter = this.host.state.isFirstGetLog && message.payload.branches === undefined
            ? saved.branchFilter
            : message.payload.branches;
          this.host.state.isFirstGetLog = false;
          this.host.state.currentRemoteFilter = effectiveFilter;
          this.host.state.currentBranchFilter = effectiveBranchFilter;
          const logPayload = { ...message.payload, remoteFilter: effectiveFilter, branches: effectiveBranchFilter, limit: requestedLimit + 1, sortOrder };
          const seq = ++this.logSequence;
          const [allFetched, logBranches] = await Promise.all([
            this.gitService.log(logPayload),
            this.gitService.branches(),
          ]);
          if (seq !== this.logSequence) break;
          const hasMore = allFetched.length > requestedLimit;
          const commits = hasMore ? allFetched.slice(0, requestedLimit) : allFetched;
          const fullGraph = commits.length > 0 ? buildFullGraph(commits, logBranches) : { paths: [], links: [], dots: [], commitLeftMargin: [] };
          this.post({
            type: 'logData',
            payload: {
              commits,
              hasMore,
              currentLimit: requestedLimit,
              // The webview renders from paths/links/dots; the legacy GraphNode[] is
              // unused, so we skip building and sending it (saves CPU + IPC payload).
              graph: [],
              paths: fullGraph.paths,
              links: fullGraph.links,
              dots: fullGraph.dots,
              commitLeftMargin: fullGraph.commitLeftMargin,
              remoteFilter: effectiveFilter,
              branches: effectiveBranchFilter,
            },
          });
          break;
        }
        case 'getBranches': {
          const [branches, tags, remotes, stashes, worktrees] = await Promise.all([
            this.gitService.branches(),
            this.gitService.tags(),
            this.gitService.remotes(),
            this.gitService.stashList(),
            this.gitService.worktreeList(),
          ]);
          this.post({
            type: 'branchData',
            payload: { branches, tags, remotes, stashes, worktrees },
          });
          this.host.processPendingModal();
          break;
        }
        case 'getRepoList': {
          await this.host.sendRepoList(true);
          break;
        }
        case 'getCommitDiff': {
          // Guard against rapid clicks on different commits: only the most
          // recently requested file list is delivered to the webview.
          const ticket = this.commitFilesSequence.issue();
          const commitFiles = await this.gitService.showCommitFiles(message.payload.hash);
          if (!this.commitFilesSequence.isCurrent(ticket)) break;
          this.post({
            type: 'commitDiffData',
            payload: { hash: message.payload.hash, files: commitFiles },
          });
          break;
        }
        case 'getFileDiff': {
          const ticket = this.fileDiffSequence.issue();
          const diffs = await this.gitService.showCommitDiff(message.payload.hash, message.payload.file);
          if (!this.fileDiffSequence.isCurrent(ticket)) break;
          this.post({
            type: 'fileDiffData',
            payload: { hash: message.payload.hash, file: message.payload.file, diff: diffs[0] || null },
          });
          break;
        }
        case 'getMultiCommitSections': {
          const ticket = this.multiCommitSectionsSequence.issue();
          const result = await this.gitService.multiCommitSections(message.payload.hashes);
          if (!this.multiCommitSectionsSequence.isCurrent(ticket)) break;
          this.post({
            type: 'multiCommitSectionsData',
            payload: {
              files: result.files.map(f => ({ path: f.path, status: f.status })),
              sections: result.sections,
            },
          });
          break;
        }
        case 'checkDirty': {
          const dirty = await this.gitService.isDirty();
          this.post({ type: 'dirtyState', payload: { dirty, requestId: message.payload?.requestId } });
          break;
        }
        case 'getUncommittedDiff': {
          const result = await this.gitService.getUncommittedDiff();
          this.post({ type: 'uncommittedDiffData', payload: result });
          break;
        }
        case 'getUncommittedFileDiff': {
          // Same guard as getFileDiff: rapid switching between uncommitted files
          // must not let a slow earlier diff overwrite the current selection.
          const ticket = this.fileDiffSequence.issue();
          const diff = await this.gitService.getUncommittedFileDiff(message.payload.file, message.payload.staged);
          if (!this.fileDiffSequence.isCurrent(ticket)) break;
          const key = (message.payload.staged ? 'staged' : 'unstaged') + ':' + message.payload.file;
          this.post({ type: 'fileDiffData', payload: { hash: 'UNCOMMITTED', file: message.payload.file, key, diff } });
          break;
        }
        case 'predictConflicts': {
          const result = message.payload.mode === 'rebase'
            ? await this.gitService.predictRebaseConflicts(message.payload.ours, message.payload.theirs)
            : await this.gitService.predictConflicts(message.payload.ours, message.payload.theirs, message.payload.mergeBase);
          this.post({
            type: 'conflictPrediction',
            payload: { ...result, requestId: message.payload.requestId },
          });
          break;
        }
        case 'checkout': {
          // "Stash and checkout" sets the local changes aside and leaves them
          // in the stash — it must not pop them back, which would carry them
          // onto the target branch (identical to "keep changes and checkout").
          if (message.payload.stash) {
            await this.gitService.stashSave('Auto-stash before checkout', message.payload.stashUntracked);
          }
          if (message.payload.clean) {
            await this.gitService.clean();
          }
          await this.gitService.checkout(message.payload.ref, { force: message.payload.force, merge: message.payload.merge });
          if (message.payload.pullAfter) {
            await this.gitService.pull();
          }
          this.post({
            type: 'operationComplete',
            payload: { operation: 'checkout', success: true },
          });
          const checkedOutRef = /^[0-9a-f]{40}$/i.test(message.payload.ref) ? message.payload.ref.substring(0, 7) : message.payload.ref;
          this.host.showInfo(this.host.t('checkedOut', checkedOutRef));
          if (message.payload.stash) {
            this.host.showInfo(this.host.t('changesStashed'));
          }
          await this.host.refreshAll();
          break;
        }
        case 'createBranch': {
          if (message.payload.checkout) {
            // Same as checkout: stashing sets changes aside; do not pop them back.
            if (message.payload.stash) {
              await this.gitService.stashSave('Auto-stash before checkout', message.payload.stashUntracked);
            }
            if (message.payload.clean) {
              await this.gitService.clean();
            }
            await this.gitService.createAndCheckoutBranch(message.payload.name, message.payload.startPoint, { merge: message.payload.merge });
          } else {
            await this.gitService.createBranch(message.payload.name, message.payload.startPoint);
          }
          // Optional follow-up: publish the new branch to the default remote
          // with -u. Non-fatal — the branch already exists locally.
          if (message.payload.publish) {
            try {
              await this.gitService.publishBranch(message.payload.name);
            } catch (err) {
              this.post({ type: 'error', payload: { message: this.host.t('publishBranchFailed', message.payload.name, err instanceof Error ? err.message : String(err)) } });
            }
          }
          this.post({
            type: 'operationComplete',
            payload: { operation: 'createBranch', success: true },
          });
          this.host.showInfo(this.host.t(
            message.payload.checkout ? 'branchCreatedAndCheckedOut' : 'branchCreated',
            message.payload.name,
          ));
          if (message.payload.checkout && message.payload.stash) {
            this.host.showInfo(this.host.t('changesStashed'));
          }
          await this.host.refreshAll();
          break;
        }
        case 'deleteBranch': {
          // Remove linked worktree first (branch can't be deleted while in use by a worktree)
          if (message.payload.worktreePath) {
            await this.gitService.worktreeRemove(message.payload.worktreePath, true);
          }
          await this.gitService.deleteBranch(message.payload.name, message.payload.force);
          // Delete remote branch if requested
          if (message.payload.deleteRemote) {
            const branches = await this.gitService.branches();
            const localInfo = branches.find(b => !b.remote && b.name === message.payload.name);
            if (localInfo?.upstream) {
              const { remote, branch } = splitUpstreamRef(localInfo.upstream);
              await this.gitService.deleteRemoteBranch(branch, remote);
            } else {
              // Fallback: try origin
              try { await this.gitService.deleteRemoteBranch(message.payload.name); } catch { /* ignore */ }
            }
          }
          this.post({
            type: 'operationComplete',
            payload: { operation: 'deleteBranch', success: true },
          });
          this.host.showInfo(this.host.t('branchDeleted', message.payload.name));
          await this.host.refreshAll();
          break;
        }
        case 'deleteRemoteBranch': {
          await this.gitService.deleteRemoteBranch(message.payload.name, message.payload.remote);
          this.post({
            type: 'operationComplete',
            payload: { operation: 'deleteRemoteBranch', success: true },
          });
          this.host.showInfo(this.host.t('remoteBranchDeleted', message.payload.remote, message.payload.name));
          await this.host.refreshAll();
          break;
        }
        case 'renameBranch': {
          await this.gitService.renameBranch(message.payload.oldName, message.payload.newName);
          this.post({
            type: 'operationComplete',
            payload: { operation: 'renameBranch', success: true },
          });
          this.host.showInfo(this.host.t('branchRenamed', message.payload.newName));
          await this.host.refreshAll();
          break;
        }
        case 'setUpstream': {
          await this.gitService.setUpstream(message.payload.branch, message.payload.remote, message.payload.remoteBranch, { createRemote: message.payload.createRemote });
          this.post({ type: 'operationComplete', payload: { operation: 'setUpstream', success: true } });
          await this.host.refreshAll();
          break;
        }
        case 'fastForward': {
          if (message.payload.noCheckout) {
            // Update the (non-current) branch in place without switching to it.
            // Pure ref fast-forward — the working tree and current branch are
            // untouched, so no stash/clean dance is needed.
            await this.gitService.fastForwardRef(message.payload.local, message.payload.remote);
          } else {
            // Fast-forward is a sync (like pull, and git's `merge --autostash`):
            // stash so the working tree is clean for the ff-merge, then pop to
            // restore the changes — unlike a plain checkout, which sets them aside.
            if (message.payload.stash) {
              await this.gitService.stashSave('Auto-stash before fast-forward', message.payload.stashUntracked);
            }
            if (message.payload.clean) {
              await this.gitService.clean();
            }
            try {
              await this.gitService.checkout(message.payload.local, {});
              await this.gitService.merge(message.payload.remote, { ffOnly: true });
            } finally {
              if (message.payload.stash) {
                try {
                  await this.gitService.stashPop(0);
                } catch {
                  this.post({ type: 'error', payload: { message: this.host.t('stashPopAfterFastForwardFailed') } });
                }
              }
            }
          }
          this.post({
            type: 'operationComplete',
            payload: { operation: 'checkout', success: true },
          });
          this.host.showInfo(this.host.t('fastForwarded', message.payload.local, message.payload.remote));
          await this.host.refreshAll();
          break;
        }
        case 'merge': {
          await this.gitService.merge(message.payload.branch, { noFf: message.payload.noFf, ffOnly: message.payload.ffOnly, squash: message.payload.squash });
          // Optional follow-ups. A merge creates a new commit (no history
          // rewrite) so the push needs no force. Both follow-ups are non-fatal:
          // the merge already succeeded, so surface failures separately.
          if (message.payload.deleteSource) {
            try {
              await this.gitService.deleteBranch(message.payload.branch);
            } catch (err) {
              this.post({ type: 'error', payload: { message: this.host.t('deleteSourceAfterMergeFailed', message.payload.branch, err instanceof Error ? err.message : String(err)) } });
            }
          }
          let pushFailed = false;
          if (message.payload.pushAfter) {
            try {
              await this.gitService.pushCurrentBranch();
            } catch (err) {
              pushFailed = true;
              this.post({ type: 'error', payload: { message: this.host.t('pushAfterMergeFailed', err instanceof Error ? err.message : String(err)) } });
            }
          }
          this.post({
            type: 'operationComplete',
            payload: { operation: 'merge', success: true },
          });
          if (message.payload.pushAfter && !pushFailed) {
            this.host.showInfo(this.host.t('mergedAndPushed', message.payload.branch));
          } else {
            this.host.showInfo(this.host.t('merged', message.payload.branch));
          }
          await this.host.refreshAll();
          break;
        }
        case 'abortMerge': {
          await this.gitService.abortMerge();
          this.post({
            type: 'operationComplete',
            payload: { operation: 'abortMerge', success: true },
          });
          await this.host.refreshAll();
          break;
        }
        case 'openDiff': {
          if (message.payload.ref1 && message.payload.ref2) {
            await this.host.handleEditorAction({
              kind: 'openCompareDiff',
              repoPath: this.repoPath,
              file: message.payload.file,
              ref1: message.payload.ref1,
              ref2: message.payload.ref2,
            });
          } else {
            await this.host.handleEditorAction({
              kind: 'openDiff',
              repoPath: this.repoPath,
              file: message.payload.file,
              staged: message.payload.staged ?? false,
              commitHash: message.payload.commitHash,
            });
          }
          break;
        }
        case 'openFile': {
          // Validate the webview-supplied path stays inside the repo before
          // handing it to the host editor.
          this.resolveRepoRelativePath(message.payload.file, 'openFile');
          await this.host.handleEditorAction({
            kind: 'openFile',
            repoPath: this.repoPath,
            file: message.payload.file,
          });
          break;
        }
        case 'openScmView': {
          await this.host.handleEditorAction({
            kind: 'openScmView',
            returnFocus: message.payload?.returnFocus,
          });
          break;
        }
        case 'amendCommit': {
          await this.gitService.amendCommit(message.payload);
          // Optional follow-up: amend rewrites HEAD, so the push force-pushes
          // with --force-with-lease. Non-fatal — the amend already succeeded.
          let amendPushFailed = false;
          if (message.payload.pushAfter) {
            try {
              await this.gitService.pushCurrentBranch({ force: 'with-lease' });
            } catch (err) {
              amendPushFailed = true;
              this.post({ type: 'error', payload: { message: this.host.t('pushAfterAmendFailed', err instanceof Error ? err.message : String(err)) } });
            }
          }
          this.post({
            type: 'operationComplete',
            payload: { operation: 'amendCommit', success: true },
          });
          if (message.payload.pushAfter && !amendPushFailed) {
            this.host.showInfo(this.host.t('commitAmendedAndPushed'));
          } else {
            this.host.showInfo(this.host.t('commitAmended'));
          }
          await this.host.refreshAll();
          break;
        }
        case 'fetch': {
          await this.gitService.fetch(message.payload.remote, { prune: message.payload.prune });
          this.post({
            type: 'operationComplete',
            payload: { operation: 'fetch', success: true },
          });
          this.host.showInfo(this.host.t('fetched'));
          await this.host.refreshAll();
          break;
        }
        case 'pull': {
          if (message.payload.stash) {
            await this.gitService.stashSave('Auto-stash before pull');
          }
          try {
            await this.gitService.pull(message.payload.remote, message.payload.branch, { rebase: message.payload.rebase });
          } finally {
            if (message.payload.stash) {
              try {
                await this.gitService.stashPop(0);
              } catch {
                this.post({ type: 'error', payload: { message: this.host.t('stashPopAfterPullFailed') } });
              }
            }
          }
          this.post({
            type: 'operationComplete',
            payload: { operation: 'pull', success: true },
          });
          this.host.showInfo(this.host.t('pulled'));
          await this.host.refreshAll();
          break;
        }
        case 'push': {
          await this.gitService.push(message.payload.remote, message.payload.branch, { force: message.payload.force, setUpstream: message.payload.setUpstream });
          this.post({
            type: 'operationComplete',
            payload: { operation: 'push', success: true },
          });
          this.host.showInfo(this.host.t('pushed'));
          await this.host.refreshAll();
          break;
        }
        case 'addRemote': {
          await this.gitService.addRemote(message.payload.name, message.payload.url);
          this.post({
            type: 'operationComplete',
            payload: { operation: 'addRemote', success: true },
          });
          this.host.showInfo(this.host.t('remoteAdded', message.payload.name));
          await this.host.refreshAll();
          break;
        }
        case 'removeRemote': {
          await this.gitService.removeRemote(message.payload.name);
          this.post({
            type: 'operationComplete',
            payload: { operation: 'removeRemote', success: true },
          });
          this.host.showInfo(this.host.t('remoteRemoved', message.payload.name));
          await this.host.refreshAll();
          break;
        }
        case 'rebase': {
          await this.gitService.rebase(message.payload.onto, { autostash: message.payload.autostash });
          // Optional follow-up: push the rebased branch. Rebase rewrites history,
          // so this force-pushes with --force-with-lease. A push failure here is
          // non-fatal — the rebase already succeeded — so surface it separately.
          let pushOutcome: 'pushed' | 'no-remote' | 'failed' | null = null;
          if (message.payload.pushAfter) {
            try {
              const result = await this.gitService.pushCurrentBranch({ force: 'with-lease' });
              pushOutcome = result.pushed ? 'pushed' : 'no-remote';
            } catch (err) {
              pushOutcome = 'failed';
              this.post({ type: 'error', payload: { message: this.host.t('pushAfterRebaseFailed', err instanceof Error ? err.message : String(err)) } });
            }
          }
          this.post({
            type: 'operationComplete',
            payload: { operation: 'rebase', success: true },
          });
          const onto = message.payload.onto.substring(0, 7);
          if (pushOutcome === 'pushed') {
            this.host.showInfo(this.host.t('rebasedAndPushed', onto));
          } else if (pushOutcome === 'no-remote') {
            this.host.showInfo(this.host.t('pushAfterRebaseNoRemote', onto));
          } else {
            this.host.showInfo(this.host.t('rebased', onto));
          }
          await this.host.refreshAll();
          break;
        }
        case 'abortRebase': {
          await this.gitService.abortRebase();
          this.post({
            type: 'operationComplete',
            payload: { operation: 'abortRebase', success: true },
          });
          await this.host.refreshAll();
          break;
        }
        case 'continueRebase': {
          await this.gitService.continueRebase();
          this.post({
            type: 'operationComplete',
            payload: { operation: 'continueRebase', success: true },
          });
          await this.host.refreshAll();
          break;
        }
        case 'skipRebase': {
          await this.gitService.skipRebase();
          this.post({ type: 'operationComplete', payload: { operation: 'skipRebase', success: true } });
          await this.host.refreshAll();
          break;
        }
        case 'interactiveRebase': {
          await this.gitService.interactiveRebase(message.payload.base, message.payload.todos);
          this.post({ type: 'operationComplete', payload: { operation: 'interactiveRebase', success: true } });
          await this.host.refreshAll();
          break;
        }
        case 'getRebaseCommits': {
          const rebaseCommits = await this.gitService.getRebaseCommits(message.payload.base);
          this.post({ type: 'rebaseCommitsData', payload: { base: message.payload.base, commits: rebaseCommits } });
          break;
        }
        case 'reset': {
          await this.gitService.reset(message.payload.ref, message.payload.mode);
          this.post({ type: 'operationComplete', payload: { operation: 'reset', success: true } });
          this.host.showInfo(this.host.t('resetComplete', message.payload.ref.substring(0, 7)));
          await this.host.refreshAll();
          break;
        }
        case 'stashSave': {
          const beforeCount = (await this.gitService.stashList()).length;
          await this.gitService.stashSave(message.payload.message, message.payload.includeUntracked, message.payload.keepIndex);
          const afterCount = (await this.gitService.stashList()).length;
          if (afterCount > beforeCount) {
            this.post({ type: 'operationComplete', payload: { operation: 'stashSave', success: true } });
            this.host.showInfo(this.host.t('changesStashed'));
          } else {
            this.post({ type: 'error', payload: { message: this.host.t('noChangesToStash') } });
          }
          await this.host.refreshAll();
          break;
        }
        case 'stashApply': {
          if (message.payload.drop) {
            await this.gitService.stashPop(message.payload.index);
          } else {
            await this.gitService.stashApply(message.payload.index);
          }
          this.post({ type: 'operationComplete', payload: { operation: 'stashApply', success: true } });
          this.host.showInfo(this.host.t(message.payload.drop ? 'stashPopped' : 'stashApplied'));
          await this.host.refreshAll();
          break;
        }
        case 'stashDrop': {
          await this.gitService.stashDrop(message.payload.index);
          this.post({ type: 'operationComplete', payload: { operation: 'stashDrop', success: true } });
          this.host.showInfo(this.host.t('stashDropped'));
          await this.host.refreshAll();
          break;
        }
        case 'stashRename': {
          await this.gitService.stashRename(message.payload.index, message.payload.message);
          await this.host.refreshAll();
          break;
        }
        case 'worktreeAdd': {
          const homeDir = this.host.getHomeDir();
          const wtPath = this.assertSafeArgPath(
            message.payload.path.replace(/^~/, homeDir),
            'worktreeAdd',
          );
          await this.gitService.worktreeAdd(wtPath, message.payload.branch, message.payload.newBranch);
          this.post({ type: 'operationComplete', payload: { operation: 'worktreeAdd', success: true } });
          this.host.showInfo(this.host.t('worktreeAdded', message.payload.path));
          await this.host.refreshAll();
          break;
        }
        case 'worktreeRemove': {
          await this.gitService.worktreeRemove(message.payload.path);
          // Delete linked branch after worktree is removed
          if (message.payload.deleteBranch) {
            await this.gitService.deleteBranch(message.payload.deleteBranch, true);
          }
          this.post({ type: 'operationComplete', payload: { operation: 'worktreeRemove', success: true } });
          this.host.showInfo(this.host.t('worktreeRemoved'));
          await this.host.refreshAll();
          break;
        }
        case 'openWorktreeInNewWindow': {
          const resolved = this.assertSafeArgPath(
            message.payload.path.replace(/^~/, this.host.getHomeDir()),
            'openWorktreeInNewWindow',
          );
          await this.host.handleEditorAction({ kind: 'openFolder', path: resolved, newWindow: true });
          break;
        }
        case 'cherryPick': {
          await this.gitService.cherryPick(message.payload.commit, { noCommit: message.payload.noCommit });
          // Optional follow-up push (only meaningful when a commit was created).
          // A cherry-pick adds a new commit, so the push needs no force.
          let cherryPushFailed = false;
          if (message.payload.pushAfter && !message.payload.noCommit) {
            try {
              await this.gitService.pushCurrentBranch();
            } catch (err) {
              cherryPushFailed = true;
              this.post({ type: 'error', payload: { message: this.host.t('pushAfterCherryPickFailed', err instanceof Error ? err.message : String(err)) } });
            }
          }
          this.post({ type: 'operationComplete', payload: { operation: 'cherryPick', success: true } });
          if (message.payload.pushAfter && !message.payload.noCommit && !cherryPushFailed) {
            this.host.showInfo(this.host.t('cherryPickedAndPushed', message.payload.commit.substring(0, 7)));
          } else {
            this.host.showInfo(this.host.t('cherryPicked', message.payload.commit.substring(0, 7)));
          }
          await this.host.refreshAll();
          break;
        }
        case 'revert': {
          await this.gitService.revert(message.payload.commit, { noCommit: message.payload.noCommit });
          // Optional follow-up push (only meaningful when a commit was created).
          // A revert adds a new commit, so the push needs no force.
          let revertPushFailed = false;
          if (message.payload.pushAfter && !message.payload.noCommit) {
            try {
              await this.gitService.pushCurrentBranch();
            } catch (err) {
              revertPushFailed = true;
              this.post({ type: 'error', payload: { message: this.host.t('pushAfterRevertFailed', err instanceof Error ? err.message : String(err)) } });
            }
          }
          this.post({ type: 'operationComplete', payload: { operation: 'revert', success: true } });
          if (message.payload.pushAfter && !message.payload.noCommit && !revertPushFailed) {
            this.host.showInfo(this.host.t('revertedAndPushed', message.payload.commit.substring(0, 7)));
          } else {
            this.host.showInfo(this.host.t('reverted', message.payload.commit.substring(0, 7)));
          }
          await this.host.refreshAll();
          break;
        }
        case 'createTag': {
          await this.gitService.createTag(message.payload.name, message.payload.ref, message.payload.message);
          this.post({ type: 'operationComplete', payload: { operation: 'createTag', success: true } });
          this.host.showInfo(this.host.t('tagCreated', message.payload.name));
          await this.host.refreshAll();
          break;
        }
        case 'deleteTag': {
          await this.gitService.deleteTag(message.payload.name);
          this.post({ type: 'operationComplete', payload: { operation: 'deleteTag', success: true } });
          this.host.showInfo(this.host.t('tagDeleted', message.payload.name));
          await this.host.refreshAll();
          break;
        }
        case 'showTagDetails': {
          const tags = await this.gitService.tags();
          const tag = tags.find(t => t.name === message.payload.name);
          if (tag) {
            this.post({ type: 'tagDetailsData', payload: tag });
          }
          break;
        }
        case 'getCommitData': {
          const commit = await this.gitService.searchByHash(message.payload.hash);
          if (commit) {
            this.post({ type: 'commitData', payload: { commit } });
          }
          break;
        }
        case 'searchCommits': {
          // searchSequence guards against a stale response overwriting a
          // newer one when the user types fast. Same pattern as getLog.
          const seq = ++this.searchSequence;
          const results = await this.gitService.searchCommits(message.payload.query, {
            author: message.payload.author,
            after: message.payload.after,
            before: message.payload.before,
          });
          if (seq !== this.searchSequence) break;
          this.post({ type: 'searchResults', payload: { commits: results, graph: [] } });
          break;
        }
        case 'searchByHash': {
          const seq = ++this.searchSequence;
          const found = await this.gitService.searchByHash(message.payload.hash);
          if (seq !== this.searchSequence) break;
          this.post({ type: 'searchResults', payload: { commits: found ? [found] : [], graph: [] } });
          break;
        }
        case 'searchByFile': {
          const seq = ++this.searchSequence;
          const results = await this.gitService.searchByFile(message.payload.file);
          if (seq !== this.searchSequence) break;
          this.post({ type: 'searchResults', payload: { commits: results, graph: [] } });
          break;
        }
        case 'getActivityLog': {
          this.post({ type: 'activityLogData', payload: this.gitService.getActivityLog() });
          break;
        }
        case 'getReflog': {
          const result = await this.gitService.getReflog(message.payload?.limit ?? 200, message.payload?.ref ?? 'HEAD');
          this.post({ type: 'reflogData', payload: result });
          break;
        }
        // --- Bisect ---
        case 'bisectStart': {
          const result = await this.gitService.bisectStart(message.payload.bad, message.payload.good);
          this.post({ type: 'operationComplete', payload: { operation: 'bisectStart', success: true } });
          this.post({ type: 'bisectResult', payload: { message: result } });
          await this.host.refreshAll();
          break;
        }
        case 'bisectGood': {
          const result = await this.gitService.bisectGood(message.payload.ref);
          this.post({ type: 'bisectResult', payload: { message: result } });
          await this.host.refreshAll();
          break;
        }
        case 'bisectBad': {
          const result = await this.gitService.bisectBad(message.payload.ref);
          this.post({ type: 'bisectResult', payload: { message: result } });
          await this.host.refreshAll();
          break;
        }
        case 'bisectSkip': {
          const result = await this.gitService.bisectSkip();
          this.post({ type: 'bisectResult', payload: { message: result } });
          await this.host.refreshAll();
          break;
        }
        case 'bisectReset': {
          await this.gitService.bisectReset();
          this.post({ type: 'operationComplete', payload: { operation: 'bisectReset', success: true } });
          await this.host.refreshAll();
          break;
        }
        // --- Statistics ---
        case 'getStats': {
          const [byAuthor, byWeekdayHour] = await Promise.all([
            this.gitService.statsCommitsByAuthor(),
            this.gitService.statsCommitsByWeekdayHour(),
          ]);
          this.post({
            type: 'statsData',
            payload: { byAuthor, byWeekdayHour },
          });
          break;
        }
        case 'copyToClipboard': {
          await this.host.handleEditorAction({ kind: 'copyToClipboard', text: message.payload.text });
          this.post({ type: 'operationComplete', payload: { operation: 'copied', success: true } });
          break;
        }
        case 'showNotification': {
          this.host.showInfo(message.payload.message);
          break;
        }
        case 'saveCommitPatch': {
          const { hash, paths } = message.payload;
          const patch = await this.gitService.formatPatch(hash, paths);
          const isSubset = Array.isArray(paths) && paths.length > 0;
          const fileName = `${hash.substring(0, 7)}${isSubset ? '-partial' : ''}.patch`;
          await this.host.handleEditorAction({
            kind: 'savePatch',
            repoPath: this.repoPath,
            defaultFileName: fileName,
            content: patch,
          });
          break;
        }
        case 'restoreStashFiles': {
          const { index, paths: stashPaths } = message.payload;
          await this.gitService.stashRestoreFiles(index, stashPaths);
          this.post({ type: 'operationComplete', payload: { operation: 'restoreStashFiles', success: true } });
          // List up to 3 file names; collapse the rest into a "+N more" suffix
          // so the toast stays a single readable line.
          const MAX_LISTED = 3;
          const names = stashPaths.map(p => path.basename(p));
          let fileList = names.slice(0, MAX_LISTED).join(', ');
          if (names.length > MAX_LISTED) {
            fileList += this.host.t('stashFilesRestoredMore', String(names.length - MAX_LISTED));
          }
          this.host.showInfo(
            this.host.t('stashFilesRestored', String(stashPaths.length), `stash@{${index}}`, fileList),
          );
          await this.host.refreshAll();
          break;
        }
        case 'compareToWorking': {
          const [workingDiffs, workingFiles] = await Promise.all([
            this.gitService.diffCommitToWorking(message.payload.hash),
            this.gitService.diffFiles(message.payload.hash),
          ]);
          this.post({ type: 'commitDiffData', payload: { hash: '', diffs: workingDiffs, files: workingFiles } });
          break;
        }
        case 'compareCommits': {
          const [compareDiffs, compareFiles] = await Promise.all([
            this.gitService.diffCommits(message.payload.ref1, message.payload.ref2),
            this.gitService.diffFiles(message.payload.ref1, message.payload.ref2),
          ]);
          this.post({ type: 'commitDiffData', payload: { hash: '', diffs: compareDiffs, files: compareFiles } });
          break;
        }
        // --- File tree at commit ---
        case 'lsTree': {
          const entries = await this.gitService.lsTree(message.payload.ref, message.payload.path);
          this.post({ type: 'lsTreeData', payload: { ref: message.payload.ref, path: message.payload.path, entries } });
          break;
        }
        // --- Git Flow ---
        case 'checkFlowStatus': {
          const installed = await this.gitService.isFlowInstalled();
          let initialized = false;
          let config = null;
          if (installed) {
            initialized = await this.gitService.isFlowInitialized();
            if (initialized) {
              config = await this.gitService.getFlowConfig();
            }
          }
          this.post({ type: 'flowStatus', payload: { installed, initialized, config } });
          break;
        }
        case 'flowInit': {
          await this.gitService.flowInit(message.payload);
          this.post({ type: 'operationComplete', payload: { operation: 'flowInit', success: true } });
          await this.host.refreshAll();
          break;
        }
        case 'flowAction': {
          const { flowType, action, name } = message.payload;
          if (action === 'start') {
            if (flowType === 'feature') await this.gitService.flowFeatureStart(name);
            else if (flowType === 'release') await this.gitService.flowReleaseStart(name);
            else if (flowType === 'hotfix') await this.gitService.flowHotfixStart(name);
            else throw new Error(`Unknown flow type: ${flowType}`);
          } else if (action === 'finish') {
            if (flowType === 'feature') await this.gitService.flowFeatureFinish(name);
            else if (flowType === 'release') await this.gitService.flowReleaseFinish(name);
            else if (flowType === 'hotfix') await this.gitService.flowHotfixFinish(name);
            else throw new Error(`Unknown flow type: ${flowType}`);
          } else {
            throw new Error(`Unknown flow action: ${action}`);
          }
          this.post({ type: 'operationComplete', payload: { operation: `flow-${action}`, success: true } });
          await this.host.refreshAll();
          break;
        }
        case 'getFlowBranches': {
          const branches = await this.gitService.getFlowBranches();
          this.post({ type: 'flowBranches', payload: branches });
          break;
        }
        // --- Submodule ---
        case 'getSubmodules': {
          const submodules = await this.gitService.submoduleStatus();
          this.post({ type: 'submoduleData', payload: submodules });
          break;
        }
        case 'submoduleUpdate': {
          await this.gitService.submoduleUpdate(true);
          this.post({ type: 'operationComplete', payload: { operation: 'submoduleUpdate', success: true } });
          break;
        }
        // --- LFS ---
        case 'getLfsFiles': {
          const lfsFiles = await this.gitService.lfsLsFiles();
          const lfsLocks = await this.gitService.lfsLocks();
          this.post({ type: 'lfsData', payload: { files: lfsFiles, locks: lfsLocks } });
          break;
        }
        case 'lfsLock': {
          await this.gitService.lfsLock(message.payload.file);
          this.post({ type: 'operationComplete', payload: { operation: 'lfsLock', success: true } });
          // Refresh LFS data
          const lfsFiles = await this.gitService.lfsLsFiles();
          const lfsLocks = await this.gitService.lfsLocks();
          this.post({ type: 'lfsData', payload: { files: lfsFiles, locks: lfsLocks } });
          break;
        }
        case 'lfsUnlock': {
          await this.gitService.lfsUnlock(message.payload.file, message.payload.force);
          this.post({ type: 'operationComplete', payload: { operation: 'lfsUnlock', success: true } });
          // Refresh LFS data
          const lfsFiles2 = await this.gitService.lfsLsFiles();
          const lfsLocks2 = await this.gitService.lfsLocks();
          this.post({ type: 'lfsData', payload: { files: lfsFiles2, locks: lfsLocks2 } });
          break;
        }
        // --- Worktree ---
        case 'getWorktrees': {
          const worktrees = await this.gitService.worktreeList();
          this.post({ type: 'worktreeData', payload: worktrees });
          break;
        }
        case 'pruneWorktrees': {
          await this.gitService.worktreePrune();
          this.post({ type: 'operationComplete', payload: { operation: 'pruneWorktrees', success: true } });
          await this.host.refreshAll();
          break;
        }
        // --- Tag Push ---
        case 'pushTag': {
          if (message.payload.remote) {
            await this.gitService.pushTag(message.payload.name, message.payload.remote);
          } else {
            await this.gitService.pushTagToAllRemotes(message.payload.name);
          }
          this.post({ type: 'operationComplete', payload: { operation: 'pushTag', success: true } });
          break;
        }
        case 'pushAllTags': {
          await this.gitService.pushAllTags(message.payload.remote);
          this.post({ type: 'operationComplete', payload: { operation: 'pushAllTags', success: true } });
          break;
        }
        case 'deleteRemoteTag': {
          if (message.payload.remote) {
            await this.gitService.deleteRemoteTag(message.payload.name, message.payload.remote);
          } else {
            await this.gitService.deleteTagFromAllRemotes(message.payload.name);
          }
          this.post({ type: 'operationComplete', payload: { operation: 'deleteRemoteTag', success: true } });
          await this.host.refreshAll();
          break;
        }
        // --- Image Diff ---
        case 'getImageAtRef': {
          const { ref, path: filePath } = message.payload;
          const mimeMap: Record<string, string> = {
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
            '.webp': 'image/webp', '.ico': 'image/x-icon',
          };
          const ext = '.' + filePath.split('.').pop()?.toLowerCase();
          const mimeType = mimeMap[ext] || 'image/png';

          try {
            let base64: string;
            if (ref === 'working') {
              // Read from working tree
              const fullPath = path.join(this.repoPath, filePath);
              const relative = path.relative(this.repoPath, fullPath);
              if (relative.startsWith('..') || path.isAbsolute(relative)) {
                throw new Error('Invalid file path');
              }
              const buffer = await readFile(fullPath);
              base64 = buffer.toString('base64');
            } else {
              base64 = await this.gitService.getImageBase64(ref, filePath);
            }
            this.post({
              type: 'imageData',
              payload: { ref, path: filePath, base64, mimeType },
            });
          } catch {
            this.post({
              type: 'imageData',
              payload: { ref, path: filePath, base64: '', mimeType },
            });
          }
          break;
        }
        // --- Repo Switch ---
        case 'switchRepo': {
          const newPath = message.payload.path;
          // Constrain to repos we discovered for the workspace. Without this
          // guard the webview could point the extension at any directory on
          // disk and every subsequent git command would run there.
          if (typeof newPath !== 'string' || newPath.length === 0) {
            throw new Error('Invalid path for switchRepo');
          }
          const allowed = this.host.state.cachedRepos.some(r => r.path === newPath);
          if (!allowed) {
            throw new Error(`Repo not in discovered list: ${newPath}`);
          }
          await this.host.switchRepo(newPath);
          break;
        }
        case 'stageFile': {
          await this.gitService.stageFile(message.payload.file);
          // Refresh conflict status after staging
          if (this.host.state.allConflictFiles.length > 0) {
            const [stillConflicting, opState] = await Promise.all([
              this.gitService.getConflictFiles(),
              this.gitService.getOperationState(),
            ]);
            const conflictSet = new Set(stillConflicting);
            if (opState.type) {
              this.post({
                type: 'conflictData',
                payload: {
                  operation: opState.type,
                  files: this.host.state.allConflictFiles.map(f => ({ path: f, resolved: !conflictSet.has(f) })),
                },
              });
            }
          }
          break;
        }
        case 'refreshConflicts': {
          if (this.host.state.allConflictFiles.length > 0) {
            const [stillConflicting, opState] = await Promise.all([
              this.gitService.getConflictFiles(),
              this.gitService.getOperationState(),
            ]);
            const conflictSet = new Set(stillConflicting);
            if (opState.type) {
              this.post({
                type: 'conflictData',
                payload: {
                  operation: opState.type,
                  files: this.host.state.allConflictFiles.map(f => ({ path: f, resolved: !conflictSet.has(f) })),
                },
              });
            }
          }
          break;
        }
        case 'continueOperation': {
          await this.gitService.continueOperation();
          this.post({ type: 'operationComplete', payload: { operation: 'continue', success: true } });
          await this.host.refreshAll();
          break;
        }
        case 'abortOperation': {
          await this.gitService.abortOperation();
          this.post({ type: 'operationComplete', payload: { operation: 'abort', success: true } });
          await this.host.refreshAll();
          break;
        }
        case 'openConflictFile': {
          this.resolveRepoRelativePath(message.payload.file, 'openConflictFile');
          await this.host.handleEditorAction({
            kind: 'openMergeEditor',
            repoPath: this.repoPath,
            file: message.payload.file,
          });
          break;
        }
        default:
          break;
      }
    } catch (err: unknown) {
      // Use stderr directly for GitError (cleaner than the full "git xxx failed (exit N): ..." message)
      const errorMessage = err instanceof GitError ? formatGitError(err.stderr) : err instanceof Error ? err.message : String(err);

      // Detect non-git-repo errors early to avoid unnecessary follow-up git calls
      if (err instanceof GitError && /not a git repository/.test(err.stderr)) {
        this.post({ type: 'notGitRepo' });
        return;
      }

      // Detect authentication errors and show a helpful message
      if (err instanceof GitError && isAuthFailure(err.stderr)) {
        let remoteUrl = '';
        try {
          remoteUrl = await this.gitService.getRemoteUrl('origin');
        } catch { /* ignore */ }

        const transport = transportFromRemoteUrl(remoteUrl);

        let msgKey: string;
        let hint: string;
        if (transport === 'ssh') {
          msgKey = 'SSH authentication failed. Check that your SSH key is configured correctly.';
          hint = 'ssh-add ~/.ssh/id_ed25519  (or your key path)';
        } else if (transport === 'https') {
          msgKey = 'HTTPS authentication failed. Your credentials may have expired.';
          hint = 'gh auth login  (or reconfigure your credential helper)';
        } else {
          msgKey = 'Authentication required. Please configure your Git credentials.';
          hint = '';
        }

        const detail = err.stderr.trim().split('\n')[0];
        const msg = this.host.t(msgKey);
        // The webview error banner gets the localized message; the interactive
        // prompt with action buttons is editor-bound.
        this.post({ type: 'error', payload: { message: msg } });
        await this.host.handleEditorAction({
          kind: 'authPrompt',
          message: msg,
          hint,
          detail,
          rawError: err.stderr.trim(),
        });
        return;
      }

      // Check if this is a merge/rebase conflict
      const conflictFiles = await this.gitService.getConflictFiles();
      if (conflictFiles.length > 0) {
        this.host.state.allConflictFiles = conflictFiles;
        const opState = await this.gitService.getOperationState();
        this.post({
          type: 'conflictData',
          payload: { operation: (opState.type === 'squash' ? 'merge' : opState.type) ?? 'merge', files: conflictFiles.map(f => ({ path: f, resolved: false })) },
        });
        // If we entered the catch with an existing conflict (e.g. stageFile / refreshConflicts
        // failed while in a paused merge), still surface the underlying error — otherwise
        // the failure is invisible because the conflict UI just re-renders unchanged.
        if (message.type === 'stageFile' || message.type === 'refreshConflicts') {
          this.post({
            type: 'error',
            payload: { message: errorMessage, source: message.type },
          });
        }
        // Focus the Source Control sidebar so the user can resolve conflicts
        await this.host.handleEditorAction({ kind: 'openScmView' });
        await this.host.refreshAll();
      } else {
        this.post({
          type: 'error',
          payload: { message: errorMessage, source: message.type },
        });
      }
    }
  }

  public dispose(): void {
    // No owned resources today; present for symmetry with the host lifecycle
    // and to give a future web host a teardown hook.
  }
}
