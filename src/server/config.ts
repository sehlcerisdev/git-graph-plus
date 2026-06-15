import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';
import type { ModalDefaults } from '../utils/message-bus';
// Phase 1 contract: DispatcherConfig lives in dispatcher-host.ts. Imported by
// type only so config can satisfy the frozen shape.
import type { DispatcherConfig } from '../dispatcher/dispatcher-host';

// Load .env from cwd (best-effort; absent file is fine). `quiet` suppresses
// dotenv's "injected env / tip:" stdout noise so our own startup logging stays
// the only thing printed.
dotenv.config({ quiet: true });

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export interface ServerConfig {
  port: number;
  host: string;
  authToken: string; // '' means open access
  rootDir: string;
  gitBinaryPath: string; // '' means default PATH lookup
  autoRefresh: boolean;
  autoFetch: boolean;
  autoFetchIntervalMs: number;
  graphSortOrder: 'author-date' | 'date' | 'topological';
  branchBadgeBarThickness: 'thin' | 'medium' | 'thick';
  locale: string;
  homeDir: string;
  modalDefaults: ModalDefaults;
}

function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Mirrors VS Code defaults from package.json `gitGraphPlus.defaults.*`.
function defaultModalDefaults(): ModalDefaults {
  return {
    push: { force: 'none', setUpstream: true, allTags: false },
    pull: { rebase: true, stash: false },
    fetch: { allRemotes: false },
    merge: { mode: 'default', pushAfter: false, deleteSource: false },
    rebase: { autostash: false, pushAfter: false },
    amend: { keepMessage: true, resetDate: false, resetAuthor: false, only: false, pushAfter: false },
    checkout: { dirty: 'keep' },
    checkoutRemote: { dirty: 'keep' },
    createBranch: { checkout: true, publish: false },
    createTag: { push: true },
    cherryPick: { noCommit: false, pushAfter: false },
    revert: { noCommit: false, pushAfter: false },
    reset: { mode: 'mixed' },
    stashSave: { includeUntracked: true, keepIndex: false },
    deleteBranch: { force: false, deleteRemote: false },
    deleteTag: { deleteRemote: false },
    removeWorktree: { deleteBranch: false },
  };
}

function badgeBarWidth(level: 'thin' | 'medium' | 'thick'): number {
  return level === 'thick' ? 8 : level === 'medium' ? 6 : 4;
}

let cached: ServerConfig | null = null;

export function loadConfig(): ServerConfig {
  if (cached) return cached;

  const localeSetting = envStr('LOCALE', 'auto');
  const locale = localeSetting === 'auto'
    ? (process.env.LANG?.split('.')[0]?.replace('_', '-') || 'en')
    : localeSetting;

  const badge = envStr('BRANCH_BADGE_BAR_THICKNESS', 'thin') as 'thin' | 'medium' | 'thick';
  const sort = envStr('GRAPH_SORT_ORDER', 'topological') as ServerConfig['graphSortOrder'];

  cached = {
    port: envInt('PORT', 8080),
    host: envStr('HOST', '127.0.0.1'),
    authToken: envStr('AUTH_TOKEN', ''),
    rootDir: expandHome(envStr('ROOT_DIR', path.join(os.homedir(), 'projects'))),
    gitBinaryPath: envStr('GIT_BINARY_PATH', ''),
    autoRefresh: envBool('AUTO_REFRESH', true),
    autoFetch: envBool('AUTO_FETCH', true),
    autoFetchIntervalMs: envInt('AUTO_FETCH_INTERVAL_MS', 3 * 60 * 1000),
    graphSortOrder: sort,
    branchBadgeBarThickness: badge,
    locale,
    homeDir: os.homedir(),
    modalDefaults: defaultModalDefaults(),
  };
  return cached;
}

/** Build the DispatcherConfig (Phase 1 frozen shape) from the server config. */
export function getDispatcherConfig(cfg: ServerConfig = loadConfig()): DispatcherConfig {
  return {
    autoRefresh: cfg.autoRefresh,
    graphSortOrder: cfg.graphSortOrder,
    branchBadgeBarWidth: badgeBarWidth(cfg.branchBadgeBarThickness),
    modalDefaults: cfg.modalDefaults,
  };
}

export function getBadgeBarWidth(cfg: ServerConfig = loadConfig()): number {
  return badgeBarWidth(cfg.branchBadgeBarThickness);
}
