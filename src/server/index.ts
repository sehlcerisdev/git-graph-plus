import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';

import { GitService } from '../git/git-service';
import { GitError } from '../git/git-service';
import { setGitBinaryPath } from '../git/git-binary';
import { buildFullGraph } from '../git/git-graph-builder';
import { RepoDiscoveryService, RepoInfo } from '../services/repo-discovery';
import type { WebviewMessage, ExtensionMessage } from '../utils/message-bus';
import { GitDispatcher } from '../dispatcher/git-dispatcher';
import { shouldRefreshGraph } from '../services/file-watcher-helpers';

import { loadConfig, ServerConfig, getBadgeBarWidth } from './config';
import { Auth } from './auth';
import { WebHost, createDispatcherState } from './web-host';
import { FsWatcher } from './fs-watcher';

const WEBVIEW_DIST = path.resolve(__dirname, '../webview-ui/dist');
const CODICON_DIST = path.resolve(__dirname, '../node_modules/@vscode/codicons/dist');
// Standalone HTML is copied next to the bundle (dist/server-index.html) by the
// build step; fall back to the source location for `tsx`/ts-node dev runs.
const STANDALONE_HTML = [
  path.join(__dirname, 'server-index.html'),
  path.resolve(__dirname, '../src/server/index.html'),
].find(p => fs.existsSync(p)) ?? path.join(__dirname, 'server-index.html');

// ---------------------------------------------------------------------------
// Active-repo state. Single user → a single shared active repo (no per-socket
// maps). switchRepo swaps the GitService + dispatcher + watcher in place.
// ---------------------------------------------------------------------------
class Server {
  private readonly cfg: ServerConfig;
  private readonly auth: Auth;
  private readonly sockets = new Set<WebSocket>();

  private repoPath = '';
  private cachedRepos: RepoInfo[] = [];
  private gitService!: GitService;
  private dispatcher!: GitDispatcher;
  private host!: WebHost;
  private watcher: FsWatcher | null = null;
  private state = createDispatcherState([]);

  private refreshing = false;
  private refreshQueued = false;
  private autoFetchTimer: NodeJS.Timeout | null = null;

  constructor(cfg: ServerConfig) {
    this.cfg = cfg;
    this.auth = new Auth(cfg.authToken);
  }

  async start(): Promise<void> {
    setGitBinaryPath(this.cfg.gitBinaryPath || null);

    this.cachedRepos = this.classifyRepos(await RepoDiscoveryService.discoverRepos([this.cfg.rootDir]));
    if (this.cachedRepos.length === 0) {
      console.warn(`Git Graph+: no git repositories found under ${this.cfg.rootDir}`);
    }
    this.repoPath = this.cachedRepos[0]?.path ?? this.cfg.rootDir;
    this.state = createDispatcherState(this.cachedRepos.map(r => ({ path: r.path })));

    this.bootRepo(this.repoPath);

    const httpServer = http.createServer((req, res) => this.handleHttp(req, res));
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req, socket, head) => {
      if (!this.auth.isAuthed(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });

    this.startAutoFetch();

    await new Promise<void>((resolve) => {
      httpServer.listen(this.cfg.port, this.cfg.host, () => resolve());
    });
    console.log(`Git Graph+ server listening on http://${this.cfg.host}:${this.cfg.port}`);
    console.log(`Active repo: ${this.repoPath}`);
    console.log(this.auth.isEnabled ? 'Auth: token required' : 'Auth: open (no token set)');
  }

  // RepoDiscoveryService labels a repo `root` only when a *workspace folder*
  // itself is a repo (how the extension calls it). The server instead points it
  // at a container ROOT_DIR, so top-level repos come back as `nested`. Relabel
  // repos that sit directly under ROOT_DIR as `root` to match user expectation;
  // deeper repos stay `nested` and submodules stay `submodule`.
  private classifyRepos(repos: RepoInfo[]): RepoInfo[] {
    const root = path.resolve(this.cfg.rootDir);
    return repos.map((r) =>
      r.type === 'nested' && path.dirname(path.resolve(r.path)) === root
        ? { ...r, type: 'root' }
        : r,
    );
  }

