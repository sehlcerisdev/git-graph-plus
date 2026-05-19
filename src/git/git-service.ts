import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { parseLog, parseBranches, parseTags, parseRemotes, parseStashList, parseDiff, parseWorktreeList, parseLfsFiles, parseLfsLocks } from './git-parser';
import type { Commit, BranchInfo, TagInfo, RemoteInfo, StashEntry, LogOptions, DiffData, WorktreeInfo } from './types';

export class GitError extends Error {
  constructor(
    public stderr: string,
    public exitCode: number | null,
    public args: string[],
    public stdout: string = ''
  ) {
    super(`git ${args.join(' ')} failed (exit ${exitCode}): ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

/**
 * Bin an ISO-8601 timestamp (`%aI` from `git log`) by the *author's* local
 * weekday and hour, not the host's. `new Date(iso).getDay()/getHours()` would
 * convert into the machine's timezone — a 10am Seoul commit would land in
 * "evening" for someone running the extension in San Francisco. The ISO string
 * already encodes the wall-clock time and offset, so the easy fix is to parse
 * the date components directly.
 */
export function binCommitTime(iso: string): { weekday: number; hour: number } | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, day, h] = m;
  const year = parseInt(y, 10);
  const month = parseInt(mo, 10);
  const date = parseInt(day, 10);
  const hour = parseInt(h, 10);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(date) || Number.isNaN(hour)) return null;
  // Day-of-week is independent of timezone if we treat the components as UTC,
  // because the same calendar date (Y/M/D in the author's zone) always has the
  // same day-of-week regardless of the offset.
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return { weekday, hour };
}

export class GitService {
  private activityLog: Array<{ command: string; timestamp: string; success: boolean; duration: number }> = [];
  private cachedRemoteNames: string[] | null = null;
  private remoteNamesCacheTime = 0;
  private pendingRemoteNames: Promise<string[]> | null = null;
  private extraEnv: Record<string, string> = {};
  private warningHandler: ((message: string) => void) | null = null;
  private authRetryHandler: ((remote?: string) => Promise<boolean>) | null = null;
  // In-flight read-only operations, keyed by op name. Lets two callers (e.g.
  // a tree-view sidebar refresh and the webview panel refresh kicked off in
  // the same tick during repo switch) collapse onto a single git subprocess.
  private inflight = new Map<string, Promise<unknown>>();

  private dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = fn().finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }

  constructor(private repoPath: string) {}

  /** Register a callback for non-fatal warnings (e.g., auxiliary git command failures). */
  setWarningHandler(handler: ((message: string) => void) | null): void {
    this.warningHandler = handler;
  }

  /**
   * Register a callback invoked when a remote git command (fetch/pull/push)
   * fails for authentication reasons. The handler is expected to surface
   * VS Code's credential prompt (e.g., by routing through the built-in
   * `vscode.git` extension). Returning `true` means "auth flow ran; please
   * retry"; `false` means "no retry possible".
   */
  setAuthRetryHandler(handler: ((remote?: string) => Promise<boolean>) | null): void {
    this.authRetryHandler = handler;
  }

  private warn(message: string): void {
    console.warn(`Git Graph+: ${message}`);
    try { this.warningHandler?.(message); } catch { /* never let a handler break a git call */ }
  }

  /**
   * Heuristic match against stderr fragments git emits when credentials are
   * missing or wrong. SSH-key failures (`Permission denied (publickey)`) are
   * intentionally excluded — VS Code's askpass can't resolve those, so a
   * retry would just fail again.
   */
  private isAuthError(err: unknown): boolean {
    if (!(err instanceof GitError)) return false;
    const text = `${err.stderr ?? ''}\n${err.message ?? ''}`.toLowerCase();
    return (
      text.includes('authentication failed') ||
      text.includes('could not read username') ||
      text.includes('could not read password') ||
      text.includes('terminal prompts disabled') ||
      text.includes('invalid username or password') ||
      text.includes('authentication required') ||
      text.includes('http basic: access denied')
    );
  }

  /**
   * Runs a git command; on an authentication failure, asks the registered
   * auth retry handler to drive VS Code's credential prompt (same flow the
   * SCM panel uses), then retries the command once.
   */
  private async execWithAuthRetry(args: string[], remote?: string): Promise<string> {
    try {
      return await this.exec(args);
    } catch (err) {
      if (!this.isAuthError(err) || !this.authRetryHandler) throw err;
      const retried = await this.authRetryHandler(remote).catch(() => false);
      if (!retried) throw err;
      return this.exec(args);
    }
  }

  private assertSafeRef(ref: string, context: string): void {
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new GitError(`Invalid ref for ${context}`, null, []);
    }
    if (ref.startsWith('-')) {
      throw new GitError(`Ref must not start with '-': ${ref}`, null, []);
    }
  }

  /** Reject paths that escape the repo (absolute, parent traversal) or that git
   * could misinterpret as a flag. Paired with `--` in the actual command. */
  private assertSafePath(filePath: string, context: string): void {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new GitError(`Invalid path for ${context}`, null, []);
    }
    if (filePath.startsWith('-')) {
      throw new GitError(`Path must not start with '-': ${filePath}`, null, []);
    }
    if (filePath.startsWith('/') || filePath.split(/[\\/]/).includes('..')) {
      throw new GitError(`Unsafe path for ${context}: ${filePath}`, null, []);
    }
  }

  setExtraEnv(env: Record<string, string>): void {
    this.extraEnv = env;
  }

  get rootPath(): string { return this.repoPath; }

  getActivityLog() {
    return this.activityLog;
  }

  async getReflog(limit = 200, ref = 'HEAD'): Promise<{ entries: Array<{
    hash: string;
    shortHash: string;
    selector: string;
    message: string;
    date: string;
    dangling: boolean;
  }>; hasMore: boolean }> {
    const SEP = '\x1f';
    try {
      const out = await this.exec([
        'reflog', 'show', ref,
        `--format=%H${SEP}%h${SEP}%gd${SEP}%gs`,
        `--date=iso`,
        `-n`, String(limit + 1),
      ], { silent: true });

      const refName = ref === 'HEAD' ? 'HEAD' : ref.replace(/^refs\/(heads|remotes)\//, '');
      const allLines = out.trim().split('\n').filter(Boolean);
      const hasMore = allLines.length > limit;
      const lines = hasMore ? allLines.slice(0, limit) : allLines;

      const entries = lines.map((line, i) => {
        const parts = line.split(SEP);
        // %gd with --date=iso gives "HEAD@{2026-05-02 10:00:00 +0900}" — extract the date inside {}
        const rawSelector = parts[2] ?? '';
        const dateMatch = rawSelector.match(/\{([^}]+)\}/);
        return {
          hash:      parts[0] ?? '',
          shortHash: parts[1] ?? '',
          selector:  `${refName}@{${i}}`,
          message:   parts[3] ?? '',
          date:      dateMatch ? dateMatch[1] : '',
          dangling:  false,
        };
      });

      if (entries.length > 0) {
        // Probe the exact reflog hashes with `cat-file --batch-check` instead
        // of walking the 5000 newest reachable commits. The old cap caused
        // false-positive dangling flags on any repo larger than 5000 commits.
        // cat-file emits "<hash> missing" for objects that no longer exist
        // and "<hash> <type> <size>" for ones that do, so we treat the
        // entry as dangling only when explicitly reported missing.
        const uniqueHashes = Array.from(new Set(entries.map(e => e.hash).filter(Boolean)));
        if (uniqueHashes.length > 0) {
          try {
            const out = await this.exec(['cat-file', '--batch-check'], {
              silent: true,
              stdin: uniqueHashes.join('\n') + '\n',
            });
            const missing = new Set<string>();
            for (const line of out.split('\n')) {
              const m = line.match(/^([0-9a-f]+)\s+missing\b/);
              if (m) missing.add(m[1]);
            }
            for (const entry of entries) {
              entry.dangling = missing.has(entry.hash);
            }
          } catch (err) {
            this.warn(`reflog dangling detection failed: ${err instanceof Error ? err.message : err}`);
          }
        }
      }

      return { entries, hasMore };
    } catch (err) {
      // Surface real failures so the user sees that the reflog tab didn't load
      // for a reason (bad ref, permission, missing HEAD), not just an empty list.
      this.warn(`failed to get reflog: ${err instanceof Error ? err.message : err}`);
      return { entries: [], hasMore: false };
    }
  }

  private exec(args: string[], options?: { stdin?: string; timeout?: number; silent?: boolean }): Promise<string> {
    const startTime = Date.now();
    const command = `git ${args.join(' ')}`;
    const timeoutMs = options?.timeout ?? 30000;

    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, {
        cwd: this.repoPath,
        env: { ...process.env, ...this.extraEnv, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_MERGE_AUTOEDIT: 'no', GIT_EDITOR: 'true', EDITOR: 'true' },
      });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        // Force kill if SIGTERM doesn't work after 5s
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
        reject(new GitError(`Command timed out after ${timeoutMs}ms`, null, args));
      }, timeoutMs);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      if (options?.stdin) {
        proc.stdin.write(options.stdin);
        proc.stdin.end();
      }

      proc.stdout.on('data', (data: Buffer) => {
        stdoutChunks.push(data);
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderrChunks.push(data);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();
        const duration = Date.now() - startTime;
        if (!options?.silent) {
          // Truncate command for activity log to prevent memory bloat
          const logCommand = command.length > 500 ? command.substring(0, 500) + '…' : command;
          this.activityLog.unshift({
            command: logCommand,
            timestamp: new Date().toISOString(),
            success: code === 0,
            duration,
          });
          // Keep last 200 entries
          if (this.activityLog.length > 200) {
            this.activityLog.length = 200;
          }
        }

        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new GitError(stderr, code, args, stdout));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (!options?.silent) {
          this.activityLog.unshift({
            command,
            timestamp: new Date().toISOString(),
            success: false,
            duration: Date.now() - startTime,
          });
        }
        reject(new GitError(err.message, null, args));
      });
    });
  }

  async log(options?: LogOptions): Promise<Commit[]> {
    const args = [
      'log',
      '--format=%x01%x02%x03%H%x00%h%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%P%x00%D%x00%b',
    ];

    if (options?.branches && options.branches.length > 0) {
      for (const branch of options.branches) {
        this.assertSafeRef(branch, 'log');
        args.push(branch);
      }
    } else if (!options?.remoteFilter || options.remoteFilter.length === 0) {
      args.push('--glob=refs/heads', '--glob=refs/remotes', '--glob=refs/tags');
    } else {
      for (const source of options.remoteFilter) {
        if (source === 'local') {
          args.push('--glob=refs/heads');
        } else {
          args.push(`--glob=refs/remotes/${source}`);
        }
      }
      // Omit --glob=refs/tags when filtering: tags on reachable commits still appear via %D,
      // but tag-only commits outside the selected scope are correctly excluded.
    }

    args.push(
      options?.sortOrder === 'topological' ? '--topo-order' :
      options?.sortOrder === 'date' ? '--date-order' :
      '--author-date-order'
    );

    if (options?.limit) {
      args.push(`--max-count=${options.limit}`);
    }

    if (options?.skip) {
      args.push(`--skip=${options.skip}`);
    }

    if (options?.branch) {
      this.assertSafeRef(options.branch, 'log');
      args.push(options.branch);
    }

    const [raw, remoteNames, stashes] = await Promise.all([
      this.exec(args),
      this.getRemoteNames(),
      this.stashList(),
    ]);
    const commits = parseLog(raw, remoteNames);

    // Insert stash commits into the graph as separate rows
    if (stashes.length > 0) {
      const stashHashes = stashes.map(s => s.hash).filter(Boolean) as string[];
      if (stashHashes.length > 0) {
        try {
          const stashRaw = await this.exec([
            'log', '--no-walk',
            '--format=%x01%x02%x03%H%x00%h%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%P%x00%D%x00%b',
            ...stashHashes,
          ]);
          const stashCommits = parseLog(stashRaw, remoteNames);
          const stashMap = new Map(stashes.map(s => [s.hash, s]));
          const commitHashIndex = new Map<string, number>();
          for (let i = 0; i < commits.length; i++) commitHashIndex.set(commits[i].hash, i);

          const insertions: Array<{ idx: number; commit: Commit }> = [];
          for (let i = 0; i < stashCommits.length; i++) {
            const sc = stashCommits[i];
            const stash = stashMap.get(sc.hash);
            // Keep only first parent (base commit), drop index/untracked parents
            sc.parents = sc.parents.length > 0 ? [sc.parents[0]] : [];
            // Replace refs with stash badge
            sc.refs = [{ type: 'stash' as const, name: `stash@{${stash?.index ?? i}}` }];
            // Use stash message as subject
            if (stash?.message) sc.subject = stash.message;
            // Insert after the parent commit; skip if parent is outside the filtered scope
            const parentIdx = commitHashIndex.get(sc.parents[0]);
            if (parentIdx !== undefined) {
              insertions.push({ idx: parentIdx, commit: sc });
            } else if (
              (!options?.remoteFilter || options.remoteFilter.length === 0) &&
              (!options?.branches || options.branches.length === 0)
            ) {
              insertions.push({ idx: -1, commit: sc });
            }
          }
          // Sort descending so earlier splices don't shift later indices
          insertions.sort((a, b) => b.idx - a.idx);
          for (const { idx, commit } of insertions) {
            if (idx < 0) commits.unshift(commit);
            else commits.splice(idx, 0, commit);
          }
        } catch (err) { this.warn(`stash log error: ${err instanceof Error ? err.message : err}`); }
      }
    }

    if (commits.length > 0) {
      try {
        const porcelain = await this.exec(['status', '--porcelain', '-uall']);
        const lines = porcelain.split('\n').filter(Boolean);
        if (lines.length > 0) {
          let staged = 0, unstaged = 0;
          for (const line of lines) {
            const x = line[0], y = line[1];
            if (x !== ' ' && x !== '?') staged++;
            if (y !== ' ' && y !== '?') unstaged++;
            if (x === '?' && y === '?') unstaged++;
          }
          const parts: string[] = [];
          if (staged > 0) parts.push(`${staged} staged`);
          if (unstaged > 0) parts.push(`${unstaged} unstaged`);
          commits.unshift({
            hash: 'UNCOMMITTED',
            abbreviatedHash: 'UNCOMMITTED',
            parents: [],
            refs: [],
            subject: `Uncommitted changes (${lines.length})`,
            body: JSON.stringify({ staged, unstaged }),
            author: { name: '', email: '', date: '' },
            committer: { name: '', email: '', date: '' },
          });
        }
      } catch (err) {
        this.warn(`failed to check uncommitted status: ${err instanceof Error ? err.message : err}`);
      }
    }

    return commits;
  }

  private async getRemoteNames(): Promise<string[]> {
    const now = Date.now();
    if (this.cachedRemoteNames && now - this.remoteNamesCacheTime < 30000) {
      return this.cachedRemoteNames;
    }
    // Dedupe concurrent callers: if a request is already in flight, await it
    // instead of spawning a duplicate `git remote` process.
    if (this.pendingRemoteNames) {
      return this.pendingRemoteNames;
    }
    const inflight = (async () => {
      try {
        const raw = await this.exec(['remote']);
        const names = raw.trim().split('\n').filter(Boolean);
        this.cachedRemoteNames = names;
        this.remoteNamesCacheTime = Date.now();
        return names;
      } catch (err) {
        this.warn(`failed to get remote names: ${err instanceof Error ? err.message : err}`);
        return [];
      } finally {
        this.pendingRemoteNames = null;
      }
    })();
    this.pendingRemoteNames = inflight;
    return inflight;
  }

  /**
   * Returns raw `git log --graph` output alongside structured commit data.
   * The graph characters are parsed to determine exact column positions.
   */
  async branches(): Promise<BranchInfo[]> {
    return this.dedupe('branches', async () => {
      const raw = await this.exec([
        'branch', '-a', '--format=%(HEAD)%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(refname)',
      ]);
      return parseBranches(raw);
    });
  }

  async tags(): Promise<TagInfo[]> {
    return this.dedupe('tags', async () => {
      const raw = await this.exec([
        'tag', '-l', '--sort=-creatordate', '--format=%(refname:short)%00%(if)%(*objectname:short)%(then)%(*objectname:short)%(else)%(objectname:short)%(end)%00%(objecttype)%00%(contents:subject)%00%(contents:body)%01%02%03',
      ]);
      return parseTags(raw);
    });
  }

  async remotes(): Promise<RemoteInfo[]> {
    return this.dedupe('remotes', async () => {
      const raw = await this.exec(['remote', '-v']);
      return parseRemotes(raw);
    });
  }

  async stashList(): Promise<StashEntry[]> {
    return this.dedupe('stashList', async () => {
      try {
        const raw = await this.exec([
          'stash', 'list', '--format=%gd%x00%gs%x00%aI%x00%P%x00%H',
        ]);
        return parseStashList(raw);
      } catch (err) {
        console.warn('Git Graph+: failed to list stashes:', err instanceof Error ? err.message : err);
        return [];
      }
    });
  }

  // --- Diff ---

  async diff(options?: { file?: string; ref1?: string; ref2?: string }): Promise<DiffData[]> {
    const args = ['diff', '--no-color'];

    if (options?.ref1) {
      this.assertSafeRef(options.ref1, 'diff');
      args.push(options.ref1);
      if (options?.ref2) {
        this.assertSafeRef(options.ref2, 'diff');
        args.push(options.ref2);
      }
    }

    if (options?.file) {
      this.assertSafePath(options.file, 'diff');
      args.push('--', options.file);
    }

    const raw = await this.exec(args);
    return parseDiff(raw, options?.file);
  }

  // --- Branch Management ---

  async isDirty(): Promise<boolean> {
    const raw = await this.exec(['status', '--porcelain', '-uno']);
    return raw.trim().length > 0;
  }

  async getUncommittedDiff(): Promise<{ staged: Array<{ path: string; status: string }>; unstaged: Array<{ path: string; status: string }> }> {
    const raw = await this.exec(['status', '--porcelain', '-uall']);
    const staged: Array<{ path: string; status: string }> = [];
    const unstaged: Array<{ path: string; status: string }> = [];
    // Do not trim the whole output: porcelain lines may start with a space
    // (e.g. " M file" for unstaged-only modifications), and a leading trim
    // would shift the first line's columns and chop the filename's first char.
    for (const line of raw.split('\n').filter(Boolean)) {
      const x = line[0];
      const y = line[1];
      let path = line.slice(3);
      if (path.includes(' -> ')) path = path.split(' -> ')[1];
      path = path.trim();
      // Untracked entries with a trailing slash are nested git repositories that
      // aren't registered as submodules — git refuses to descend into them, so
      // they surface as a single directory entry. Strip the slash and mark them
      // so the UI can show a meaningful label instead of an empty diff.
      const isNestedRepo = x === '?' && y === '?' && path.endsWith('/');
      if (isNestedRepo) path = path.slice(0, -1);
      if (x !== ' ' && x !== '?') staged.push({ path, status: x });
      if (y !== ' ' && y !== '?') unstaged.push({ path, status: y });
      if (x === '?' && y === '?') unstaged.push({ path, status: isNestedRepo ? 'N' : 'U' });
    }
    return { staged, unstaged };
  }

  async getUncommittedFileDiff(file: string, staged: boolean): Promise<DiffData | null> {
    this.assertSafePath(file, 'diff');
    if (staged) {
      const raw = await this.exec(['diff', '--no-color', '--cached', '--', file]).catch(() => '');
      return parseDiff(raw, file)[0] ?? null;
    }
    const isTracked = await this.exec(['ls-files', '--error-unmatch', '--', file]).then(() => true).catch(() => false);
    if (!isTracked) {
      // --no-index exits with code 1 when differences found (normal); stdout has the diff
      const raw = await this.exec(['diff', '--no-color', '--no-index', '--', '/dev/null', file])
        .catch(err => (err instanceof GitError && err.exitCode === 1) ? err.stdout : '');
      return parseDiff(raw, file)[0] ?? null;
    }
    const raw = await this.exec(['diff', '--no-color', '--', file]).catch(() => '');
    return parseDiff(raw, file)[0] ?? null;
  }

  private parseNameStatus(raw: string): Array<{ path: string; status: string; oldPath?: string }> {
    return raw.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      const status = parts[0].charAt(0);
      // Renames/copies: `Rxxx\told\tnew` — expose the new path and old path.
      if ((status === 'R' || status === 'C') && parts.length >= 3) {
        return { path: parts[parts.length - 1], status, oldPath: parts[1] };
      }
      return { path: parts.slice(1).join('\t'), status };
    });
  }

  async checkout(ref: string, options?: { force?: boolean; merge?: boolean }): Promise<void> {
    this.assertSafeRef(ref, 'checkout');
    const args = ['checkout'];
    if (options?.force) { args.push('--force'); }
    if (options?.merge) { args.push('--merge'); }
    args.push(ref);
    await this.exec(args);
  }

  async clean(directories = true, force = true): Promise<void> {
    const args = ['clean'];
    if (force) { args.push('-f'); }
    if (directories) { args.push('-d'); }
    await this.exec(args);
  }

  /**
   * Check if a ref is a remote branch.
   */
  async isRemoteBranch(ref: string): Promise<boolean> {
    const slashIndex = ref.indexOf('/');
    if (slashIndex <= 0) { return false; }
    const prefix = ref.substring(0, slashIndex);
    const remoteNames = await this.getRemoteNames();
    return remoteNames.includes(prefix);
  }

  async createBranch(name: string, startPoint?: string): Promise<void> {
    this.assertSafeRef(name, 'branch');
    const args = ['branch', name];
    if (startPoint) {
      this.assertSafeRef(startPoint, 'branch');
      args.push(startPoint);
    }
    await this.exec(args);
  }

  async createAndCheckoutBranch(name: string, startPoint?: string, options?: { merge?: boolean }): Promise<void> {
    this.assertSafeRef(name, 'checkout -b');
    const args = ['checkout'];
    if (options?.merge) { args.push('--merge'); }
    args.push('-b', name);
    if (startPoint) {
      this.assertSafeRef(startPoint, 'checkout -b');
      if (await this.isRemoteBranch(startPoint)) {
        args.push('--track');
      }
      args.push(startPoint);
    }
    await this.exec(args);
  }

  async deleteBranch(name: string, force?: boolean): Promise<void> {
    this.assertSafeRef(name, 'branch -d');
    await this.exec(['branch', force ? '-D' : '-d', name]);
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    this.assertSafeRef(oldName, 'branch -m');
    this.assertSafeRef(newName, 'branch -m');
    await this.exec(['branch', '-m', oldName, newName]);
  }

  private mergeTreeCheck(ours: string, theirs: string, mergeBase?: string): Promise<{ hasConflict: boolean; files: string[] }> {
    const args = mergeBase
      ? ['merge-tree', '--write-tree', `--merge-base=${mergeBase}`, ours, theirs]
      : ['merge-tree', '--write-tree', ours, theirs];
    return new Promise((resolve) => {
      const proc = spawn('git', args, {
        cwd: this.repoPath,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      });
      const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve({ hasConflict: false, files: [] }); }, 15000);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ hasConflict: false, files: [] });
          return;
        }
        if (stderr.includes('unknown option') || stderr.includes('unrecognized argument')) {
          resolve(null as unknown as { hasConflict: boolean; files: string[] });
          return;
        }
        // git merge-tree exits 1 on a real conflict (with CONFLICT lines on
        // stdout) and ~128 on an error like a bad ref / missing object.
        // Treating every non-zero exit as conflict produced phantom
        // "0 conflicting files" banners; gate on real CONFLICT output.
        const files = stdout.split('\n')
          .filter(l => l.startsWith('CONFLICT'))
          .map(l => l.match(/in (.+)$/)?.[1])
          .filter((f): f is string => !!f);
        if (code === 1 && files.length > 0) {
          resolve({ hasConflict: true, files });
          return;
        }
        if (code === 1 && stdout.includes('CONFLICT')) {
          // Conflict signaled but path could not be parsed — still surface.
          resolve({ hasConflict: true, files: [] });
          return;
        }
        // Anything else is an error (invalid ref, missing object, OOM, ...).
        // Returning null lets the caller fall back to a no-mergeBase retry
        // when supported, or signal "no prediction available" to the UI.
        resolve(null as unknown as { hasConflict: boolean; files: string[] });
      });
      proc.on('error', () => { clearTimeout(timer); resolve({ hasConflict: false, files: [] }); });
    });
  }

  async predictConflicts(ours: string, theirs: string, mergeBase?: string): Promise<{ hasConflict: boolean; files: string[] }> {
    this.assertSafeRef(ours, 'merge-tree');
    this.assertSafeRef(theirs, 'merge-tree');
    if (mergeBase) this.assertSafeRef(mergeBase, 'merge-tree');

    if (mergeBase && this.mergeBaseSupported !== false) {
      const result = await this.mergeTreeCheck(ours, theirs, mergeBase);
      if (result !== null) {
        this.mergeBaseSupported = true;
        return result;
      }
      this.mergeBaseSupported = false;
    }
    const fallback = await this.mergeTreeCheck(ours, theirs);
    // Either branch returning null now means a real merge-tree error (bad
    // ref, missing object, etc.) rather than just "unknown option" — there
    // is no useful conflict prediction to give. Report "no conflict known"
    // so the UI surfaces a benign banner instead of a phantom warning.
    return fallback ?? { hasConflict: false, files: [] };
  }

  private mergeBaseSupported: boolean | null = null;

  async predictRebaseConflicts(branch: string, onto: string): Promise<{ hasConflict: boolean; files: string[] }> {
    this.assertSafeRef(branch, 'merge-tree');
    this.assertSafeRef(onto, 'merge-tree');

    const noPrediction = { hasConflict: false, files: [] };

    let mergeBase: string;
    try {
      mergeBase = (await this.exec(['merge-base', onto, branch], { silent: true })).trim();
    } catch {
      return (await this.mergeTreeCheck(onto, branch)) ?? noPrediction;
    }

    let commitList: string[];
    try {
      commitList = (await this.exec(['log', '--format=%H', '--reverse', `${mergeBase}..${branch}`], { silent: true }))
        .split('\n').filter(Boolean);
    } catch {
      return (await this.mergeTreeCheck(onto, branch)) ?? noPrediction;
    }

    if (commitList.length === 0) return { hasConflict: false, files: [] };

    const commits = commitList.slice(0, 20);
    const conflictFiles = new Set<string>();

    for (const commit of commits) {
      // Try per-commit check (git 2.40+): use C^ as merge base to isolate only this commit's diff
      if (this.mergeBaseSupported !== false) {
        const result = await this.mergeTreeCheck(onto, commit, `${commit}^`);
        if (result === null) {
          this.mergeBaseSupported = false;
        } else {
          this.mergeBaseSupported = true;
          if (result.hasConflict) result.files.forEach(f => conflictFiles.add(f));
          continue;
        }
      }
      // Fallback: cumulative diff from merge base
      const result = await this.mergeTreeCheck(onto, commit);
      if (result?.hasConflict) result.files.forEach(f => conflictFiles.add(f));
    }

    return { hasConflict: conflictFiles.size > 0, files: [...conflictFiles] };
  }

  async merge(branch: string, options?: { noFf?: boolean; ffOnly?: boolean; squash?: boolean }): Promise<void> {
    this.assertSafeRef(branch, 'merge');
    const args = ['merge', branch];
    if (options?.noFf) {
      args.push('--no-ff');
    }
    if (options?.ffOnly) {
      args.push('--ff-only');
    }
    if (options?.squash) {
      args.push('--squash');
    }
    await this.exec(args);
    if (options?.squash) {
      await this.exec(['commit', '--no-edit']);
    }
  }

  async abortMerge(): Promise<void> {
    await this.exec(['merge', '--abort']);
  }

  async diffCommits(ref1: string, ref2: string): Promise<DiffData[]> {
    this.assertSafeRef(ref1, 'diff');
    this.assertSafeRef(ref2, 'diff');
    const raw = await this.exec(['diff', '--no-color', ref1, ref2]);
    return parseDiff(raw);
  }

  async diffFiles(ref1: string, ref2?: string): Promise<Array<{ path: string; status: string; oldPath?: string }>> {
    this.assertSafeRef(ref1, 'diff');
    if (ref2) this.assertSafeRef(ref2, 'diff');
    const args = ['diff', '--name-status'];
    args.push(ref1);
    if (ref2) args.push(ref2);
    const raw = await this.exec(args);
    return this.parseNameStatus(raw);
  }

  private async commitParents(hash: string): Promise<string[]> {
    try {
      const raw = await this.exec(['log', '-1', '--format=%P', hash], { silent: true });
      return raw.trim().split(/\s+/).filter(Boolean);
    } catch {
      return [];
    }
  }

  async showCommitFiles(hash: string): Promise<Array<{ path: string; status: string; oldPath?: string }>> {
    this.assertSafeRef(hash, 'show');
    const parents = await this.commitParents(hash);

    if (parents.length === 0) {
      // Root commit has no parent - --root compares against empty tree
      const raw = await this.exec(['diff-tree', '--no-commit-id', '--name-status', '-r', '--root', hash]);
      return this.parseNameStatus(raw);
    }

    if (parents.length === 1) {
      const raw = await this.exec(['diff', '--name-status', `${hash}^..${hash}`]);
      return this.parseNameStatus(raw);
    }

    // Merge commit: union of files changed vs each parent. Using `hash^..hash`
    // would only show changes vs the first parent, hiding everything that
    // came in from parent 2..N (silent data loss for every octopus merge).
    const priority: Record<string, number> = { R: 5, C: 4, A: 3, D: 2, M: 1 };
    const merged = new Map<string, { path: string; status: string; oldPath?: string }>();
    const perParent = await Promise.all(parents.map(async parent => {
      this.assertSafeRef(parent, 'diff');
      const raw = await this.exec(['diff', '--name-status', `${parent}..${hash}`]);
      return this.parseNameStatus(raw);
    }));
    for (const entries of perParent) {
      for (const e of entries) {
        const existing = merged.get(e.path);
        if (!existing || (priority[e.status] ?? 0) > (priority[existing.status] ?? 0)) {
          merged.set(e.path, e);
        }
      }
    }
    return Array.from(merged.values());
  }

  async showCommitDiff(hash: string, file?: string): Promise<DiffData[]> {
    this.assertSafeRef(hash, 'show');
    if (file) this.assertSafePath(file, 'show');
    const parents = await this.commitParents(hash);

    if (parents.length === 0) {
      // Root commit: diff against empty tree.
      const args = ['show', '--no-color', '--format=', hash];
      if (file) args.push('--', file);
      const raw = await this.exec(args);
      return parseDiff(raw);
    }

    if (parents.length > 1 && file) {
      // Octopus / regular merge with a specific file: find the first parent
      // whose diff for this file is non-empty. The first-parent-only default
      // hides changes that came in from parent 2..N.
      for (const parent of parents) {
        this.assertSafeRef(parent, 'diff');
        const raw = await this.exec(['diff', '--no-color', `${parent}..${hash}`, '--', file]);
        const parsed = parseDiff(raw);
        if (parsed.length > 0 && parsed[0].hunks.length > 0) {
          return parsed;
        }
      }
      return [];
    }

    // Single-parent commit, or merge overview without a specific file.
    const args = ['diff', '--no-color', `${hash}^..${hash}`];
    if (file) args.push('--', file);
    const raw = await this.exec(args);
    return parseDiff(raw);
  }

  // --- Phase 4: Remote Management, Rebase ---

  async fetch(remote?: string, options?: { prune?: boolean }): Promise<string> {
    const args = ['fetch'];
    if (remote) {
      args.push(remote);
    } else {
      args.push('--all');
    }
    if (options?.prune) {
      args.push('--prune');
    }
    args.push('--progress');
    return this.execWithAuthRetry(args, remote);
  }

  async pull(remote?: string, branch?: string, options?: { rebase?: boolean }): Promise<string> {
    const args = ['pull'];
    if (options?.rebase) {
      args.push('--rebase');
    }
    if (remote) {
      args.push(remote);
      if (branch) {
        args.push(branch);
      }
    }
    return this.execWithAuthRetry(args, remote);
  }

  async push(remote?: string, branch?: string, options?: { force?: 'with-lease' | 'force'; setUpstream?: boolean }): Promise<string> {
    const args = ['push'];
    if (options?.force === 'force') {
      args.push('--force');
    } else if (options?.force === 'with-lease') {
      args.push('--force-with-lease');
    }
    if (options?.setUpstream) {
      args.push('-u');
    }
    if (remote) {
      args.push(remote);
      if (branch) {
        // Use full refspec to avoid ambiguity when tag and branch names collide
        args.push(`refs/heads/${branch}`);
      }
    }
    return this.execWithAuthRetry(args, remote);
  }

  async addRemote(name: string, url: string): Promise<void> {
    this.assertSafeRef(name, 'remote add');
    this.assertSafeRemoteUrl(url);
    await this.exec(['remote', 'add', name, url]);
    this.cachedRemoteNames = null;
  }

  /** Allow only well-known git transports. file:// is rejected because a
   *  malicious value could point at arbitrary local paths; users who really
   *  need it can configure it via `git remote add` directly. */
  private assertSafeRemoteUrl(url: string): void {
    if (typeof url !== 'string' || url.length === 0) {
      throw new GitError('Invalid remote URL', null, []);
    }
    if (url.startsWith('-')) {
      throw new GitError(`Remote URL must not start with '-': ${url}`, null, []);
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(url)) {
      throw new GitError('Remote URL contains control characters', null, []);
    }
    // SSH shorthand: user@host:path (no scheme). Match before scheme parsing.
    const isSshShorthand = /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:/.test(url);
    if (isSshShorthand) return;
    // Scheme-based URLs.
    const m = url.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    if (!m) {
      throw new GitError(`Unsupported remote URL: ${url}`, null, []);
    }
    const allowed = new Set(['http', 'https', 'git', 'ssh', 'git+ssh', 'git+https']);
    if (!allowed.has(m[1].toLowerCase())) {
      throw new GitError(`Unsupported remote URL scheme: ${m[1]}`, null, []);
    }
  }

  async getRemoteUrl(remote: string): Promise<string> {
    this.assertSafeRef(remote, 'remote get-url');
    const raw = await this.exec(['remote', 'get-url', remote]);
    return raw.trim();
  }

  async removeRemote(name: string): Promise<void> {
    this.assertSafeRef(name, 'remote remove');
    await this.exec(['remote', 'remove', name]);
    this.cachedRemoteNames = null;
  }

  async setUpstream(localBranch: string, remote: string, remoteBranch: string, options?: { createRemote?: boolean }): Promise<void> {
    this.assertSafeRef(localBranch, 'setUpstream');
    this.assertSafeRef(remote, 'setUpstream');
    this.assertSafeRef(remoteBranch, 'setUpstream');
    if (options?.createRemote) {
      await this.execWithAuthRetry(['push', '-u', remote, `${localBranch}:${remoteBranch}`], remote);
    } else {
      await this.exec(['branch', '--set-upstream-to', `${remote}/${remoteBranch}`, localBranch]);
    }
  }

  async rebase(onto: string, options?: { autostash?: boolean }): Promise<void> {
    this.assertSafeRef(onto, 'rebase');
    const args = ['rebase'];
    if (options?.autostash) {
      args.push('--autostash');
    }
    args.push(onto);
    await this.exec(args);
  }

  async abortRebase(): Promise<void> {
    await this.exec(['rebase', '--abort']);
  }

  async continueRebase(): Promise<void> {
    await this.exec(['rebase', '--continue']);
  }

  async skipRebase(): Promise<void> {
    await this.exec(['rebase', '--skip']);
  }

  private shellEscapeForExec(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }

  private buildMFlags(parts: string[]): string {
    return parts
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => `-m ${this.shellEscapeForExec(p)}`)
      .join(' ');
  }

  /**
   * Interactive rebase: takes a list of todo entries and applies them.
   * Each entry: { action: 'pick'|'squash'|'fixup'|'edit'|'reword'|'drop', hash: string }
   */
  async interactiveRebase(
    base: string,
    todos: Array<{ action: string; hash: string; subject: string; message?: string }>
  ): Promise<void> {
    this.assertSafeRef(base, 'rebase -i');
    // Validate inputs to prevent injection
    const validActions = ['pick', 'squash', 'fixup', 'reword', 'edit', 'drop'];
    for (const todo of todos) {
      if (!validActions.includes(todo.action)) {
        throw new GitError(`Invalid rebase action: ${todo.action}`, null, ['rebase', '-i']);
      }
      if (!/^[0-9a-f]+$/i.test(todo.hash)) {
        throw new GitError(`Invalid commit hash: ${todo.hash}`, null, ['rebase', '-i']);
      }
    }

    if (todos.length > 0 && (todos[0].action === 'squash' || todos[0].action === 'fixup')) {
      throw new GitError(
        'First rebase entry cannot be squash or fixup',
        null,
        ['rebase', '-i']
      );
    }

    // Write todo list to a temp file (avoids shell injection)
    const isSquashLike = (a: string) => a === 'squash' || a === 'fixup';
    const lines: string[] = [];
    let i = 0;

    while (i < todos.length) {
      const todo = todos[i];

      // Squash group: a non-squash target followed by one or more squash/fixup members.
      // Checked before the standalone reword path so that "reword + squash" honors the
      // user's typed final message instead of letting git's default-editor combine messages.
      const isGroupTarget =
        !isSquashLike(todo.action) &&
        i + 1 < todos.length &&
        isSquashLike(todos[i + 1].action);

      if (isGroupTarget) {
        // reword as a group target is equivalent to pick + amend, which we already do via exec below.
        const targetAction = todo.action === 'reword' ? 'pick' : todo.action;
        lines.push(`${targetAction} ${todo.hash}`);

        const finalMessage = (todo.message ?? todo.subject).trim();
        const messageChanged = finalMessage !== todo.subject.trim();
        const userWantsReword = todo.action === 'reword';
        i++;
        while (i < todos.length && isSquashLike(todos[i].action)) {
          lines.push(`${todos[i].action} ${todos[i].hash}`);
          i++;
        }
        // Force the final message when the user changed it OR explicitly chose reword on the target.
        // Without this, fixup-only groups would silently discard the user's edited message, and
        // squash groups would inherit git's default-editor combined message.
        if (finalMessage && (messageChanged || userWantsReword)) {
          lines.push(`exec git commit --amend --no-edit ${this.buildMFlags([finalMessage])}`);
        }
        continue;
      }

      // Standalone reword (no squash/fixup following).
      if (todo.action === 'reword') {
        const msg = (todo.message ?? todo.subject).trim();
        lines.push(`pick ${todo.hash}`);
        if (msg) {
          lines.push(`exec git commit --amend --no-edit ${this.buildMFlags([msg])}`);
        }
        i++;
        continue;
      }

      lines.push(`${todo.action} ${todo.hash}`);
      i++;
    }

    const todoContent = lines.join('\n') + '\n';
    const todoFile = join(this.repoPath, '.git', `ghg-rebase-todo-${randomUUID()}`);

    try {
      await writeFile(todoFile, todoContent, 'utf-8');

      // Use cp/copy to overlay the rebase-todo with our prebuilt one. The path
      // is passed via env var rather than spliced into the command string so
      // that cmd.exe / sh expansion handles repo paths containing &, |, (, ),
      // ^, etc. safely without manual escaping.
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('git', ['rebase', '-i', base], {
          cwd: this.repoPath,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            LC_ALL: 'C',
            GIT_MERGE_AUTOEDIT: 'no',
            GIT_EDITOR: 'true',
            EDITOR: 'true',
            GHG_TODO_FILE: todoFile,
            GIT_SEQUENCE_EDITOR: process.platform === 'win32'
              ? `copy /Y "%GHG_TODO_FILE%"`
              : `cp -- "$GHG_TODO_FILE"`,
          },
        });

        let stderr = '';
        proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
        proc.on('close', async (code) => {
          if (code === 0) { resolve(); return; }
          // git rebase -i exits non-zero when it intentionally pauses for an `edit`
          // step or a conflict. In both cases `.git/rebase-merge` (or rebase-apply)
          // remains on disk and the UI banner will guide the user to continue / abort.
          // Treat that as a successful "paused" outcome instead of throwing, which
          // would surface a redundant error dialog on top of the banner.
          const gitDir = join(this.repoPath, '.git');
          const paused =
            existsSync(join(gitDir, 'rebase-merge')) ||
            existsSync(join(gitDir, 'rebase-apply'));
          if (paused) { resolve(); return; }
          reject(new GitError(stderr, code, ['rebase', '-i', base]));
        });
        proc.on('error', (err) => {
          reject(new GitError(err.message, null, ['rebase', '-i', base]));
        });
      });
    } finally {
      // Clean up temp file
      await unlink(todoFile).catch(() => {});
    }
  }

  /**
   * Get commits between base and HEAD for interactive rebase preview.
   */
  async getRebaseCommits(base: string): Promise<Commit[]> {
    this.assertSafeRef(base, 'log');
    const args = [
      'log',
      '--format=%x01%x02%x03%H%x00%h%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%P%x00%D%x00%b',
      '--topo-order',
      '--reverse',
      `${base}..HEAD`,
    ];
    const [raw, remoteNames] = await Promise.all([this.exec(args), this.getRemoteNames()]);
    return parseLog(raw, remoteNames);
  }

  // --- Reset & Discard ---

  async reset(ref: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    this.assertSafeRef(ref, 'reset');
    await this.exec(['reset', `--${mode}`, ref]);
  }

  async stageFile(filePath: string): Promise<void> {
    this.assertSafePath(filePath, 'add');
    await this.exec(['add', '--', filePath]);
  }

  async getConflictFiles(): Promise<string[]> {
    try {
      const raw = await this.exec(['diff', '--name-only', '--diff-filter=U']);
      return raw.trim().split('\n').filter(Boolean);
    } catch (err) {
      console.warn('Git Graph+: failed to get conflict files:', err instanceof Error ? err.message : err);
      return [];
    }
  }

  async getOperationState(): Promise<{ type: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'squash' | null }> {
    const [merge, cherryPick, revert] = await Promise.allSettled([
      this.exec(['rev-parse', '--verify', 'MERGE_HEAD'], { silent: true }),
      this.exec(['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], { silent: true }),
      this.exec(['rev-parse', '--verify', 'REVERT_HEAD'], { silent: true }),
    ]);
    if (merge.status === 'fulfilled') return { type: 'merge' };
    // Don't rely on REBASE_HEAD: git leaves it behind after `rebase --continue`
    // succeeds, which would falsely report a rebase as still in progress. The
    // canonical marker is the rebase state directory.
    const gitDir = join(this.repoPath, '.git');
    if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) {
      return { type: 'rebase' };
    }
    if (cherryPick.status === 'fulfilled') return { type: 'cherry-pick' };
    if (revert.status === 'fulfilled') return { type: 'revert' };
    if (existsSync(join(gitDir, 'SQUASH_MSG'))) return { type: 'squash' };
    return { type: null };
  }

  async continueOperation(): Promise<void> {
    // Stage all resolved conflict files before continuing
    await this.exec(['add', '-A']);
    const state = await this.getOperationState();
    switch (state.type) {
      case 'merge': await this.exec(['commit', '--no-edit']); break;
      case 'squash': await this.exec(['commit', '--no-edit']); break;
      case 'rebase': await this.exec(['rebase', '--continue']); break;
      case 'cherry-pick': await this.exec(['cherry-pick', '--continue']); break;
      case 'revert': await this.exec(['revert', '--continue']); break;
    }
  }

  async abortOperation(): Promise<void> {
    const state = await this.getOperationState();
    switch (state.type) {
      case 'merge': await this.abortMerge(); break;
      case 'squash': await this.exec(['reset', '--hard', 'HEAD']); break;
      case 'rebase': await this.abortRebase(); break;
      case 'cherry-pick': await this.exec(['cherry-pick', '--abort']); break;
      case 'revert': await this.exec(['revert', '--abort']); break;
    }
  }

  // --- Phase 5: Stash, Cherry-pick, Revert, Tags ---

  async stashSave(message?: string, includeUntracked?: boolean, keepIndex?: boolean): Promise<void> {
    const args = ['stash', 'push'];
    if (message) {
      args.push('-m', message);
    }
    if (includeUntracked) {
      args.push('--include-untracked');
    }
    if (keepIndex) {
      args.push('--keep-index');
    }
    await this.exec(args);
  }

  async stashApply(index: number): Promise<void> {
    if (!Number.isInteger(index) || index < 0) throw new Error('Invalid stash index');
    await this.exec(['stash', 'apply', `stash@{${index}}`]);
  }

  async stashPop(index: number): Promise<void> {
    if (!Number.isInteger(index) || index < 0) throw new Error('Invalid stash index');
    await this.exec(['stash', 'pop', `stash@{${index}}`]);
  }

  async stashDrop(index: number): Promise<void> {
    if (!Number.isInteger(index) || index < 0) throw new Error('Invalid stash index');
    await this.exec(['stash', 'drop', `stash@{${index}}`]);
  }

  async stashRename(index: number, newMessage: string): Promise<void> {
    if (!Number.isInteger(index) || index < 0) throw new Error('Invalid stash index');
    const sha = (await this.exec(['rev-parse', `stash@{${index}}`])).trim();
    await this.exec(['stash', 'drop', `stash@{${index}}`]);
    await this.exec(['stash', 'store', '-m', newMessage, sha]);
  }

  async cherryPick(hash: string, options?: { noCommit?: boolean }): Promise<void> {
    this.assertSafeRef(hash, 'cherry-pick');
    const args = ['cherry-pick'];
    if (options?.noCommit) {
      args.push('--no-commit');
    }
    args.push(hash);
    await this.exec(args);
  }

  async revert(hash: string, options?: { noCommit?: boolean }): Promise<void> {
    this.assertSafeRef(hash, 'revert');
    const args = ['revert'];
    if (options?.noCommit) {
      args.push('--no-commit');
    }
    args.push(hash);
    await this.exec(args);
  }

  async createTag(name: string, ref?: string, message?: string): Promise<void> {
    this.assertSafeRef(name, 'tag');
    if (ref) this.assertSafeRef(ref, 'tag');
    const args = ['tag'];
    if (message) {
      args.push('-a', name, '-m', message);
    } else {
      args.push(name);
    }
    if (ref) {
      args.push(ref);
    }
    await this.exec(args);
  }

  async deleteTag(name: string): Promise<void> {
    this.assertSafeRef(name, 'tag -d');
    await this.exec(['tag', '-d', name]);
  }

  // --- Phase 6: Search, Commit Template ---

  async searchCommits(query: string, options?: { author?: string; after?: string; before?: string; limit?: number }): Promise<Commit[]> {
    // Defense-in-depth: reject control characters that could inject extra git
    // arguments. spawn() with explicit argv already prevents shell injection,
    // but a newline inside --grep=... lets a single user value carry multiple
    // tokens once git's own argv parser splits on whitespace in some configs.
    const reject = (v: string) => { throw new GitError(`Invalid search input: ${v}`, null, ['log']); };
    // Reject ASCII control chars (newline, CR, NUL, etc.). Spaces and printable
    // punctuation are legitimate in user queries.
    // eslint-disable-next-line no-control-regex
    const hasControl = (v: string) => /[\x00-\x1f\x7f]/.test(v);
    if (query && hasControl(query)) reject(query);
    if (options?.author && hasControl(options.author)) reject(options.author);
    if (options?.after && hasControl(options.after)) reject(options.after);
    if (options?.before && hasControl(options.before)) reject(options.before);

    const args = [
      'log',
      '--format=%x01%x02%x03%H%x00%h%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%P%x00%D%x00%b',
      '--all',
      '--topo-order',
      `--max-count=${options?.limit ?? 200}`,
    ];

    if (query) {
      args.push(`--grep=${query}`, '-i');
    }
    if (options?.author) {
      args.push(`--author=${options.author}`);
    }
    if (options?.after) {
      args.push(`--after=${options.after}`);
    }
    if (options?.before) {
      args.push(`--before=${options.before}`);
    }

    const [raw, remoteNames] = await Promise.all([this.exec(args), this.getRemoteNames()]);
    const commits = parseLog(raw, remoteNames);
    return commits;
  }

  async searchByFile(filePath: string, limit: number = 100): Promise<Commit[]> {
    this.assertSafePath(filePath, 'log');
    const args = [
      'log',
      '--format=%x01%x02%x03%H%x00%h%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%P%x00%D%x00%b',
      '--all',
      `--max-count=${limit}`,
      '--',
      filePath,
    ];
    const [raw, remoteNames] = await Promise.all([this.exec(args), this.getRemoteNames()]);
    const commits = parseLog(raw, remoteNames);
    return commits;
  }

  async searchByHash(hash: string): Promise<Commit | null> {
    try {
      this.assertSafeRef(hash, 'log');
      const args = [
        'log',
        '--format=%x01%x02%x03%H%x00%h%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%P%x00%D%x00%b',
        '-1',
        hash,
      ];
      const [raw, remoteNames] = await Promise.all([this.exec(args), this.getRemoteNames()]);
      const commits = parseLog(raw, remoteNames);
      return commits[0] ?? null;
    } catch (err) {
      console.warn('Git Graph+: failed to get commit by hash:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  // --- Bisect ---

  async bisectStart(bad?: string, good?: string): Promise<string> {
    const args = ['bisect', 'start'];
    if (bad) { this.assertSafeRef(bad, 'bisect start'); args.push(bad); }
    if (good) { this.assertSafeRef(good, 'bisect start'); args.push(good); }
    return this.exec(args);
  }

  async bisectGood(ref?: string): Promise<string> {
    const args = ['bisect', 'good'];
    if (ref) { this.assertSafeRef(ref, 'bisect good'); args.push(ref); }
    return this.exec(args);
  }

  async bisectBad(ref?: string): Promise<string> {
    const args = ['bisect', 'bad'];
    if (ref) { this.assertSafeRef(ref, 'bisect bad'); args.push(ref); }
    return this.exec(args);
  }

  async bisectSkip(): Promise<string> {
    return this.exec(['bisect', 'skip']);
  }

  async bisectReset(): Promise<string> {
    return this.exec(['bisect', 'reset']);
  }

  async bisectLog(): Promise<string> {
    return this.exec(['bisect', 'log']);
  }

  // --- Submodules ---

  async submoduleStatus(): Promise<Array<{ hash: string; path: string; status: string }>> {
    const raw = await this.exec(['submodule', 'status']);
    if (!raw.trim()) { return []; }
    return raw.trim().split('\n').filter(Boolean).map(line => {
      const match = line.match(/^([+ -U])([0-9a-f]+)\s+(\S+)/);
      if (!match) { return { hash: '', path: line.trim(), status: '?' }; }
      return { hash: match[2], path: match[3], status: match[1] === ' ' ? 'clean' : match[1] === '+' ? 'modified' : match[1] === '-' ? 'uninitialized' : 'conflict' };
    });
  }

  async submoduleUpdate(init?: boolean): Promise<string> {
    const args = ['submodule', 'update'];
    if (init) { args.push('--init', '--recursive'); }
    return this.exec(args);
  }

  // --- Git LFS ---

  /** True for LFS errors that are expected configuration limits (file:// or ssh:
   *  remote with no lock server, no remote configured, etc.) rather than real
   *  failures the user should be alerted about. */
  private isExpectedLfsFailure(stderr: string): boolean {
    const s = stderr.toLowerCase();
    return (
      s.includes('missing protocol') ||                  // file:// / unsupported remote
      s.includes('standalone transfer agent') ||          // file:// fallback hint
      s.includes('no such remote') ||
      s.includes("'origin' does not appear to be a git repository") ||
      s.includes('lfs.url') ||                            // unconfigured lock server
      s.includes('this operation requires existing locks') ||
      s.includes('not a git repository')
    );
  }

  async lfsLsFiles(): Promise<Array<{ oid: string; path: string }>> {
    try {
      const raw = await this.exec(['lfs', 'ls-files']);
      return parseLfsFiles(raw);
    } catch (err) {
      // Stay silent when git-lfs is just not installed (exitCode null = spawn
      // ENOENT) or when the failure is a known configuration limit. Only
      // surface unexpected failures so the warning channel stays signal.
      if (err instanceof GitError && err.exitCode !== null && !this.isExpectedLfsFailure(err.stderr)) {
        this.warn(`LFS ls-files failed: ${err.stderr || err.message}`);
      }
      console.warn('Git Graph+: LFS ls-files failed:', err instanceof Error ? err.message : err);
      return [];
    }
  }

  async lfsLock(file: string): Promise<string> {
    this.assertSafePath(file, 'lfs lock');
    return this.exec(['lfs', 'lock', '--', file]);
  }

  async lfsUnlock(file: string, force?: boolean): Promise<string> {
    this.assertSafePath(file, 'lfs unlock');
    const args = ['lfs', 'unlock'];
    if (force) { args.push('--force'); }
    args.push('--', file);
    return this.exec(args);
  }

  async lfsLocks(): Promise<Array<{ path: string; owner: string; id: string }>> {
    try {
      const raw = await this.exec(['lfs', 'locks']);
      return parseLfsLocks(raw);
    } catch (err) {
      if (err instanceof GitError && err.exitCode !== null && !this.isExpectedLfsFailure(err.stderr)) {
        this.warn(`LFS locks failed: ${err.stderr || err.message}`);
      }
      console.warn('Git Graph+: LFS locks failed:', err instanceof Error ? err.message : err);
      return [];
    }
  }

  // --- File tree at commit ---

  async lsTree(ref: string, path?: string): Promise<Array<{ mode: string; type: 'blob' | 'tree'; hash: string; name: string }>> {
    this.assertSafeRef(ref, 'ls-tree');
    const args = ['ls-tree', ref];
    if (path) {
      this.assertSafePath(path, 'ls-tree');
      args.push('--', path);
    }
    const raw = await this.exec(args);
    if (!raw.trim()) { return []; }
    return raw.trim().split('\n').filter(Boolean).map(line => {
      const match = line.match(/^(\d+)\s+(blob|tree)\s+([0-9a-f]+)\s+(.+)$/);
      if (!match) { return { mode: '', type: 'blob' as const, hash: '', name: line }; }
      return { mode: match[1], type: match[2] as 'blob' | 'tree', hash: match[3], name: match[4] };
    });
  }

  // --- Statistics ---

  async statsCommitsByAuthor(): Promise<Array<{ author: string; email: string; count: number }>> {
    const raw = await this.exec(['shortlog', '-sne', '--all', '--no-merges']);
    if (!raw.trim()) { return []; }
    return raw.trim().split('\n').filter(Boolean).map(line => {
      const match = line.match(/^\s*(\d+)\s+(.+?)\s+<(.+?)>$/);
      if (!match) { return { author: line.trim(), email: '', count: 0 }; }
      return { author: match[2].trim(), email: match[3].trim(), count: parseInt(match[1], 10) };
    });
  }

  async statsCommitsByWeekdayHour(): Promise<Array<{ weekday: number; hour: number; count: number }>> {
    const raw = await this.exec(['log', '--all', '--format=%aI', '--no-merges']);
    if (!raw.trim()) { return []; }
    const grid = new Map<string, number>();
    for (const line of raw.trim().split('\n').filter(Boolean)) {
      const bin = binCommitTime(line.trim());
      if (!bin) continue;
      const key = `${bin.weekday}-${bin.hour}`;
      grid.set(key, (grid.get(key) ?? 0) + 1);
    }
    return Array.from(grid.entries()).map(([key, count]) => {
      const [weekday, hour] = key.split('-').map(Number);
      return { weekday, hour, count };
    });
  }

  // --- Patch ---

  async formatPatch(hash: string): Promise<string> {
    this.assertSafeRef(hash, 'format-patch');
    return this.exec(['format-patch', '-1', hash, '--stdout']);
  }

  async diffCommitToWorking(hash: string): Promise<DiffData[]> {
    this.assertSafeRef(hash, 'diff');
    const raw = await this.exec(['diff', hash]);
    return parseDiff(raw);
  }

  // --- Git Flow ---

  async flowInit(options: {
    productionBranch: string;
    developBranch: string;
    featurePrefix: string;
    releasePrefix: string;
    hotfixPrefix: string;
    versionTagPrefix: string;
  }): Promise<string> {
    // production 브랜치 존재 여부 검증
    try {
      await this.exec(['rev-parse', '--verify', options.productionBranch]);
    } catch {
      throw new GitError(
        `Branch '${options.productionBranch}' does not exist. Create the production branch first or ensure at least one commit exists.`,
        1,
        ['flow', 'init']
      );
    }

    // git flow init -d로 기본 초기화 후 커스텀 설정 덮어쓰기
    await this.exec(['flow', 'init', '-d']);
    await this.exec(['config', 'gitflow.branch.master', options.productionBranch]);
    await this.exec(['config', 'gitflow.branch.develop', options.developBranch]);
    await this.exec(['config', 'gitflow.prefix.feature', options.featurePrefix]);
    await this.exec(['config', 'gitflow.prefix.release', options.releasePrefix]);
    await this.exec(['config', 'gitflow.prefix.hotfix', options.hotfixPrefix]);
    await this.exec(['config', 'gitflow.prefix.versiontag', options.versionTagPrefix]);

    // develop 브랜치가 없으면 생성
    try {
      await this.exec(['rev-parse', '--verify', options.developBranch]);
    } catch {
      await this.exec(['branch', options.developBranch, options.productionBranch]);
    }

    return 'Git Flow initialized';
  }

  async flowFeatureStart(name: string): Promise<string> {
    return this.exec(['flow', 'feature', 'start', name]);
  }

  async flowFeatureFinish(name: string): Promise<string> {
    return this.exec(['flow', 'feature', 'finish', name]);
  }

  async flowReleaseStart(version: string): Promise<string> {
    return this.exec(['flow', 'release', 'start', version]);
  }

  async flowReleaseFinish(version: string): Promise<string> {
    return this.exec(['flow', 'release', 'finish', '-m', version, version]);
  }

  async flowHotfixStart(version: string): Promise<string> {
    return this.exec(['flow', 'hotfix', 'start', version]);
  }

  async flowHotfixFinish(version: string): Promise<string> {
    return this.exec(['flow', 'hotfix', 'finish', '-m', version, version]);
  }

  async getFlowConfig(): Promise<{
    productionBranch: string;
    developBranch: string;
    featurePrefix: string;
    releasePrefix: string;
    hotfixPrefix: string;
    versionTagPrefix: string;
  } | null> {
    try {
      const [production, develop, feature, release, hotfix, versionTag] = await Promise.all([
        this.exec(['config', '--get', 'gitflow.branch.master']).then(s => s.trim()),
        this.exec(['config', '--get', 'gitflow.branch.develop']).then(s => s.trim()),
        this.exec(['config', '--get', 'gitflow.prefix.feature']).then(s => s.trim()),
        this.exec(['config', '--get', 'gitflow.prefix.release']).then(s => s.trim()),
        this.exec(['config', '--get', 'gitflow.prefix.hotfix']).then(s => s.trim()),
        this.exec(['config', '--get', 'gitflow.prefix.versiontag']).then(s => s.trim()).catch(() => ''),
      ]);
      return {
        productionBranch: production,
        developBranch: develop,
        featurePrefix: feature,
        releasePrefix: release,
        hotfixPrefix: hotfix,
        versionTagPrefix: versionTag,
      };
    } catch (err) { console.warn('Git Graph+: failed to get flow config:', err instanceof Error ? err.message : err); return null; }
  }

  async getFlowBranches(): Promise<{ features: string[]; releases: string[]; hotfixes: string[] }> {
    const config = await this.getFlowConfig();
    if (!config) return { features: [], releases: [], hotfixes: [] };

    const raw = await this.exec(['branch', '--list']).then(s => s.trim());
    const branches = raw.split('\n').map(b => b.replace(/^\*?\s+/, '').trim()).filter(Boolean);

    return {
      features: branches.filter(b => b.startsWith(config.featurePrefix)),
      releases: branches.filter(b => b.startsWith(config.releasePrefix)),
      hotfixes: branches.filter(b => b.startsWith(config.hotfixPrefix)),
    };
  }

  // --- Worktree ---

  async worktreeList(): Promise<WorktreeInfo[]> {
    return this.dedupe('worktreeList', async () => {
      const raw = await this.exec(['worktree', 'list', '--porcelain']);
      return parseWorktreeList(raw);
    });
  }

  async worktreeAdd(worktreePath: string, branch?: string, newBranch?: string): Promise<void> {
    if (newBranch) { this.assertSafeRef(newBranch, 'worktree add'); }
    if (branch) { this.assertSafeRef(branch, 'worktree add'); }
    const args = ['worktree', 'add'];
    if (newBranch) {
      args.push('-b', newBranch);
    }
    args.push(worktreePath);
    if (branch) {
      args.push(branch);
    }
    await this.exec(args);
  }

  async worktreeRemove(worktreePath: string, force?: boolean): Promise<void> {
    const args = ['worktree', 'remove'];
    if (force) { args.push('--force'); }
    args.push(worktreePath);
    await this.exec(args);
  }

  async worktreePrune(): Promise<void> {
    await this.exec(['worktree', 'prune']);
  }

  // --- Tag Remote Operations ---

  async pushTag(name: string, remote?: string): Promise<string> {
    this.assertSafeRef(name, 'push refs/tags');
    if (remote) { this.assertSafeRef(remote, 'push refs/tags'); }
    const r = remote || 'origin';
    return this.execWithAuthRetry(['push', r, `refs/tags/${name}`], r);
  }

  async pushTagToAllRemotes(name: string): Promise<void> {
    this.assertSafeRef(name, 'push refs/tags');
    const remotes = await this.getRemoteNames();
    for (const r of remotes) {
      await this.execWithAuthRetry(['push', r, `refs/tags/${name}`], r);
    }
  }

  async pushAllTags(remote?: string): Promise<string> {
    if (remote) { this.assertSafeRef(remote, 'push --tags'); }
    const r = remote || 'origin';
    return this.execWithAuthRetry(['push', r, '--tags'], r);
  }

  async deleteRemoteBranch(name: string, remote?: string): Promise<string> {
    this.assertSafeRef(name, 'push --delete');
    if (remote) { this.assertSafeRef(remote, 'push --delete'); }
    const r = remote || 'origin';
    return this.execWithAuthRetry(['push', r, '--delete', name], r);
  }

  async deleteRemoteTag(name: string, remote?: string): Promise<string> {
    this.assertSafeRef(name, 'push :refs/tags');
    if (remote) { this.assertSafeRef(remote, 'push :refs/tags'); }
    const r = remote || 'origin';
    return this.execWithAuthRetry(['push', r, `:refs/tags/${name}`], r);
  }

  // --- Image at ref (binary-safe) ---

  async getImageBase64(ref: string, filePath: string): Promise<string> {
    this.assertSafeRef(ref, 'show');
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new GitError('Invalid filePath for show', null, []);
    }
    // Reject absolute paths and any segment equal to '..' to keep reads within the repo tree.
    if (filePath.startsWith('/') || filePath.split(/[\\/]/).includes('..')) {
      throw new GitError(`Unsafe filePath: ${filePath}`, null, []);
    }
    const MAX_IMAGE_SIZE = 50 * 1024 * 1024; // 50MB limit
    return new Promise((resolve, reject) => {
      const proc = spawn('git', ['show', `${ref}:${filePath}`], {
        cwd: this.repoPath,
        env: { ...process.env, ...this.extraEnv, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_MERGE_AUTOEDIT: 'no', GIT_EDITOR: 'true', EDITOR: 'true' },
      });

      const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new GitError('Image load timed out', null, ['show'])); }, 30000);
      const chunks: Buffer[] = [];
      let totalSize = 0;
      proc.stdout.on('data', (data: Buffer) => {
        totalSize += data.length;
        if (totalSize > MAX_IMAGE_SIZE) { proc.kill('SIGTERM'); return; }
        chunks.push(data);
      });

      let stderr = '';
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (totalSize > MAX_IMAGE_SIZE) {
          reject(new GitError('Image file too large', null, ['show', `${ref}:${filePath}`]));
        } else if (code === 0) {
          const buffer = Buffer.concat(chunks);
          resolve(buffer.toString('base64'));
        } else {
          reject(new GitError(stderr, code, ['show', `${ref}:${filePath}`]));
        }
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new GitError(err.message, null, ['show', `${ref}:${filePath}`]));
      });
    });
  }

  async isFlowInstalled(): Promise<boolean> {
    try {
      await this.exec(['flow', 'version']);
      return true;
    } catch (err) { console.warn('Git Graph+: flow version check failed:', err instanceof Error ? err.message : err); return false; }
  }

  async isFlowInitialized(): Promise<boolean> {
    try {
      await this.exec(['config', '--get', 'gitflow.branch.master']);
      return true;
    } catch (err) { console.warn('Git Graph+: flow init check failed:', err instanceof Error ? err.message : err); return false; }
  }

}
