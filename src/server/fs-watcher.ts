import * as path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import { resolveGitDirs, classifyPath } from '../services/file-watcher-helpers';

/**
 * chokidar-based replacement for the vscode FileWatcher. Watches the active
 * repo's gitdir (HEAD, refs/**, index, packed-refs, config, worktrees/) and
 * classifies each change via the shared helpers, debouncing bursts before
 * firing the callback. Honors an `enabled` flag (autoRefresh).
 */
export class FsWatcher {
  public enabled = true;
  private watcher: FSWatcher | null = null;
  private readonly gitDir: string;
  private readonly commonDir: string;
  private pending: 'refs' | 'status' | 'operation' | 'unknown' | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    repoPath: string,
    private readonly onChange: (what: string) => void,
    private readonly debounceMs = 250,
  ) {
    const { gitDir, commonDir } = resolveGitDirs(repoPath);
    this.gitDir = gitDir;
    this.commonDir = commonDir;
    this.start();
  }

  private start(): void {
    // Watch both the per-worktree gitdir and the shared commondir (they differ
    // only for linked worktrees). De-dup if identical.
    const dirs = this.gitDir === this.commonDir ? [this.gitDir] : [this.gitDir, this.commonDir];

    this.watcher = chokidar.watch(dirs, {
      ignoreInitial: true,
      depth: 6,
      // The objects/ dir churns constantly during fetch/gc and never changes
      // the graph by itself; skip it to avoid refresh storms.
      ignored: (p: string) => /[\\/]objects[\\/]/.test(p) || p.endsWith('.lock'),
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });

    const handler = (changedPath: string) => {
      if (!this.enabled) return;
      const what = classifyPath(path.resolve(changedPath), this.gitDir, this.commonDir);
      this.schedule(what);
    };

    this.watcher.on('add', handler).on('change', handler).on('unlink', handler);
  }

  private schedule(what: 'refs' | 'status' | 'operation' | 'unknown'): void {
    // 'refs' beats 'status' beats everything; keep the highest-priority signal.
    const rank = { refs: 3, operation: 2, status: 1, unknown: 0 } as const;
    if (this.pending === null || rank[what] > rank[this.pending]) {
      this.pending = what;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const w = this.pending;
      this.pending = null;
      this.timer = null;
      if (w) this.onChange(w);
    }, this.debounceMs);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    void this.watcher?.close();
    this.watcher = null;
  }
}