  // --- repo lifecycle ------------------------------------------------------

  private createGitService(repoPath: string): GitService {
    const svc = new GitService(repoPath);
    svc.setWarningHandler((msg) => {
      this.broadcast({ type: 'error', payload: { message: `Git Graph+: ${msg}` } });
    });
    return svc;
  }

  private bootRepo(repoPath: string): void {
    this.repoPath = repoPath;
    this.gitService = this.createGitService(repoPath);

    // One host + one dispatcher for the process lifetime; switchRepo swaps the
    // GitService in place via dispatcher.setGitService (the contract's intent).
    this.host = new WebHost(this.cfg, {
      broadcast: (m) => this.broadcast(m),
      refreshAll: () => this.refreshAll(),
      sendRepoList: (force) => this.sendRepoList(force),
      switchRepo: (p) => this.switchRepo(p),
      getRepoPath: () => this.repoPath,
    }, this.state);

    this.dispatcher = new GitDispatcher(this.gitService, this.host);

    this.watcher = new FsWatcher(repoPath, (what) => this.onRepoChanged(what));
    this.watcher.enabled = this.cfg.autoRefresh;
  }

  private async switchRepo(newPath: string): Promise<void> {
    if (newPath === this.repoPath) return;
    if (!this.cachedRepos.some(r => r.path === newPath)) {
      throw new Error(`Repo not in discovered list: ${newPath}`);
    }
    // Reset repo-specific dispatch state (mirrors MainPanel.switchRepo).
    this.state.allConflictFiles = [];
    this.state.isFirstGetLog = true;
    this.state.currentRemoteFilter = undefined;
    this.state.currentBranchFilter = undefined;

    this.repoPath = newPath;
    this.gitService = this.createGitService(newPath);
    this.dispatcher.setGitService(this.gitService);

    this.watcher?.dispose();
    this.watcher = new FsWatcher(newPath, (what) => this.onRepoChanged(what));
    this.watcher.enabled = this.cfg.autoRefresh;

    this.broadcast({
      type: 'repoList',
      payload: { repos: this.cachedRepos, active: this.repoPath },
    });
    await this.refreshAll();
  }

  private async sendRepoList(forceDiscovery = false): Promise<void> {
    if (forceDiscovery) {
      RepoDiscoveryService.clearCache();
      this.cachedRepos = this.classifyRepos(await RepoDiscoveryService.discoverRepos([this.cfg.rootDir]));
      this.state.cachedRepos = this.cachedRepos.map(r => ({ path: r.path }));
    }
    this.broadcast({
      type: 'repoList',
      payload: { repos: this.cachedRepos, active: this.repoPath },
    });
  }

  // --- refresh (mirrors MainPanel.refreshAll) ------------------------------

