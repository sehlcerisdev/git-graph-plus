import * as vscode from 'vscode';
import * as path from 'path';
import { readFile, access } from 'fs/promises';
import { GitService, GitError } from '../git/git-service';
import { formatGitError } from '../git/git-error-formatter';
import { buildGraph, buildFullGraph, buildGraphFromFullData } from '../git/git-graph-builder';
import { triggerVSCodeGitAuth } from '../git/vscode-git-bridge';
import { FileWatcher } from '../services/file-watcher';
import { resolveGitDirs } from '../services/file-watcher-helpers';
import { RepoDiscoveryService, RepoInfo } from '../services/repo-discovery';
import type { WebviewMessage } from '../utils/message-bus';
import {
  resolveRepoRelativePath as resolveRepoRelativePathUtil,
  assertSafeArgPath as assertSafeArgPathUtil,
} from '../utils/path-validation';
import { SequenceGuard } from '../utils/sequence-guard';

export class MainPanel {
  public static currentPanel: MainPanel | undefined;
  private static readonly viewType = 'gitGraphPlus';
  private static savedRemoteFilter: string[] | undefined = undefined;
  private static savedBranchFilter: string[] | undefined = undefined;
  private static extraEnv: Record<string, string> | undefined = undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private repoPath: string;
  private gitService: GitService;
  private fileWatcher: FileWatcher;
  private disposables: vscode.Disposable[] = [];
  private allConflictFiles: string[] = [];
  private currentLimit = 1000;
  private currentRemoteFilter: string[] | undefined = undefined;
  private currentBranchFilter: string[] | undefined = undefined;
  private isFirstGetLog = true;
  private logSequence = 0;
  private searchSequence = 0;
  private diffSequence = new SequenceGuard();
  private cachedRepos: RepoInfo[] = [];
  private disposed = false;
  public static onSidebarRefresh: (() => void) | null = null;
  public static onRepoChange: ((repoPath: string) => void) | null = null;

  /** Safe postMessage: drops messages after disposal and swallows the throw
   *  that VS Code raises if the underlying webview has gone away. Use this
   *  in every async path that may resolve after the user closes the panel. */
  private post(msg: unknown): void {
    if (this.disposed) return;
    try {
      this.panel.webview.postMessage(msg);
    } catch {
      // Webview was torn down between our check and the call (e.g., user
      // closed the panel mid-flight). Nothing to do.
    }
  }

  public static setExtraEnv(env: Record<string, string>): void {
    this.extraEnv = env;
    if (this.currentPanel) {
      this.currentPanel.gitService.setExtraEnv(env);
    }
  }

  private resolveRepoRelativePath(rel: unknown, op: string): string {
    return resolveRepoRelativePathUtil(this.repoPath, rel, op);
  }

  private assertSafeArgPath(p: unknown, op: string): string {
    return assertSafeArgPathUtil(p, op);
  }

