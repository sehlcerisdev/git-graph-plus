import type { ExtensionMessage } from '../utils/message-bus';
import type {
  DispatcherHost,
  DispatcherConfig,
  DispatcherState,
  SavedFilters,
  EditorAction,
} from '../dispatcher/dispatcher-host';
import type { ServerConfig } from './config';
import { getDispatcherConfig } from './config';

/**
 * Server-side wiring the WebHost needs from index.ts. These are the
 * orchestration touchpoints (refresh, repo list, repo switch) that live with
 * the active GitService/dispatcher, plus the broadcast sink.
 */
export interface WebHostBindings {
  /** Send a message JSON to every connected WebSocket. */
  broadcast(msg: ExtensionMessage): void;
  refreshAll(): Promise<void>;
  sendRepoList(forceDiscovery?: boolean): Promise<void>;
  switchRepo(newPath: string): Promise<void>;
  getRepoPath(): string;
}

/**
 * Standalone-web implementation of DispatcherHost. Editor/OS-bound actions have
 * no equivalent in the browser, so they degrade to a transient notice (except
 * savePatch, which streams the patch back so the browser can download it, and
 * copyToClipboard, which the browser performs locally via a clipboard message).
 */
export class WebHost implements DispatcherHost {
  readonly state: DispatcherState;

  constructor(
    private readonly cfg: ServerConfig,
    private readonly bindings: WebHostBindings,
    state: DispatcherState,
  ) {
    this.state = state;
  }

  post(msg: ExtensionMessage): void {
    this.bindings.broadcast(msg);
  }

  getConfig(): DispatcherConfig {
    return getDispatcherConfig(this.cfg);
  }

  getLocale(): string {
    return this.cfg.locale;
  }

  getHomeDir(): string {
    return this.cfg.homeDir;
  }

  // No l10n bundle on the server: return the key with its args appended. The
  // webview already localizes most user-facing flows; these notices are
  // best-effort transient toasts.
  t(key: string, ...args: (string | number)[]): string {
    return args.length ? `${key} (${args.join(', ')})` : key;
  }

  showInfo(message: string): void {
    this.post({ type: 'notice', payload: { message } });
  }

  showError(message: string): void {
    this.post({ type: 'error', payload: { message } });
  }

  handleEditorAction(action: EditorAction): void {
    switch (action.kind) {
      case 'savePatch':
        // Stream the patch content back so the browser can offer a download.
        this.post({
          type: 'error',
          payload: { message: `__SAVE_PATCH__:${action.defaultFileName}\n${action.content}`, source: 'savePatch' },
        });
        break;
      case 'copyToClipboard':
        // Surface the text so the webview can copy it via the browser clipboard.
        this.post({
          type: 'error',
          payload: { message: `__CLIPBOARD__:${action.text}`, source: 'copyToClipboard' },
        });
        break;
      case 'authPrompt':
        this.post({ type: 'error', payload: { message: action.message } });
        break;
      default:
        // Editor/OS-bound actions (openDiff, openFile, openFolder,
        // openMergeEditor, openScmView, …) have no browser equivalent. Surface a
        // friendly transient notice rather than a scary error banner.
        this.post({
          type: 'notice',
          payload: {
            message: `This action ("${action.kind}") isn't available in web mode — it requires the VS Code editor.`,
          },
        });
    }
  }

  getSavedFilters(): SavedFilters {
    // Single-user server: no cross-session persistence beyond process lifetime.
    return { remoteFilter: undefined, branchFilter: undefined };
  }

  getRepoPath(): string {
    return this.bindings.getRepoPath();
  }

  refreshAll(): Promise<void> {
    return this.bindings.refreshAll();
  }

  sendRepoList(forceDiscovery?: boolean): Promise<void> {
    return this.bindings.sendRepoList(forceDiscovery);
  }

  switchRepo(newPath: string): Promise<void> {
    return this.bindings.switchRepo(newPath);
  }

  processPendingModal(): void {
    // No pre-webview modal queue in web mode.
  }
}

/** A fresh per-process dispatch state with the server's defaults. */
export function createDispatcherState(cachedRepos: { path: string }[]): DispatcherState {
  return {
    allConflictFiles: [],
    currentLimit: 1000,
    isFirstGetLog: true,
    currentRemoteFilter: undefined,
    currentBranchFilter: undefined,
    cachedRepos,
  };
}