  private async refreshAll(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    this.refreshQueued = false;
    try {
      const sortOrder = this.cfg.graphSortOrder;
      const refreshLimit = this.state.currentLimit || 1000;
      const remoteFilter = this.state.currentRemoteFilter;
      const branchFilter = this.state.currentBranchFilter;
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
      const fg = allCommits.length > 0
        ? buildFullGraph(allCommits, branches)
        : { paths: [], links: [], dots: [], commitLeftMargin: [] };
      this.broadcast({
        type: 'fullRefresh',
        payload: {
          logData: {
            commits: allCommits, hasMore, currentLimit: this.state.currentLimit, graph: [],
            paths: fg.paths, links: fg.links, dots: fg.dots, commitLeftMargin: fg.commitLeftMargin,
            remoteFilter, branches: branchFilter,
          },
          branchData: { branches, tags, remotes, stashes, worktrees },
        },
      });
    } catch (err) {
      if (err instanceof GitError && /not a git repository/.test(err.stderr)) {
        this.broadcast({ type: 'notGitRepo' });
      } else {
        console.warn('Git Graph+: refresh failed:', err instanceof Error ? err.message : err);
      }
    } finally {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refreshAll();
      }
    }
  }

  private onRepoChanged(what: string): void {
    this.broadcast({ type: 'repoChanged', payload: { what } });
    if (shouldRefreshGraph(what)) {
      void this.refreshAll();
    }
  }

  // --- auto-fetch ----------------------------------------------------------

  private startAutoFetch(): void {
    if (!this.cfg.autoFetch) return;
    this.autoFetchTimer = setInterval(() => {
      this.gitService.fetch(undefined, {}).catch(() => { /* offline / no remote — ignore */ });
    }, this.cfg.autoFetchIntervalMs);
    // Don't keep the process alive solely for the fetch timer.
    this.autoFetchTimer.unref?.();
  }

  // --- websocket -----------------------------------------------------------

  private onConnection(ws: WebSocket): void {
    this.sockets.add(ws);

    // INIT HANDSHAKE — replicates MainPanel's constructor startup messages.
    this.send(ws, { type: 'setLocale', payload: { locale: this.cfg.locale, homeDir: this.cfg.homeDir } });
    this.send(ws, { type: 'setDefaults', payload: this.cfg.modalDefaults });
    this.send(ws, { type: 'setBadgeBarThickness', payload: { width: getBadgeBarWidth(this.cfg) } });
    this.send(ws, { type: 'repoList', payload: { repos: this.cachedRepos, active: this.repoPath } });

    ws.on('message', (data) => {
      let msg: WebviewMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      void this.dispatcher.handleMessage(msg).catch((err) => {
        console.warn('Git Graph+: dispatch error:', err instanceof Error ? err.message : err);
      });
    });

    ws.on('close', () => this.sockets.delete(ws));
    ws.on('error', () => this.sockets.delete(ws));
  }

  private send(ws: WebSocket, msg: ExtensionMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcast(msg: ExtensionMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  // --- http / static -------------------------------------------------------

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname === '/login') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => { this.auth.handleLoginRoute(req, res, body); });
      return;
    }

    if (!this.auth.isAuthed(req)) {
      this.auth.redirectToLogin(res);
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      this.serveFile(res, STANDALONE_HTML, 'text/html; charset=utf-8');
      return;
    }
    if (pathname === '/main.js') {
      this.serveFile(res, path.join(WEBVIEW_DIST, 'main.js'), 'text/javascript; charset=utf-8');
      return;
    }
    if (pathname === '/main.css') {
      this.serveFile(res, path.join(WEBVIEW_DIST, 'main.css'), 'text/css; charset=utf-8');
      return;
    }
    if (pathname === '/codicon.css') {
      this.serveFile(res, path.join(CODICON_DIST, 'codicon.css'), 'text/css; charset=utf-8');
      return;
    }
    if (pathname === '/codicon.ttf') {
      this.serveFile(res, path.join(CODICON_DIST, 'codicon.ttf'), 'font/ttf');
      return;
    }
    // Vite chunk assets (best-effort) — only serve files under dist/assets.
    if (pathname.startsWith('/assets/')) {
      const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      const filePath = path.join(WEBVIEW_DIST, safe);
      if (filePath.startsWith(WEBVIEW_DIST)) {
        this.serveFile(res, filePath, contentTypeFor(filePath));
        return;
      }
    }

    res.writeHead(404);
    res.end('Not found');
  }

  private serveFile(res: http.ServerResponse, filePath: string, contentType: string): void {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  }
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.js' ? 'text/javascript; charset=utf-8'
    : ext === '.css' ? 'text/css; charset=utf-8'
    : ext === '.ttf' ? 'font/ttf'
    : ext === '.woff2' ? 'font/woff2'
    : ext === '.svg' ? 'image/svg+xml'
    : 'application/octet-stream';
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const server = new Server(cfg);
  await server.start();
}

main().catch((err) => {
  console.error('Git Graph+ server failed to start:', err);
  process.exit(1);
});
