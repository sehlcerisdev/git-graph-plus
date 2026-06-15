import * as vscode from 'vscode';
import * as path from 'path';
import { access } from 'fs/promises';
import { GitService, GitError } from '../git/git-service';
import { samePath } from '../utils/path';
import { buildFullGraph } from '../git/git-graph-builder';
import { triggerVSCodeGitAuth } from '../git/vscode-git-bridge';
import { FileWatcher } from '../services/file-watcher';
import { resolveGitDirs, shouldRefreshGraph } from '../services/file-watcher-helpers';
import { RepoDiscoveryService, RepoInfo } from '../services/repo-discovery';
import type { WebviewMessage, ModalDefaults } from '../utils/message-bus';
import { resolveRepoRelativePath as resolveRepoRelativePathUtil } from '../utils/path-validation';
import { GitDispatcher } from '../dispatcher/git-dispatcher';
import type { DispatcherHost, DispatcherState, EditorAction } from '../dispatcher/dispatcher-host';

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
  private cachedRepos: RepoInfo[] = [];
  // Portable message dispatcher: owns the handleMessage switch and reaches all
  // VS Code behavior through the inline DispatcherHost built in the constructor.
  private dispatcher!: GitDispatcher;
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

  private readModalDefaults(): ModalDefaults {
    const cfg = vscode.workspace.getConfiguration('gitGraphPlus');
    const g = <T>(key: string, fallback: T): T => cfg.get<T>(`defaults.${key}`, fallback);
    return {
      push: { force: g('push.force', 'none'), setUpstream: g('push.setUpstream', true), allTags: g('push.allTags', false) },
      pull: { rebase: g('pull.rebase', true), stash: g('pull.stash', false) },
      fetch: { allRemotes: g('fetch.allRemotes', false) },
      merge: { mode: g('merge.mode', 'default'), pushAfter: g('merge.pushAfter', false), deleteSource: g('merge.deleteSource', false) },
      rebase: { autostash: g('rebase.autostash', false), pushAfter: g('rebase.pushAfter', false) },
      amend: { keepMessage: g('amend.keepMessage', true), resetDate: g('amend.resetDate', false), resetAuthor: g('amend.resetAuthor', false), only: g('amend.only', false), pushAfter: g('amend.pushAfter', false) },
      checkout: { dirty: g('checkout.dirty', 'keep') },
      checkoutRemote: { dirty: g('checkoutRemote.dirty', 'keep') },
      createBranch: { checkout: g('createBranch.checkout', true), publish: g('createBranch.publish', false) },
      createTag: { push: g('createTag.push', true) },
      cherryPick: { noCommit: g('cherryPick.noCommit', false), pushAfter: g('cherryPick.pushAfter', false) },
      revert: { noCommit: g('revert.noCommit', false), pushAfter: g('revert.pushAfter', false) },
      reset: { mode: g('reset.mode', 'mixed') },
      stashSave: { includeUntracked: g('stashSave.includeUntracked', true), keepIndex: g('stashSave.keepIndex', false) },
      deleteBranch: { force: g('deleteBranch.force', false), deleteRemote: g('deleteBranch.deleteRemote', false) },
      deleteTag: { deleteRemote: g('deleteTag.deleteRemote', false) },
      removeWorktree: { deleteBranch: g('removeWorktree.deleteBranch', false) },
    } as ModalDefaults;
  }

  // Width (px) of the colored branch-badge bar, mapped from the user setting.
  private readBadgeBarWidth(): number {
    const level = vscode.workspace
      .getConfiguration('gitGraphPlus')
      .get<'thin' | 'medium' | 'thick'>('branchBadgeBarThickness', 'thin');
    return level === 'thick' ? 8 : level === 'medium' ? 6 : 4;
  }

  /** Build the inline DispatcherHost that performs today's exact VS Code
   *  behavior: config/locale reads, localized toasts, and editor/OS actions. */
  private createDispatcherHost(): DispatcherHost {
    const panel = this;
    // Live view of MainPanel's per-session fields, shared with the dispatcher
    // so the retained refresh/onRepoChanged/switchRepo code keeps reading them.
    const state: DispatcherState = {
      get allConflictFiles() { return panel.allConflictFiles; },
      set allConflictFiles(v) { panel.allConflictFiles = v; },
      get currentLimit() { return panel.currentLimit; },
      set currentLimit(v) { panel.currentLimit = v; },
      get isFirstGetLog() { return panel.isFirstGetLog; },
      set isFirstGetLog(v) { panel.isFirstGetLog = v; },
      get currentRemoteFilter() { return panel.currentRemoteFilter; },
      set currentRemoteFilter(v) { panel.currentRemoteFilter = v; },
      get currentBranchFilter() { return panel.currentBranchFilter; },
      set currentBranchFilter(v) { panel.currentBranchFilter = v; },
      get cachedRepos() { return panel.cachedRepos; },
      set cachedRepos(v) { panel.cachedRepos = v as RepoInfo[]; },
    };
    return {
      state,
      post: (msg) => panel.post(msg),
      getConfig: () => {
        const cfg = vscode.workspace.getConfiguration('gitGraphPlus');
        return {
          graphSortOrder: cfg.get<'author-date' | 'date' | 'topological'>('graphSortOrder', 'topological'),
          branchBadgeBarWidth: panel.readBadgeBarWidth(),
          autoRefresh: cfg.get<boolean>('autoRefresh', true),
          modalDefaults: panel.readModalDefaults(),
        };
      },
      getLocale: () => {
        const localeSetting = vscode.workspace.getConfiguration('gitGraphPlus').get<string>('locale', 'auto');
        return localeSetting === 'auto' ? (vscode.env.language || 'en') : localeSetting;
      },
      getHomeDir: () => process.env.HOME || process.env.USERPROFILE || '',
      t: (key, ...args) => vscode.l10n.t(key, ...args),
      showInfo: (message) => { vscode.window.showInformationMessage(message); },
      showError: (message) => { vscode.window.showErrorMessage(message); },
      getSavedFilters: () => ({ remoteFilter: MainPanel.savedRemoteFilter, branchFilter: MainPanel.savedBranchFilter }),
      getRepoPath: () => panel.repoPath,
      refreshAll: () => panel.refreshAll(),
      sendRepoList: (forceDiscovery) => panel.sendRepoList(forceDiscovery),
      switchRepo: (newPath) => panel.switchRepo(newPath),
      processPendingModal: () => panel.processPendingModal(),
      handleEditorAction: (action) => panel.handleEditorAction(action),
    };
  }

  /** Perform an editor/OS-bound action requested by the dispatcher. This is the
   *  VS Code implementation; a web host would surface or no-op these. */
  private async handleEditorAction(action: EditorAction): Promise<void> {
    switch (action.kind) {
      case 'openDiff':
        await this.openDiffInEditor(action.file, action.staged, action.commitHash);
        break;
      case 'openCompareDiff':
        await this.openCompareDiffInEditor(action.file, action.ref1, action.ref2);
        break;
      case 'openFile': {
        const fullPath = resolveRepoRelativePathUtil(action.repoPath, action.file, 'openFile');
        await vscode.window.showTextDocument(vscode.Uri.file(fullPath), { preview: false });
        break;
      }
      case 'openFolder':
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(action.path), action.newWindow);
        break;
      case 'openMergeEditor': {
        const fullPath = resolveRepoRelativePathUtil(action.repoPath, action.file, 'openConflictFile');
        const fileUri = vscode.Uri.file(fullPath);
        // Try VS Code's 3-way merge editor, fallback to a normal editor open.
        try {
          await vscode.commands.executeCommand('git.openMergeEditor', fileUri);
        } catch {
          await vscode.window.showTextDocument(fileUri);
        }
        break;
      }
      case 'openScmView':
        await vscode.commands.executeCommand('workbench.view.scm');
        // When opened alongside the amend modal, return focus to the webview so
        // the modal stays keyboard-interactive (Escape to close, typing).
        if (action.returnFocus) {
          this.panel.reveal(this.panel.viewColumn, false);
        }
        break;
      case 'savePatch': {
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(action.repoPath, action.defaultFileName)),
          filters: { 'Patch files': ['patch'] },
        });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(action.content));
        }
        break;
      }
      case 'copyToClipboard':
        await vscode.env.clipboard.writeText(action.text);
        break;
      case 'authPrompt': {
        const msg = action.message;
        const hint = action.hint;
        const detail = action.detail;
        const chosen = await vscode.window.showErrorMessage(
          `${msg}${hint ? `\n→ ${hint}` : ''}`,
          { detail, modal: false },
          vscode.l10n.t('Open Terminal'),
          vscode.l10n.t('Show Error'),
        );
        if (chosen === vscode.l10n.t('Open Terminal')) {
          vscode.commands.executeCommand('workbench.action.terminal.new');
        } else if (chosen === vscode.l10n.t('Show Error')) {
          vscode.window.showErrorMessage(action.rawError);
        }
        break;
      }
    }
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
    this.dispatcher = new GitDispatcher(this.gitService, this.createDispatcherHost());

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
        if (e.affectsConfiguration('gitGraphPlus.defaults')) {
          this.post({ type: 'setDefaults', payload: this.readModalDefaults() });
        }
        if (e.affectsConfiguration('gitGraphPlus.branchBadgeBarThickness')) {
          this.post({ type: 'setBadgeBarThickness', payload: { width: this.readBadgeBarWidth() } });
        }
      })
    );

    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

    // Send locale to webview
    const localeSetting = vscode.workspace.getConfiguration('gitGraphPlus').get<string>('locale', 'auto');
    const locale = localeSetting === 'auto' ? (vscode.env.language || 'en') : localeSetting;
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this.post({ type: 'setLocale', payload: { locale, homeDir } });
    this.post({ type: 'setDefaults', payload: this.readModalDefaults() });
    this.post({ type: 'setBadgeBarThickness', payload: { width: this.readBadgeBarWidth() } });

    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.dispatcher.handleMessage(message),
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
    if (samePath(newPath, this.repoPath)) { return; }
    this.repoPath = newPath;
    this.gitService = this.createGitService(newPath);
    this.dispatcher.setGitService(this.gitService);

    this.allConflictFiles = [];
    this.isFirstGetLog = true;
    this.currentRemoteFilter = undefined;
    this.currentBranchFilter = undefined;
    // NOTE: the sequence guards (logSequence/searchSequence/*Sequence) must NOT
    // be reset here. They are monotonic for the panel's lifetime so a request
    // still in flight against the old repo can never share a seq with a fresh
    // request against the new one — resetting reuses numbers and lets a stale
    // response paint the previous repo's graph over the current one.

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

  private async openDiffInEditor(
    file: string,
    staged?: boolean,
    commitHash?: string,
  ): Promise<void> {
    // Validate that the webview-supplied path stays inside the repo before
    // we feed it to vscode.diff / build URIs. resolveRepoRelativePath throws
    // on traversal (`../etc/passwd`) and absolute paths.
    const fullPath = resolveRepoRelativePathUtil(this.repoPath, file, 'openDiff');
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
    const fullPath = resolveRepoRelativePathUtil(this.repoPath, file, 'openCompareDiff');
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
      // Until the webview's first getLog establishes this session's filter,
      // mirror the saved filter that getLog will apply (same logic as the
      // getLog handler). Otherwise an early refresh — triggered by the file
      // watcher, a repo auto-switch, or a config change before that first
      // getLog — renders the full *unfiltered* graph (all branches/remotes),
      // which the filtered getLog then corrects: a visible flash of a tangled,
      // repo-unrelated "demo"-looking graph.
      const remoteFilter = this.isFirstGetLog ? MainPanel.savedRemoteFilter : this.currentRemoteFilter;
      const branchFilter = this.isFirstGetLog ? MainPanel.savedBranchFilter : this.currentBranchFilter;
      const [allFetched, branches, tags, remotes, stashes, worktrees] = await Promise.all([
        this.gitService.log({ limit: refreshLimit + 1, sortOrder, remoteFilter, branches: branchFilter }),
        this.gitService.branches(),
        this.gitService.tags(),
        this.gitService.remotes(),
        this.gitService.stashList(),
        this.gitService.worktreeList(),
      ]);
      const hasMore = allFetched.length > refreshLimit;
      const allCommits = hasMore ? allFetched.slice(0, refreshLimit) : allFetched;
      // Handle empty repository (0 commits) gracefully. The webview renders from
      // paths/links/dots; the legacy GraphNode[] is unused so we don't build it.
      const fg = allCommits.length > 0 ? buildFullGraph(allCommits, branches) : { paths: [], links: [], dots: [], commitLeftMargin: [] };
      // Send as single combined message to ensure atomic update
      this.post({
        type: 'fullRefresh',
        payload: {
          logData: { commits: allCommits, hasMore, currentLimit: this.currentLimit, graph: [], paths: fg.paths, links: fg.links, dots: fg.dots, commitLeftMargin: fg.commitLeftMargin, remoteFilter, branches: branchFilter },
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
      const discovered = await RepoDiscoveryService.discoverRepos([...workspacePaths]);
      // Canonicalize every path to VS Code's fsPath so the repo list and the
      // active path share one format. `git rev-parse --show-toplevel` returns
      // forward slashes (and a lowercase drive on Windows) while VS Code paths
      // use backslashes; without this the membership check below — and the
      // webview's dropdown lookup — fail to match and fall back to repos[0].
      // See issue #30.
      const repos = discovered.map(r => ({ ...r, path: vscode.Uri.file(r.path).fsPath }));
      this.cachedRepos = repos;

      let active = vscode.Uri.file(this.repoPath).fsPath;
      this.repoPath = active;
      if (repos.length > 0 && !repos.some(r => r.path === active)) {
        // Current path is not a repo, switch to the first discovered one
        active = repos[0].path;
        this.repoPath = active;
        this.gitService = this.createGitService(active);
        this.dispatcher.setGitService(this.gitService);
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

    if (shouldRefreshGraph(what)) {
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
    this.dispatcher.dispose();
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
