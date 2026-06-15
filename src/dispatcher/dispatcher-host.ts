// vscode-free host abstraction for GitDispatcher.
//
// GitDispatcher contains the portable git-operation message-dispatch logic
// shared by the VS Code panel (MainPanel) and a future standalone web server.
// Every non-portable touchpoint — config/locale reads, transient notices, and
// editor/OS-bound actions (open diff, open file, clipboard, save dialog, …) —
// is reached through this interface so the dispatcher never imports `vscode`.

import type { ExtensionMessage, ModalDefaults } from '../utils/message-bus';

/** Settings/defaults the dispatch path reads, resolved by the host. */
export interface DispatcherConfig {
  /** `gitGraphPlus.graphSortOrder` */
  graphSortOrder: 'author-date' | 'date' | 'topological';
  /** `gitGraphPlus.branchBadgeBarThickness`, already resolved to a px width. */
  branchBadgeBarWidth: number;
  /** `gitGraphPlus.autoRefresh` */
  autoRefresh: boolean;
  /** `gitGraphPlus.defaults.*`, the object MainPanel's readModalDefaults() returns. */
  modalDefaults: ModalDefaults;
}

/**
 * Editor/OS-bound actions that have no portable equivalent. The VS Code host
 * performs these via `vscode.commands.executeCommand` / save dialog / clipboard;
 * a web host would surface or no-op them. The dispatcher routes every such case
 * here so its core logic stays portable.
 */
export type EditorAction =
  | {
      // Open a commit / staged / working-tree diff in the editor.
      kind: 'openDiff';
      repoPath: string;
      file: string;
      staged: boolean;
      commitHash?: string;
    }
  | {
      // Open a compare diff between two refs (or a ref vs the working tree).
      kind: 'openCompareDiff';
      repoPath: string;
      file: string;
      ref1: string;
      ref2: string;
    }
  | {
      // Open a working-tree file in the editor.
      kind: 'openFile';
      repoPath: string;
      file: string;
    }
  | {
      // Open a folder / worktree in a (new) editor window.
      kind: 'openFolder';
      path: string;
      newWindow: boolean;
    }
  | {
      // Open VS Code's 3-way merge editor for a conflicted file, falling back
      // to a normal editor open if unavailable.
      kind: 'openMergeEditor';
      repoPath: string;
      file: string;
    }
  | {
      // Focus the Source Control view; optionally return focus to the webview.
      kind: 'openScmView';
      returnFocus?: boolean;
    }
  | {
      // Prompt for a destination and write a patch file to disk.
      kind: 'savePatch';
      repoPath: string;
      defaultFileName: string;
      content: string;
    }
  | {
      // Write text to the system clipboard.
      kind: 'copyToClipboard';
      text: string;
    }
  | {
      // Interactive auth-failure prompt (modeless error with action buttons that
      // can open a terminal or reveal the raw git error). VS Code-only; a web
      // host would surface `message` as a plain error.
      kind: 'authPrompt';
      message: string;
      hint: string;
      detail: string;
      rawError: string;
    };

/**
 * Mutable per-session dispatch state shared between the dispatcher and the host.
 *
 * The dispatcher's message handlers write these (e.g. the `getLog` handler sets
 * the active filters/limit); the host's refresh / repo-change paths read them
 * (e.g. `refreshAll` mirrors the active filters). Keeping it on the host lets
 * MainPanel's existing refresh/onRepoChanged logic stay untouched while the
 * switch body moves into the dispatcher.
 */
export interface DispatcherState {
  allConflictFiles: string[];
  currentLimit: number;
  isFirstGetLog: boolean;
  currentRemoteFilter: string[] | undefined;
  currentBranchFilter: string[] | undefined;
  /** Repos discovered for the workspace; switchRepo is constrained to these. */
  cachedRepos: { path: string }[];
}

/** Saved cross-session filters, mirrored onto the first getLog (see getLog handler). */
export interface SavedFilters {
  remoteFilter: string[] | undefined;
  branchFilter: string[] | undefined;
}

export interface DispatcherHost {
  /** Send a message to the webview (drops after disposal). */
  post(msg: ExtensionMessage): void;

  /** Resolved settings/defaults read on the dispatch path. */
  getConfig(): DispatcherConfig;

  /** Effective locale (already resolved from the `auto` setting). */
  getLocale(): string;

  /** User home directory, for `~` expansion in worktree paths. */
  getHomeDir(): string;

  /**
   * Localize a key + substitution args. The VS Code host applies
   * `vscode.l10n.t(key, ...args)` (English fallback lives in the l10n bundles);
   * a web host can supply its own translator or return the key. Used for both
   * transient toasts (via showInfo) and webview-bound error payload strings, so
   * VS Code localization is preserved unchanged.
   */
  t(key: string, ...args: (string | number)[]): string;

  /** Transient info notice. Pass an already-localized string (see `t`). */
  showInfo(message: string): void;

  /** Transient error notice. Pass an already-localized string. */
  showError(message: string): void;

  /** Perform an editor/OS-bound action that has no portable equivalent. */
  handleEditorAction(action: EditorAction): void | Promise<void>;

  /** Mutable per-session dispatch state (see DispatcherState). */
  readonly state: DispatcherState;

  /** Saved cross-session filters mirrored onto the first getLog. */
  getSavedFilters(): SavedFilters;

  /** Current repository root. May change after switchRepo. */
  getRepoPath(): string;

  /** Re-render the full graph + sidebar (host owns FileWatcher suppression etc.). */
  refreshAll(): Promise<void>;

  /** (Re)discover and broadcast the workspace repo list. */
  sendRepoList(forceDiscovery?: boolean): Promise<void>;

  /** Switch the active repository to `newPath` (already validated as discovered). */
  switchRepo(newPath: string): Promise<void>;

  /** Deliver any modal queued before the webview was ready. */
  processPendingModal(): void;
}