  private createGitService(repoPath: string): GitService {
    const svc = new GitService(repoPath);
    if (MainPanel.extraEnv) svc.setExtraEnv(MainPanel.extraEnv);
    svc.setWarningHandler(msg => {
      // Surface non-fatal git failures (e.g., stash log / uncommitted status / remote list
      // failures) to the webview so the user knows the displayed graph may be incomplete.
      this.post({ type: 'error', payload: { message: `Git Graph+: ${msg}` } });
    });
    // On auth failure (missing/invalid HTTPS credentials), route through the
    // built-in `vscode.git` extension so the user sees the same credential
    // prompt as the SCM panel. Once they sign in, the OS credential helper
    // caches it and our retried spawn-based command succeeds.
    svc.setAuthRetryHandler(remote => triggerVSCodeGitAuth(repoPath, remote));
    return svc;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    repoPath: string
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.repoPath = repoPath;
    this.gitService = this.createGitService(repoPath);

    this.fileWatcher = new FileWatcher(repoPath, (what) => {
      this.onRepoChanged(what);
    });
    this.fileWatcher.enabled = vscode.workspace.getConfiguration('gitGraphPlus').get<boolean>('autoRefresh', true);
    this.disposables.push(this.fileWatcher);

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitGraphPlus.autoRefresh')) {
          this.fileWatcher.enabled = vscode.workspace.getConfiguration('gitGraphPlus').get<boolean>('autoRefresh', true);
        }
        if (e.affectsConfiguration('gitGraphPlus.graphSortOrder')) {
          this.refreshAll();
        }
        if (e.affectsConfiguration('gitGraphPlus.locale')) {
          const localeSetting = vscode.workspace.getConfiguration('gitGraphPlus').get<string>('locale', 'auto');
          const locale = localeSetting === 'auto' ? (vscode.env.language || 'en') : localeSetting;
          this.post({ type: 'setLocale', payload: { locale } });
        }
      })
    );

    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

    // Send locale to webview
    const localeSetting = vscode.workspace.getConfiguration('gitGraphPlus').get<string>('locale', 'auto');
    const locale = localeSetting === 'auto' ? (vscode.env.language || 'en') : localeSetting;
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this.post({ type: 'setLocale', payload: { locale, homeDir } });

    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Discover repos (including submodules) once on init
    this.sendRepoList();
  }

  public static createOrShow(extensionUri: vscode.Uri, repoPathHint?: string): void {
    let repoPath: string | undefined = repoPathHint;

    if (!repoPath) {
      // Try to find the repo associated with the active editor
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
        if (workspaceFolder) {
          repoPath = workspaceFolder.uri.fsPath;
        }
      }
    }

    // Fallback to first workspace folder
    if (!repoPath) {
      repoPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    if (!repoPath) {
      vscode.window.showWarningMessage('Git Graph+: No workspace folder open.');
      return;
    }

    if (MainPanel.currentPanel) {
      // If a specific repo is requested, switch to it before revealing
      if (repoPathHint && MainPanel.currentPanel.repoPath !== repoPathHint) {
        MainPanel.currentPanel.switchRepo(repoPathHint);
      }
      MainPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      MainPanel.viewType,
      'Git Graph+',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist'),
          vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
        ],
      }
    );

    // Set tab icon (light bg → dark icon, dark bg → light icon)
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'resources', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'resources', 'icon-dark.svg'),
    };

    MainPanel.currentPanel = new MainPanel(panel, extensionUri, repoPath);
  }

  public async postRefresh(): Promise<void> {
    await this.refreshAll();
  }

  public async switchRepo(newPath: string): Promise<void> {
    if (path.resolve(newPath) === path.resolve(this.repoPath)) { return; }
    this.repoPath = newPath;
    this.gitService = this.createGitService(newPath);

    this.allConflictFiles = [];
    this.isFirstGetLog = true;
    this.currentRemoteFilter = undefined;
    this.currentBranchFilter = undefined;
    this.logSequence = 0;
    this.searchSequence = 0;
    this.diffSequence.reset();

    const oldWatcher = this.fileWatcher;
    oldWatcher.dispose();
    const oldIdx = this.disposables.indexOf(oldWatcher);
    if (oldIdx >= 0) { this.disposables.splice(oldIdx, 1); }
    this.fileWatcher = new FileWatcher(newPath, (what) => this.onRepoChanged(what));
    this.fileWatcher.enabled = vscode.workspace.getConfiguration('gitGraphPlus').get<boolean>('autoRefresh', true);
    this.disposables.push(this.fileWatcher);

    MainPanel.onRepoChange?.(newPath);

    this.post({
      type: 'repoList',
      payload: { repos: this.cachedRepos, active: this.repoPath },
    });

    await this.refreshAll();
  }

  public postShowModal(payload: { modal: string; [key: string]: any }): void {
    this.panel.reveal();
    this.post({ type: 'showModal', payload });
  }

  private static pendingModal: { modal: string; [key: string]: any } | null = null;

  public static showModalWithPanel(extensionUri: vscode.Uri, payload: { modal: string; [key: string]: any }): void {
    if (MainPanel.currentPanel) {
      MainPanel.currentPanel.postShowModal(payload);
    } else {
      MainPanel.pendingModal = payload;
      MainPanel.createOrShow(extensionUri);
    }
  }

  public processPendingModal(): void {
    if (MainPanel.pendingModal) {
      const payload = MainPanel.pendingModal;
      MainPanel.pendingModal = null;
      this.post({ type: 'showModal', payload });
    }
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'getLog': {
          const cfg = vscode.workspace.getConfiguration('gitGraphPlus');
          const sortOrder = cfg.get<'author-date' | 'date' | 'topological'>('graphSortOrder', 'topological');
          const requestedLimit = message.payload.limit ?? 1000;
          this.currentLimit = requestedLimit;
          // On first load, apply saved filter if the webview didn't specify one.
          const effectiveFilter = this.isFirstGetLog && message.payload.remoteFilter === undefined
            ? MainPanel.savedRemoteFilter
            : message.payload.remoteFilter;
          const effectiveBranchFilter = this.isFirstGetLog && message.payload.branches === undefined
            ? MainPanel.savedBranchFilter
            : message.payload.branches;
          this.isFirstGetLog = false;
          this.currentRemoteFilter = effectiveFilter;
          this.currentBranchFilter = effectiveBranchFilter;
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
          const graph = commits.length > 0 ? buildGraphFromFullData(commits, fullGraph) : [];
          this.post({
            type: 'logData',
            payload: {
              commits,
              hasMore,
              currentLimit: requestedLimit,
              graph,
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
          this.processPendingModal();
          break;
        }
        case 'getRepoList': {
          await this.sendRepoList(true);
          break;
        }
        case 'getCommitDiff': {
          // Guard against rapid clicks on different commits: only the most
          // recently requested diff is delivered to the webview.
          const ticket = this.diffSequence.issue();
          const commitFiles = await this.gitService.showCommitFiles(message.payload.hash);
          if (!this.diffSequence.isCurrent(ticket)) break;
          this.post({
            type: 'commitDiffData',
            payload: { hash: message.payload.hash, files: commitFiles },
          });
          break;
        }
        case 'getFileDiff': {
          const ticket = this.diffSequence.issue();
          const diffs = await this.gitService.showCommitDiff(message.payload.hash, message.payload.file);
          if (!this.diffSequence.isCurrent(ticket)) break;
          this.post({
            type: 'fileDiffData',
            payload: { hash: message.payload.hash, file: message.payload.file, diff: diffs[0] || null },
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
          const diff = await this.gitService.getUncommittedFileDiff(message.payload.file, message.payload.staged);
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
          vscode.window.showInformationMessage(vscode.l10n.t('checkedOut', checkedOutRef));
          if (message.payload.stash) {
            vscode.window.showInformationMessage(vscode.l10n.t('changesStashed'));
          }
          await this.refreshAll();
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
          this.post({
            type: 'operationComplete',
            payload: { operation: 'createBranch', success: true },
          });
          vscode.window.showInformationMessage(
            message.payload.checkout
              ? vscode.l10n.t('branchCreatedAndCheckedOut', message.payload.name)
              : vscode.l10n.t('branchCreated', message.payload.name)
          );
          if (message.payload.checkout && message.payload.stash) {
            vscode.window.showInformationMessage(vscode.l10n.t('changesStashed'));
          }
          await this.refreshAll();
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
              const [remote, ...rest] = localInfo.upstream.split('/');
              await this.gitService.deleteRemoteBranch(rest.join('/'), remote);
            } else {
              // Fallback: try origin
              try { await this.gitService.deleteRemoteBranch(message.payload.name); } catch { /* ignore */ }
            }
          }
          this.post({
            type: 'operationComplete',
            payload: { operation: 'deleteBranch', success: true },
          });
          vscode.window.showInformationMessage(vscode.l10n.t('branchDeleted', message.payload.name));
          await this.refreshAll();
          break;
        }
        case 'deleteRemoteBranch': {
          await this.gitService.deleteRemoteBranch(message.payload.name, message.payload.remote);
          this.post({
            type: 'operationComplete',
            payload: { operation: 'deleteRemoteBranch', success: true },
          });
          vscode.window.showInformationMessage(vscode.l10n.t('remoteBranchDeleted', message.payload.remote, message.payload.name));
          await this.refreshAll();
          break;
        }
        case 'renameBranch': {
          await this.gitService.renameBranch(message.payload.oldName, message.payload.newName);
          this.post({
            type: 'operationComplete',
            payload: { operation: 'renameBranch', success: true },
          });
          vscode.window.showInformationMessage(vscode.l10n.t('branchRenamed', message.payload.newName));
          await this.refreshAll();
          break;
        }
        case 'setUpstream': {
          await this.gitService.setUpstream(message.payload.branch, message.payload.remote, message.payload.remoteBranch, { createRemote: message.payload.createRemote });
          this.post({ type: 'operationComplete', payload: { operation: 'setUpstream', success: true } });
          await this.refreshAll();
          break;
        }
        case 'fastForward': {
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
                this.post({ type: 'error', payload: { message: vscode.l10n.t('stashPopAfterFastForwardFailed') } });
              }
            }
          }
          this.post({
            type: 'operationComplete',
            payload: { operation: 'checkout', success: true },
          });
          vscode.window.showInformationMessage(vscode.l10n.t('fastForwarded', message.payload.local, message.payload.remote));
          await this.refreshAll();
          break;
        }
        case 'merge': {
          await this.gitService.merge(message.payload.branch, { noFf: message.payload.noFf, ffOnly: message.payload.ffOnly, squash: message.payload.squash });
          this.post({
            type: 'operationComplete',
            payload: { operation: 'merge', success: true },
          });
          vscode.window.showInformationMessage(vscode.l10n.t('merged', message.payload.branch));
          await this.refreshAll();
          break;
        }
        case 'abortMerge': {
          await this.gitService.abortMerge();
          this.post({
            type: 'operationComplete',
            payload: { operation: 'abortMerge', success: true },
          });
          await this.refreshAll();
          break;
        }
        case 'openDiff': {
          if (message.payload.ref1 && message.payload.ref2) {
            await this.openCompareDiffInEditor(message.payload.file, message.payload.ref1, message.payload.ref2);
          } else {
            await this.openDiffInEditor(
              message.payload.file,
              message.payload.staged ?? false,
              message.payload.commitHash,
            );
          }
          break;
        }
        case 'openFile': {
          const fullPath = this.resolveRepoRelativePath(message.payload.file, 'openFile');
          const fileUri = vscode.Uri.file(fullPath);
          await vscode.window.showTextDocument(fileUri, { preview: false });
          break;
        }
        case 'fetch': {
          await this.gitService.fetch(message.payload.remote, { prune: message.payload.prune });
          this.post({
            type: 'operationComplete',
            payload: { operation: 'fetch', success: true },
          });
          vscode.window.showInformationMessage(vscode.l10n.t('fetched'));
          await this.refreshAll();
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
                this.post({ type: 'error', payload: { message: vscode.l10n.t('stashPopAfterPullFailed') } });
              }
            }
          }
          this.post({
            type: 'operationComplete',
            payload: { operation: 'pull', success: true },
          });
          vscode.window.showInformationMessage(vscode.l10n.t('pulled'));
          await this.refreshAll();
          break;
        }
        case 'push': {
          await this.gitService.push(message.payload.remote, message.payload.branch, { force: message.payload.force, setUpstream: message.payload.setUpstream });
          this.post({
            type: 'operationComplete',
            payload: { operation: 'push', success: true },
          });
          vscode.window.showInformationMessage(vscode.l10n.t('pushed'));
          await this.refreshAll();
          break;
        }
        case 'addRemote': {
          await this.gitService.addRemote(message.payload.name, message.payload.url);
          this.post({
            type: 'operationComplete',
            payload: { operation: 'addRemote', success: true },
          });
          vscode.window.showInformationMessage(vscode.l10n.t('remoteAdded', message.payload.name));
          await this.refreshAll();
          break;
        }
        case 'removeRemote': {
          await this.gitService.removeRemote(message.payload.name);
          this.post({
            type: 'operationComplete',
            payload: { operation: 'removeRemote', success: true },
          });
          vscode.window.showInformationMessage(vscode.l10n.t('remoteRemoved', message.payload.name));
          await this.refreshAll();
          break;
        }
        case 'rebase': {
          await this.gitService.rebase(message.payload.onto, { autostash: message.payload.autostash });
          this.post({
            type: 'operationComplete',
            payload: { operation: 'rebase', success: true },
          });
          vscode.window.showInformationMessage(vscode.l10n.t('rebased', message.payload.onto.substring(0, 7)));
          await this.refreshAll();
          break;
        }
        case 'abortRebase': {
          await this.gitService.abortRebase();
          this.post({
            type: 'operationComplete',
            payload: { operation: 'abortRebase', success: true },
          });
          await this.refreshAll();
          break;
        }
        case 'continueRebase': {
          await this.gitService.continueRebase();
          this.post({
            type: 'operationComplete',
            payload: { operation: 'continueRebase', success: true },
          });
          await this.refreshAll();
          break;
        }
        case 'skipRebase': {
          await this.gitService.skipRebase();
          this.post({ type: 'operationComplete', payload: { operation: 'skipRebase', success: true } });
          await this.refreshAll();
          break;
        }
        case 'interactiveRebase': {
          await this.gitService.interactiveRebase(message.payload.base, message.payload.todos);
          this.post({ type: 'operationComplete', payload: { operation: 'interactiveRebase', success: true } });
          await this.refreshAll();
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
          vscode.window.showInformationMessage(vscode.l10n.t('resetComplete', message.payload.ref.substring(0, 7)));
          await this.refreshAll();
          break;
        }
        case 'stashSave': {
          const beforeCount = (await this.gitService.stashList()).length;
          await this.gitService.stashSave(message.payload.message, message.payload.includeUntracked, message.payload.keepIndex);
          const afterCount = (await this.gitService.stashList()).length;
          if (afterCount > beforeCount) {
            this.post({ type: 'operationComplete', payload: { operation: 'stashSave', success: true } });
            vscode.window.showInformationMessage(vscode.l10n.t('changesStashed'));
          } else {
            this.post({ type: 'error', payload: { message: vscode.l10n.t('noChangesToStash') } });
          }
          await this.refreshAll();
          break;
        }
        case 'stashApply': {
          if (message.payload.drop) {
            await this.gitService.stashPop(message.payload.index);
          } else {
            await this.gitService.stashApply(message.payload.index);
          }
          this.post({ type: 'operationComplete', payload: { operation: 'stashApply', success: true } });
          vscode.window.showInformationMessage(vscode.l10n.t(message.payload.drop ? 'stashPopped' : 'stashApplied'));
          await this.refreshAll();
          break;
        }
        case 'stashDrop': {
          await this.gitService.stashDrop(message.payload.index);
          this.post({ type: 'operationComplete', payload: { operation: 'stashDrop', success: true } });
          vscode.window.showInformationMessage(vscode.l10n.t('stashDropped'));
          await this.refreshAll();
          break;
        }
        case 'stashRename': {
          await this.gitService.stashRename(message.payload.index, message.payload.message);
          await this.refreshAll();
          break;
        }
        case 'worktreeAdd': {
          const homeDir = process.env.HOME || process.env.USERPROFILE || '';
          const wtPath = this.assertSafeArgPath(
            message.payload.path.replace(/^~/, homeDir),
            'worktreeAdd',
          );
          await this.gitService.worktreeAdd(wtPath, message.payload.branch, message.payload.newBranch);
          this.post({ type: 'operationComplete', payload: { operation: 'worktreeAdd', success: true } });
          vscode.window.showInformationMessage(vscode.l10n.t('worktreeAdded', message.payload.path));
          await this.refreshAll();
          break;
        }
        case 'worktreeRemove': {
          await this.gitService.worktreeRemove(message.payload.path);
          // Delete linked branch after worktree is removed
          if (message.payload.deleteBranch) {
            await this.gitService.deleteBranch(message.payload.deleteBranch, true);
          }
          this.post({ type: 'operationComplete', payload: { operation: 'worktreeRemove', success: true } });
          vscode.window.showInformationMessage(vscode.l10n.t('worktreeRemoved'));
          await this.refreshAll();
          break;
        }
        case 'openWorktreeInNewWindow': {
          const resolved = this.assertSafeArgPath(
            message.payload.path.replace(/^~/, process.env.HOME || process.env.USERPROFILE || ''),
            'openWorktreeInNewWindow',
          );
          const wtUri = vscode.Uri.file(resolved);
          await vscode.commands.executeCommand('vscode.openFolder', wtUri, true);
          break;
        }
        case 'cherryPick': {
          await this.gitService.cherryPick(message.payload.commit, { noCommit: message.payload.noCommit });
          this.post({ type: 'operationComplete', payload: { operation: 'cherryPick', success: true } });
          vscode.window.showInformationMessage(vscode.l10n.t('cherryPicked', message.payload.commit.substring(0, 7)));
          await this.refreshAll();
          break;
        }
        case 'revert': {
          await this.gitService.revert(message.payload.commit, { noCommit: message.payload.noCommit });
          this.post({ type: 'operationComplete', payload: { operation: 'revert', success: true } });
          vscode.window.showInformationMessage(vscode.l10n.t('reverted', message.payload.commit.substring(0, 7)));
          await this.refreshAll();
          break;
        }
        case 'createTag': {
          await this.gitService.createTag(message.payload.name, message.payload.ref, message.payload.message);
          this.post({ type: 'operationComplete', payload: { operation: 'createTag', success: true } });
          vscode.window.showInformationMessage(vscode.l10n.t('tagCreated', message.payload.name));
          await this.refreshAll();
          break;
        }
        case 'deleteTag': {
          await this.gitService.deleteTag(message.payload.name);
          this.post({ type: 'operationComplete', payload: { operation: 'deleteTag', success: true } });
          vscode.window.showInformationMessage(vscode.l10n.t('tagDeleted', message.payload.name));
          await this.refreshAll();
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
          const searchGraph = buildGraph(results);
          this.post({ type: 'searchResults', payload: { commits: results, graph: searchGraph } });
          break;
        }
        case 'searchByHash': {
          const seq = ++this.searchSequence;
          const found = await this.gitService.searchByHash(message.payload.hash);
          if (seq !== this.searchSequence) break;
          if (found) {
            const foundGraph = buildGraph([found]);
            this.post({ type: 'searchResults', payload: { commits: [found], graph: foundGraph } });
          } else {
            this.post({ type: 'searchResults', payload: { commits: [], graph: [] } });
          }
          break;
        }
        case 'searchByFile': {
          const seq = ++this.searchSequence;
          const results = await this.gitService.searchByFile(message.payload.file);
          if (seq !== this.searchSequence) break;
          const searchGraph = buildGraph(results);
          this.post({ type: 'searchResults', payload: { commits: results, graph: searchGraph } });
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
          await this.refreshAll();
          break;
        }
        case 'bisectGood': {
          const result = await this.gitService.bisectGood(message.payload.ref);
          this.post({ type: 'bisectResult', payload: { message: result } });
          await this.refreshAll();
          break;
        }
        case 'bisectBad': {
          const result = await this.gitService.bisectBad(message.payload.ref);
          this.post({ type: 'bisectResult', payload: { message: result } });
          await this.refreshAll();
          break;
        }
        case 'bisectSkip': {
          const result = await this.gitService.bisectSkip();
          this.post({ type: 'bisectResult', payload: { message: result } });
          await this.refreshAll();
          break;
        }
        case 'bisectReset': {
          await this.gitService.bisectReset();
          this.post({ type: 'operationComplete', payload: { operation: 'bisectReset', success: true } });
          await this.refreshAll();
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
          await vscode.env.clipboard.writeText(message.payload.text);
          this.post({ type: 'operationComplete', payload: { operation: 'copied', success: true } });
          break;
        }
        case 'showNotification': {
          vscode.window.showInformationMessage(message.payload.message);
          break;
        }
        case 'saveCommitPatch': {
          const patch = await this.gitService.formatPatch(message.payload.hash);
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(this.repoPath, `${message.payload.hash.substring(0, 7)}.patch`)),
            filters: { 'Patch files': ['patch'] },
          });
          if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(patch));
          }
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
          await this.refreshAll();
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
          await this.refreshAll();
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
          await this.refreshAll();
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
          await this.gitService.deleteRemoteTag(message.payload.name, message.payload.remote);
          this.post({ type: 'operationComplete', payload: { operation: 'deleteRemoteTag', success: true } });
          await this.refreshAll();
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
          const allowed = this.cachedRepos.some(r => r.path === newPath);
          if (!allowed) {
            throw new Error(`Repo not in discovered list: ${newPath}`);
          }
          this.repoPath = newPath;
          this.gitService = this.createGitService(newPath);

          // Reset repo-specific state
          this.allConflictFiles = [];
          this.isFirstGetLog = true;
          this.currentRemoteFilter = undefined;
          this.currentBranchFilter = undefined;
          this.logSequence = 0;
          this.searchSequence = 0;
          this.diffSequence.reset();

          const oldWatcher = this.fileWatcher;
          oldWatcher.dispose();
          const oldIdx = this.disposables.indexOf(oldWatcher);
          if (oldIdx >= 0) { this.disposables.splice(oldIdx, 1); }
          this.fileWatcher = new FileWatcher(newPath, (what) => {
            this.onRepoChanged(what);
          });
          this.fileWatcher.enabled = vscode.workspace.getConfiguration('gitGraphPlus').get<boolean>('autoRefresh', true);
          this.disposables.push(this.fileWatcher);
          
          MainPanel.onRepoChange?.(newPath);

          // Update repo list in webview with cached repos but new active path
          // Send this BEFORE refreshAll so the dropdown updates instantly
          this.post({
            type: 'repoList',
            payload: { repos: this.cachedRepos, active: this.repoPath },
          });

          await this.refreshAll();
          break;
        }
        case 'stageFile': {
          await this.gitService.stageFile(message.payload.file);
          // Refresh conflict status after staging
          if (this.allConflictFiles.length > 0) {
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
                  files: this.allConflictFiles.map(f => ({ path: f, resolved: !conflictSet.has(f) })),
                },
              });
            }
          }
          break;
        }
        case 'refreshConflicts': {
          if (this.allConflictFiles.length > 0) {
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
                  files: this.allConflictFiles.map(f => ({ path: f, resolved: !conflictSet.has(f) })),
                },
              });
            }
          }
          break;
        }
        case 'continueOperation': {
          await this.gitService.continueOperation();
          this.post({ type: 'operationComplete', payload: { operation: 'continue', success: true } });
          await this.refreshAll();
          break;
        }
        case 'abortOperation': {
          await this.gitService.abortOperation();
          this.post({ type: 'operationComplete', payload: { operation: 'abort', success: true } });
          await this.refreshAll();
          break;
        }
        case 'openConflictFile': {
          const fullPath = this.resolveRepoRelativePath(message.payload.file, 'openConflictFile');
          const fileUri = vscode.Uri.file(fullPath);
          // Try to open in VS Code's 3-way merge editor, fallback to normal editor
          try {
            await vscode.commands.executeCommand('git.openMergeEditor', fileUri);
          } catch {
            await vscode.window.showTextDocument(fileUri);
          }
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
      if (err instanceof GitError && /terminal prompts disabled|Authentication failed|could not read Username|could not read Password|Permission denied.*publickey|Host key verification failed|Could not read from remote/.test(err.stderr)) {
        let remoteUrl = '';
        try {
          remoteUrl = await this.gitService.getRemoteUrl('origin');
        } catch { /* ignore */ }

        const isSSH = remoteUrl.startsWith('git@') || remoteUrl.startsWith('ssh://');
        const isHTTPS = remoteUrl.startsWith('https://') || remoteUrl.startsWith('http://');

        let msg: string;
        let hint: string;
        if (isSSH) {
          msg = vscode.l10n.t('SSH authentication failed. Check that your SSH key is configured correctly.');
          hint = 'ssh-add ~/.ssh/id_ed25519  (or your key path)';
        } else if (isHTTPS) {
          msg = vscode.l10n.t('HTTPS authentication failed. Your credentials may have expired.');
          hint = 'gh auth login  (or reconfigure your credential helper)';
        } else {
          msg = vscode.l10n.t('Authentication required. Please configure your Git credentials.');
          hint = '';
        }

        const detail = err.stderr.trim().split('\n')[0];
        this.post({ type: 'error', payload: { message: msg } });

        const action = await vscode.window.showErrorMessage(
          `${msg}${hint ? `\n→ ${hint}` : ''}`,
          { detail, modal: false },
          vscode.l10n.t('Open Terminal'),
          vscode.l10n.t('Show Error'),
        );
        if (action === vscode.l10n.t('Open Terminal')) {
          vscode.commands.executeCommand('workbench.action.terminal.new');
        } else if (action === vscode.l10n.t('Show Error')) {
          vscode.window.showErrorMessage(err.stderr.trim());
        }
        return;
      }

      // Check if this is a merge/rebase conflict
      const conflictFiles = await this.gitService.getConflictFiles();
      if (conflictFiles.length > 0) {
        this.allConflictFiles = conflictFiles;
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
        vscode.commands.executeCommand('workbench.view.scm');
        await this.refreshAll();
      } else {
        this.post({
          type: 'error',
          payload: { message: errorMessage, source: message.type },
        });
      }
    }
  }

  private async openDiffInEditor(
    file: string,
    staged?: boolean,
    commitHash?: string,
  ): Promise<void> {
    // Validate that the webview-supplied path stays inside the repo before
    // we feed it to vscode.diff / build URIs. resolveRepoRelativePath throws
    // on traversal (`../etc/passwd`) and absolute paths.
    const fullPath = this.resolveRepoRelativePath(file, 'openDiff');
    const fileUri = vscode.Uri.file(fullPath);

    if (commitHash) {
      // Commit diff: parent vs commit
      const parentRef = commitHash + '~1';
      const leftUri = vscode.Uri.parse(`git-graph-plus://show/${parentRef}/${file}`).with({
        query: JSON.stringify({ ref: parentRef, path: file, repoPath: this.repoPath }),
      });
      const rightUri = vscode.Uri.parse(`git-graph-plus://show/${commitHash}/${file}`).with({
        query: JSON.stringify({ ref: commitHash, path: file, repoPath: this.repoPath }),
      });
      const title = `${file} (${commitHash.substring(0, 7)})`;
      await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
    } else if (staged) {
      // Staged diff: HEAD vs index
      const headUri = vscode.Uri.parse(`git-graph-plus://show/HEAD/${file}`).with({
        query: JSON.stringify({ ref: 'HEAD', path: file, repoPath: this.repoPath }),
      });
      const indexUri = vscode.Uri.parse(`git-graph-plus://show/:0/${file}`).with({
        query: JSON.stringify({ ref: ':0', path: file, repoPath: this.repoPath }),
      });
      await vscode.commands.executeCommand('vscode.diff', headUri, indexUri, `${file} (Staged)`);
    } else {
      // Unstaged diff: index vs working tree
      const indexUri = vscode.Uri.parse(`git-graph-plus://show/:0/${file}`).with({
        query: JSON.stringify({ ref: ':0', path: file, repoPath: this.repoPath }),
      });
      await vscode.commands.executeCommand('vscode.diff', indexUri, fileUri, `${file} (Working Tree)`);
    }
  }

  private async openCompareDiffInEditor(file: string, ref1: string, ref2: string): Promise<void> {
    // Same validation as openDiffInEditor — the path must stay inside the repo
    // before being embedded in the diff editor and our content-provider URI.
    const fullPath = this.resolveRepoRelativePath(file, 'openCompareDiff');
    // ref1 = 'working' means compare ref2 against working tree
    if (ref1 === 'working' || ref2 === 'working') {
      const commitRef = ref1 === 'working' ? ref2 : ref1;
      const commitUri = vscode.Uri.parse(`git-graph-plus://show/${commitRef}/${file}`).with({
        query: JSON.stringify({ ref: commitRef, path: file, repoPath: this.repoPath }),
      });
      const fileUri = vscode.Uri.file(fullPath);
      await vscode.commands.executeCommand('vscode.diff', commitUri, fileUri, `${file} (${commitRef.substring(0, 7)} ↔ Working Tree)`);
    } else {
      const leftUri = vscode.Uri.parse(`git-graph-plus://show/${ref1}/${file}`).with({
        query: JSON.stringify({ ref: ref1, path: file, repoPath: this.repoPath }),
      });
      const rightUri = vscode.Uri.parse(`git-graph-plus://show/${ref2}/${file}`).with({
        query: JSON.stringify({ ref: ref2, path: file, repoPath: this.repoPath }),
      });
      const label1 = ref1.length > 10 ? ref1.substring(0, 7) : ref1;
      const label2 = ref2.length > 10 ? ref2.substring(0, 7) : ref2;
      await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${file} (${label1} ↔ ${label2})`);
    }
  }

  private refreshing = false;
  private refreshQueued = false;

  private async refreshAll(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    this.refreshQueued = false;
    // Watcher events caused by the same git operation that triggered this refresh
    // would arrive ~immediately after; absorb them so they don't fire a second pass.
    this.fileWatcher.suppress();
    try {
      const sortOrder = vscode.workspace.getConfiguration('gitGraphPlus').get<'author-date' | 'date' | 'topological'>('graphSortOrder', 'topological');
      const refreshLimit = this.currentLimit || 1000;
      const [allFetched, branches, tags, remotes, stashes, worktrees] = await Promise.all([
        this.gitService.log({ limit: refreshLimit + 1, sortOrder, remoteFilter: this.currentRemoteFilter, branches: this.currentBranchFilter }),
        this.gitService.branches(),
        this.gitService.tags(),
        this.gitService.remotes(),
        this.gitService.stashList(),
        this.gitService.worktreeList(),
      ]);
      const hasMore = allFetched.length > refreshLimit;
      const allCommits = hasMore ? allFetched.slice(0, refreshLimit) : allFetched;
      // Handle empty repository (0 commits) gracefully.
      // Compute the layout once and derive the legacy GraphNode[] from it —
      // calling buildGraph() *and* buildFullGraph() separately would run the
      // (BFS-heavy) layout twice on every watcher-triggered refresh.
      const fg = allCommits.length > 0 ? buildFullGraph(allCommits, branches) : { paths: [], links: [], dots: [], commitLeftMargin: [] };
      const graph = allCommits.length > 0 ? buildGraphFromFullData(allCommits, fg) : [];
      // Send as single combined message to ensure atomic update
      this.post({
        type: 'fullRefresh',
        payload: {
          logData: { commits: allCommits, hasMore, currentLimit: this.currentLimit, graph, paths: fg.paths, links: fg.links, dots: fg.dots, commitLeftMargin: fg.commitLeftMargin, remoteFilter: this.currentRemoteFilter, branches: this.currentBranchFilter },
          branchData: { branches, tags, remotes, stashes, worktrees },
        },
      });
      MainPanel.onSidebarRefresh?.();
    } catch (err) {
      console.warn('Git Graph+: refresh failed:', err instanceof Error ? err.message : err);
      if (err instanceof GitError && /not a git repository/.test(err.stderr)) {
        try { this.post({ type: 'notGitRepo' }); } catch { /* panel disposed */ }
      }
    } finally {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        this.refreshAll();
      }
    }
  }

  private repoListPending: Promise<void> | null = null;

  public sendRepoList(forceDiscovery = false): Promise<void> {
    // Deduplicate concurrent calls
    if (!this.repoListPending) {
      this.repoListPending = this.doSendRepoList(forceDiscovery).finally(() => { this.repoListPending = null; });
    }
    return this.repoListPending;
  }

  private async doSendRepoList(forceDiscovery = false): Promise<void> {
    try {
      if (forceDiscovery) {
        RepoDiscoveryService.clearCache();
      }
      const workspacePaths = new Set<string>();
      for (const f of vscode.workspace.workspaceFolders ?? []) {
        workspacePaths.add(f.uri.fsPath);
      }
      workspacePaths.add(this.repoPath);
      const repos = await RepoDiscoveryService.discoverRepos([...workspacePaths]);
      this.cachedRepos = repos;

      let active = this.repoPath;
      if (repos.length > 0 && !repos.some(r => r.path === active)) {
        // Current path is not a repo, switch to the first discovered one
        active = repos[0].path;
        this.repoPath = active;
        this.gitService = this.createGitService(active);
        const oldWatcher = this.fileWatcher;
        const oldIdx = this.disposables.indexOf(oldWatcher);
        if (oldIdx !== -1) this.disposables.splice(oldIdx, 1);
        oldWatcher.dispose();
        this.fileWatcher = new FileWatcher(active, (what) => this.onRepoChanged(what));
        this.fileWatcher.enabled = vscode.workspace.getConfiguration('gitGraphPlus').get<boolean>('autoRefresh', true);
        this.disposables.push(this.fileWatcher);
        
        // Notify extension to update sidebar views
        if (MainPanel.onRepoChange) {
          MainPanel.onRepoChange(active);
        }
        
        // Full refresh of the graph
        this.refreshAll();
      }

      this.post({
        type: 'repoList',
        payload: { repos, active },
      });
    } catch {
      // ignore
    }
  }

  private async onRepoChanged(what: string): Promise<void> {
    this.post({
      type: 'repoChanged',
      payload: { what },
    });

    if (what === 'refs' || what === 'unknown') {
      await this.refreshAll();
    }

    // Skip the conflict + operation state probe (2 git subprocess spawns)
    // when we already know no operation is in progress: nothing in memory
    // says we have unresolved conflicts, and none of the on-disk markers
    // (MERGE_HEAD / REBASE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD) exist.
    // For pure working-tree edits the watcher fires often; this avoids
    // spawning two git processes for every keystroke.
    if (this.allConflictFiles.length === 0) {
      // For linked worktrees, `.git` is a *file* and these markers live in
      // the worktree's resolved gitdir. Using `<repo>/.git/MERGE_HEAD`
      // unconditionally would suppress the conflict UI inside a worktree
      // even when a real merge / rebase is in progress.
      const gitDir = resolveGitDirs(this.repoPath).gitDir;
      const markers = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
      const anyMarker = (await Promise.all(markers.map(m =>
        access(path.join(gitDir, m)).then(() => true).catch(() => false),
      ))).some(Boolean);
      if (!anyMarker) return;
    }

    // Detect conflict state (from external terminal operations or index changes)
    const conflictFiles = await this.gitService.getConflictFiles();
    const opState = await this.gitService.getOperationState();

    if (conflictFiles.length > 0 && opState.type) {
      // New or updated conflict (merge/rebase started externally or in-progress)
      if (this.allConflictFiles.length === 0) {
        this.allConflictFiles = conflictFiles;
      }
      const conflictSet = new Set(conflictFiles);
      this.post({
        type: 'conflictData',
        payload: {
          operation: opState.type,
          files: this.allConflictFiles.map(f => ({ path: f, resolved: !conflictSet.has(f) })),
        },
      });
    } else if (conflictFiles.length === 0 && opState.type === 'rebase') {
      // Same worktree concern as the marker check above — rebase-merge state
      // lives in the per-worktree gitdir.
      const gitDir = resolveGitDirs(this.repoPath).gitDir;
      const stoppedShaPath = path.join(gitDir, 'rebase-merge', 'stopped-sha');
      const editPaused = await access(stoppedShaPath).then(() => true).catch(() => false);
      if (editPaused) {
        this.post({
          type: 'operationPaused',
          payload: { operation: 'rebase' },
        });
      }
    } else if (this.allConflictFiles.length > 0 && !opState.type) {
      // Operation was completed or aborted externally - notify webview to dismiss conflict UI
      this.allConflictFiles = [];
      this.post({
        type: 'operationComplete',
        payload: { operation: 'merge', success: true },
      });
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const distUri = vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'main.css'));
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: https://www.gravatar.com; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${codiconUri}">
  <link rel="stylesheet" href="${styleUri}">
  <title>Git Graph+</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    this.disposed = true;
    MainPanel.savedRemoteFilter = this.currentRemoteFilter;
    MainPanel.savedBranchFilter = this.currentBranchFilter;
    // Drop any modal request that was queued for this panel but never delivered
    // (panel closed before the webview was ready). A fresh panel opened later
    // for an unrelated reason should not surface a stale modal.
    MainPanel.pendingModal = null;
    MainPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
