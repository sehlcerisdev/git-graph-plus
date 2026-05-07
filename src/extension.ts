import * as vscode from 'vscode';
import * as path from 'path';
import { MainPanel } from './panels/MainPanel';
import { GitContentProvider } from './services/git-content-provider';
import { GitService } from './git/git-service';
import { FileWatcher } from './services/file-watcher';
import { BranchesViewProvider } from './views/branches-view';
import { RemotesViewProvider } from './views/remotes-view';
import { TagsViewProvider } from './views/tags-view';
import { StashesViewProvider } from './views/stashes-view';
import { WorktreesViewProvider } from './views/worktrees-view';
import { StatusBarManager } from './views/status-bar';
import { RepoDiscoveryService } from './services/repo-discovery';

export function activate(context: vscode.ExtensionContext) {
  // Status bar is always visible regardless of workspace state
  const statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  let activeRepoPath = workspaceFolder.uri.fsPath;
  let activeGitService = new GitService(activeRepoPath);

  // Inject VS Code's built-in git extension askpass env so authentication prompts work
  const builtinGit = vscode.extensions.getExtension('vscode.git');
  if (builtinGit) {
    const waitForGit = builtinGit.isActive ? Promise.resolve(builtinGit.exports) : Promise.resolve(builtinGit.activate());
    waitForGit.then((ext: { getAPI(version: number): { git: { env?: Record<string, string> } } }) => {
      try {
        const env = ext.getAPI(1)?.git?.env;
        if (env) {
          activeGitService.setExtraEnv(env);
          MainPanel.setExtraEnv(env);
        }
      } catch { /* built-in git extension API unavailable */ }
    }).catch(() => {});
  }

  // --- Content Provider for diff URIs ---
  const contentProvider = new GitContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('git-graph-plus', contentProvider)
  );

  // --- Tree View Providers ---
  const branchesProvider = new BranchesViewProvider(activeGitService);
  const remotesProvider = new RemotesViewProvider(activeGitService);
  const tagsProvider = new TagsViewProvider(activeGitService);
  const stashesProvider = new StashesViewProvider(activeGitService);
  const worktreesProvider = new WorktreesViewProvider(activeGitService);

  const branchesView = vscode.window.createTreeView('gitGraphPlus.branches', { treeDataProvider: branchesProvider });
  const remotesView = vscode.window.createTreeView('gitGraphPlus.remotes', { treeDataProvider: remotesProvider });
  const tagsView = vscode.window.createTreeView('gitGraphPlus.tags', { treeDataProvider: tagsProvider });
  const stashesView = vscode.window.createTreeView('gitGraphPlus.stashes', { treeDataProvider: stashesProvider });
  const worktreesView = vscode.window.createTreeView('gitGraphPlus.worktrees', { treeDataProvider: worktreesProvider });

  const initialRepoName = path.basename(activeRepoPath);
  branchesView.description = initialRepoName;
  remotesView.description = initialRepoName;
  tagsView.description = initialRepoName;
  stashesView.description = initialRepoName;
  worktreesView.description = initialRepoName;

  context.subscriptions.push(
    branchesProvider,
    remotesProvider,
    tagsProvider,
    stashesProvider,
    worktreesProvider,
    branchesView,
    remotesView,
    tagsView,
    stashesView,
    worktreesView,
  );

  // Prefetch all tree view data in parallel so first expand is instant
  Promise.all([
    branchesProvider.prefetch(),
    remotesProvider.prefetch(),
    tagsProvider.prefetch(),
    stashesProvider.prefetch(),
    worktreesProvider.prefetch(),
  ]).catch((err) => { console.warn('Git Graph+: sidebar prefetch failed:', err instanceof Error ? err.message : err); });

  // --- File Watcher ---
  let fileWatcher = new FileWatcher(activeRepoPath, () => {
    refreshAll();
  });
  fileWatcher.enabled = vscode.workspace.getConfiguration('gitGraphPlus').get<boolean>('autoRefresh', true);
  context.subscriptions.push({ dispose: () => fileWatcher.dispose() });

  // --- Auto-detect Git Repo if root isn't one ---
  RepoDiscoveryService.discoverRepos([activeRepoPath]).then(repos => {
    if (repos.length > 0 && !repos.some(r => path.resolve(r.path) === path.resolve(activeRepoPath))) {
      const firstRepo = repos[0].path;
      activeRepoPath = firstRepo;
      activeGitService = new GitService(activeRepoPath);

      // Re-inject environment if needed
      if (builtinGit && builtinGit.exports) {
        try {
          const env = (builtinGit.exports as any).getAPI(1)?.git?.env;
          if (env) { activeGitService.setExtraEnv(env); }
        } catch { /* ignore */ }
      }
      
      // Update providers
      branchesProvider.setGitService(activeGitService);
      remotesProvider.setGitService(activeGitService);
      tagsProvider.setGitService(activeGitService);
      stashesProvider.setGitService(activeGitService);
      worktreesProvider.setGitService(activeGitService);

      // Update view descriptions
      const repoName = path.basename(activeRepoPath);
      branchesView.description = repoName;
      remotesView.description = repoName;
      tagsView.description = repoName;
      stashesView.description = repoName;
      worktreesView.description = repoName;

      // Update file watcher
      fileWatcher.dispose();
      fileWatcher = new FileWatcher(activeRepoPath, () => {
        refreshAll();
      });
      fileWatcher.enabled = vscode.workspace.getConfiguration('gitGraphPlus').get<boolean>('autoRefresh', true);
    }
  }).catch((err) => { console.warn('Git Graph+: repo discovery failed:', err instanceof Error ? err.message : err); });

  let sidebarRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  function refreshAll() {
    if (sidebarRefreshTimer) { clearTimeout(sidebarRefreshTimer); }
    sidebarRefreshTimer = setTimeout(async () => {
      sidebarRefreshTimer = null;
      
      // Refresh all providers
      await Promise.all([
        branchesProvider.refresh(),
        remotesProvider.refresh(),
        tagsProvider.refresh(),
        stashesProvider.refresh(),
        worktreesProvider.refresh(),
      ]);

      // Reveal current branch in sidebar (auto-expands folders)
      // ONLY if the view is already visible to prevent jumping to the SCM tab
      const currentItem = branchesProvider.getCurrentItem();
      if (currentItem && branchesView.visible) {
        // Small delay to ensure the tree view has processed the data change
        setTimeout(() => {
          branchesView.reveal(currentItem, { select: false, focus: false, expand: true }).then(undefined, () => {});
        }, 100);
      }
    }, 300);
  }

  function switchToRepo(newPath: string) {
    if (path.resolve(newPath) === path.resolve(activeRepoPath)) { return; }
    activeRepoPath = newPath;
    activeGitService = new GitService(newPath);

    if (builtinGit) {
      const ext = builtinGit.exports;
      if (ext) {
        try {
          const env = ext.getAPI(1)?.git?.env;
          if (env) { activeGitService.setExtraEnv(env); }
        } catch { /* ignore */ }
      }
    }

    branchesProvider.setGitService(activeGitService);
    remotesProvider.setGitService(activeGitService);
    tagsProvider.setGitService(activeGitService);
    stashesProvider.setGitService(activeGitService);
    worktreesProvider.setGitService(activeGitService);

    const repoName = path.basename(newPath);
    branchesView.description = repoName;
    remotesView.description = repoName;
    tagsView.description = repoName;
    stashesView.description = repoName;
    worktreesView.description = repoName;

    fileWatcher.dispose();
    fileWatcher = new FileWatcher(newPath, () => {
      refreshAll();
    });
    fileWatcher.enabled = vscode.workspace.getConfiguration('gitGraphPlus').get<boolean>('autoRefresh', true);

    // If the webview panel is open, sync it to the new repo as well.
    // MainPanel.switchRepo() will call onRepoChange → switchToRepo again,
    // but the path.resolve guard above prevents an infinite loop.
    MainPanel.currentPanel?.switchRepo(newPath);

    refreshAll();
  }

  MainPanel.onSidebarRefresh = refreshAll;
  MainPanel.onRepoChange = switchToRepo;

  // Auto-switch sidebar when the active editor moves to a different repo
  if (builtinGit) {
    const waitForGitApi = builtinGit.isActive
      ? Promise.resolve(builtinGit.exports)
      : Promise.resolve(builtinGit.activate());
    waitForGitApi.then((ext: {
      getAPI(version: number): {
        repositories: { rootUri: vscode.Uri; ui: { selected: boolean; onDidChange: vscode.Event<void> } }[];
        onDidOpenRepository: vscode.Event<{ rootUri: vscode.Uri; ui: { selected: boolean; onDidChange: vscode.Event<void> } }>;
        getRepository(uri: vscode.Uri): { rootUri: vscode.Uri } | null;
      }
    }) => {
      try {
        const gitApi = ext.getAPI(1);

        function watchRepo(repo: { rootUri: vscode.Uri; ui: { selected: boolean; onDidChange: vscode.Event<void> } }) {
          context.subscriptions.push(
            repo.ui.onDidChange(() => {
              if (repo.ui.selected) { switchToRepo(repo.rootUri.fsPath); }
            })
          );
        }

        for (const repo of gitApi.repositories) { watchRepo(repo); }
        context.subscriptions.push(gitApi.onDidOpenRepository(watchRepo));

        context.subscriptions.push(
          vscode.window.onDidChangeActiveTextEditor(editor => {
            if (!editor) { return; }
            const repo = gitApi.getRepository(editor.document.uri);
            if (repo?.rootUri) { switchToRepo(repo.rootUri.fsPath); }
          })
        );
      } catch { /* git API unavailable */ }
    }).catch(() => {});
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('git-graph-plus.open', (sourceControl?: vscode.SourceControl) => {
      if (sourceControl?.rootUri) { switchToRepo(sourceControl.rootUri.fsPath); }
      MainPanel.createOrShow(context.extensionUri, activeRepoPath);
    }),
    vscode.commands.registerCommand('gitGraphPlus.open', (sourceControl?: vscode.SourceControl) => {
      if (sourceControl?.rootUri) { switchToRepo(sourceControl.rootUri.fsPath); }
      MainPanel.createOrShow(context.extensionUri, activeRepoPath);
    }),
    vscode.commands.registerCommand('gitGraphPlus.refresh', () => {
      refreshAll();
      MainPanel.currentPanel?.postRefresh();
    }),
    vscode.commands.registerCommand('gitGraphPlus.fetch', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'fetch' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.pull', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'pull' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.push', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'push' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.publishBranch', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'push' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.checkoutBranch', (branchItem) => {
      if (branchItem?.branch) {
        activeGitService.checkout(branchItem.branch.name).then(() => {
          refreshAll();
          MainPanel.currentPanel?.postRefresh();
        }).catch(err => vscode.window.showErrorMessage(err.message));
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.checkoutRemoteBranch', (branchItem) => {
      if (branchItem?.branch) {
        const ref = branchItem.branch.name; // e.g. origin/main
        const localName = ref.split('/').slice(1).join('/');
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'checkoutRemote', remoteName: ref, localName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.mergeBranch', (branchItem) => {
      const branchName = branchItem?.branch?.name;
      if (branchName) {
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'mergeBranch', branchName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.stashApply', (stashItem) => {
      const index = stashItem?.index ?? 0;
      activeGitService.stashApply(index).then(() => {
        refreshAll();
        MainPanel.currentPanel?.postRefresh();
      }).catch(err => vscode.window.showErrorMessage(err.message));
    }),
    vscode.commands.registerCommand('gitGraphPlus.stashPop', (stashItem) => {
      const index = stashItem?.index ?? 0;
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'stashPop', index, message: stashItem?.stash?.message ?? `stash@{${index}}` });
    }),
    vscode.commands.registerCommand('gitGraphPlus.createBranch', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'createBranch' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.stashSave', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'stashSave' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.createTag', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'createTag' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.pushTag', (tagItem) => {
      const tagName = tagItem?.tag?.name;
      if (tagName) {
        activeGitService.pushTag(tagName).then(() => {
          refreshAll();
          MainPanel.currentPanel?.postRefresh();
          vscode.window.showInformationMessage(`Pushed tag ${tagName}`);
        }).catch(err => vscode.window.showErrorMessage(err.message));
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.pushAllTags', () => {
      activeGitService.pushAllTags().then(() => {
        refreshAll();
        MainPanel.currentPanel?.postRefresh();
        vscode.window.showInformationMessage(`Pushed all tags`);
      }).catch(err => vscode.window.showErrorMessage(err.message));
    }),
    vscode.commands.registerCommand('gitGraphPlus.deleteRemoteTag', (tagItem) => {
      const tagName = tagItem?.tag?.name;
      if (tagName) {
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'deleteRemoteTag', tagName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.deleteBranch', (branchItem) => {
      const branchName = branchItem?.branch?.name;
      if (branchName) {
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'deleteBranch', branchName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.renameBranch', (branchItem) => {
      const oldName = branchItem?.branch?.name;
      if (oldName) {
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'renameBranch', branchName: oldName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.deleteTag', (tagItem) => {
      const tagName = tagItem?.tag?.name;
      if (tagName) {
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'deleteTag', tagName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.stashDrop', (stashItem) => {
      const index = stashItem?.index ?? 0;
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'stashDrop', index, message: stashItem?.stash?.message ?? `stash@{${index}}` });
    }),
    vscode.commands.registerCommand('gitGraphPlus.addWorktree', () => {
      const defaultPath = path.join(path.dirname(activeRepoPath), `${path.basename(activeRepoPath)}-worktree`);
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'addWorktree', defaultPath });
    }),
    vscode.commands.registerCommand('gitGraphPlus.pruneWorktrees', () => {
      activeGitService.worktreePrune().then(() => {
        refreshAll();
        MainPanel.currentPanel?.postRefresh();
        vscode.window.showInformationMessage(`Pruned worktrees`);
      }).catch((err: Error) => vscode.window.showErrorMessage(err.message));
    }),
    vscode.commands.registerCommand('gitGraphPlus.showRemoteBranchMenu', (branchItem) => {
      const branch = branchItem?.branch;
      if (branch) {
        const remote = branch.name.split('/')[0];
        const branchName = branch.name.split('/').slice(1).join('/');
        vscode.window.showQuickPick([
          { label: `Checkout as local branch...`, id: 'checkout' },
          { label: `Delete remote branch ${branch.name}`, id: 'delete' },
        ]).then(selected => {
          if (selected?.id === 'delete') {
            MainPanel.showModalWithPanel(context.extensionUri, { modal: 'deleteRemoteBranch', remote, name: branchName });
          } else if (selected?.id === 'checkout') {
            const localName = branchName;
            MainPanel.showModalWithPanel(context.extensionUri, { modal: 'checkoutRemote', remoteName: branch.name, localName });
          }
        });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.checkoutRemoteBranchExplicit', (branch) => {
      if (branch) {
        const localName = branch.name.split('/').slice(1).join('/');
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'checkoutRemote', remoteName: branch.name, localName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.deleteRemoteBranchExplicit', (branch) => {
      if (branch) {
        const remote = branch.name.split('/')[0];
        const branchName = branch.name.split('/').slice(1).join('/');
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'deleteRemoteBranch', remote, name: branchName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.removeWorktree', (wtItem) => {
      if (wtItem?.worktree) {
        const wtPath = wtItem.worktree.path;
        const wtBranch = wtItem.worktree.branch;
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'removeWorktree', path: wtPath, branch: wtBranch });
      }
    }),
  );
}

export function deactivate() {
  MainPanel.onSidebarRefresh = null;
  MainPanel.onRepoChange = null;
}
