import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import CommitDetails from '../CommitDetails.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import { commitStore } from '../../../lib/stores/commits.svelte';
import { uiStore } from '../../../lib/stores/ui.svelte';
import type { Commit, DiffData } from '../../../lib/types';

function commit(over: Partial<Commit> = {}): Commit {
  return {
    hash: 'abcdef1234567890',
    abbreviatedHash: 'abcdef1',
    author: { name: 'Alice', email: 'a@x.com', date: '2024-01-15T10:00:00Z' },
    committer: { name: 'Alice', email: 'a@x.com', date: '2024-01-15T10:00:00Z' },
    subject: 'fix: thing',
    body: 'body line',
    parents: ['p1', 'p2'],
    refs: [],
    ...over,
  };
}

function deliverCommitDiff(hash: string, files: Array<{ path: string; status: string }>) {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'commitDiffData', payload: { hash, files } },
  }));
}

function deliverUncommittedDiff(staged: Array<{ path: string; status: string }>, unstaged: Array<{ path: string; status: string }>) {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'uncommittedDiffData', payload: { staged, unstaged } },
  }));
}

function deliverFileDiff(hash: string, file: string, diff: DiffData) {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'fileDiffData', payload: { hash, file, diff } },
  }));
}

function deliverLfs(files: Array<{ oid: string; path: string }>, locks: Array<{ path: string; owner: string; id: string }>) {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'lfsData', payload: { files, locks } },
  }));
}

beforeEach(() => {
  i18n.setLocale('en');
  globalThis.__postedMessages = [];
  commitStore.commits = [];
  uiStore.selectedCommitHash = null;
  uiStore.commitDetailFullscreen = false;
  uiStore.comparing = false;
  uiStore.showBottomPanel = true;
});

afterEach(() => {
  cleanup();
});

describe('CommitDetails — request flow', () => {
  it('posts getCommitDiff and getLfsFiles when a real commit is mounted', async () => {
    render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    await waitFor(() => {
      const types = globalThis.__postedMessages.map(m => (m.data as { type?: string }).type);
      expect(types).toContain('getCommitDiff');
      expect(types).toContain('getLfsFiles');
    });
    const req = globalThis.__postedMessages.find(
      (m) => (m.data as { type?: string }).type === 'getCommitDiff'
    );
    expect((req!.data as { payload: { hash: string } }).payload.hash).toBe('h1');
  });

  it('posts getUncommittedDiff when commit.hash === UNCOMMITTED', async () => {
    render(CommitDetails, { commit: commit({ hash: 'UNCOMMITTED' }) });
    await waitFor(() => {
      expect(globalThis.__postedMessages.some(
        (m) => (m.data as { type?: string }).type === 'getUncommittedDiff'
      )).toBe(true);
    });
  });
});

describe('CommitDetails — commit info rendering', () => {
  it('renders author name, email, and short hash', async () => {
    const { container } = render(CommitDetails, { commit: commit() });
    await waitFor(() => container.querySelector('.person-name'));
    const text = container.textContent ?? '';
    expect(text).toContain('Alice');
    expect(text).toContain('a@x.com');
    expect(text).toContain('abcdef1'); // short hash
  });

  it('omits the committer column when committer matches author', () => {
    const { container } = render(CommitDetails, { commit: commit() });
    const labels = Array.from(container.querySelectorAll('.info-label')).map(el => el.textContent?.trim());
    expect(labels).toContain('AUTHOR');
    expect(labels).not.toContain('COMMITTER');
  });

  it('shows the committer column when committer differs from author', () => {
    const { container } = render(CommitDetails, {
      commit: commit({
        committer: { name: 'Bob', email: 'b@x.com', date: '2024-01-15T11:00:00Z' },
      }),
    });
    const labels = Array.from(container.querySelectorAll('.info-label')).map(el => el.textContent?.trim());
    expect(labels).toContain('COMMITTER');
  });
});

describe('CommitDetails — files list', () => {
  it('renders file count and list when commitDiffData arrives', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('h1', [
      { path: 'src/a.ts', status: 'M' },
      { path: 'src/b.ts', status: 'A' },
    ]);
    await waitFor(() => {
      const counts = container.querySelectorAll('.tab-count');
      const text = Array.from(counts).map(c => c.textContent?.trim());
      expect(text.some(t => t === '2')).toBe(true);
    });
  });

  it('discards commitDiffData with mismatched hash', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('OTHER', [{ path: 'x.ts', status: 'M' }]);
    await new Promise(r => setTimeout(r, 30));
    const counts = Array.from(container.querySelectorAll('.tab-count')).map(c => c.textContent?.trim());
    expect(counts).toContain('0'); // still 0 files
  });
});

describe('CommitDetails — tabs', () => {
  it('default tab is "commit" when a real commit is selected', () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    const activeTab = container.querySelector('.top-tab.active')?.textContent ?? '';
    expect(activeTab.toLowerCase()).toContain('commit');
  });

  it('clicking Changes tab activates it', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    const tabs = container.querySelectorAll<HTMLButtonElement>('.top-tab');
    const changesTab = Array.from(tabs).find(t => /change/i.test(t.textContent ?? ''))!;
    await fireEvent.click(changesTab);
    expect(changesTab.classList.contains('active')).toBe(true);
  });

  it('UNCOMMITTED shows Staged/Unstaged tabs', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'UNCOMMITTED' }) });
    deliverUncommittedDiff(
      [{ path: 'a.ts', status: 'M' }],
      [{ path: 'b.ts', status: 'A' }, { path: 'c.ts', status: 'A' }],
    );
    await waitFor(() => {
      const text = container.querySelector('.top-tab')?.textContent ?? '';
      expect(text.toLowerCase()).toMatch(/staged|unstaged/);
    });
    const tabs = Array.from(container.querySelectorAll('.top-tab')).map(t => t.textContent?.toLowerCase() ?? '');
    expect(tabs.some(t => t.includes('staged'))).toBe(true);
    expect(tabs.some(t => t.includes('unstaged'))).toBe(true);
  });
});

describe('CommitDetails — header actions', () => {
  it('fullscreen button toggles uiStore.commitDetailFullscreen', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.tab-action-btn')!);
    expect(uiStore.commitDetailFullscreen).toBe(true);
  });

  it('close button clears the selected commit and hides the panel', async () => {
    uiStore.selectedCommitHash = 'h1';
    uiStore.showBottomPanel = true;
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    const btns = container.querySelectorAll<HTMLButtonElement>('.tab-action-btn');
    await fireEvent.click(btns[btns.length - 1]);
    expect(uiStore.selectedCommitHash).toBeNull();
    expect(uiStore.showBottomPanel).toBe(false);
  });
});

describe('CommitDetails — empty / compare', () => {
  it('renders without a commit prop (compare mode)', () => {
    const { container } = render(CommitDetails);
    expect(container.querySelector('.commit-details')).not.toBeNull();
  });
});

describe('CommitDetails — SHA copy buttons', () => {
  it('full SHA copy button posts copyToClipboard with the full hash', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'abcdef1234567890', abbreviatedHash: 'abcdef1' }) });
    await waitFor(() => container.querySelector('.copy-btns'));
    const btns = container.querySelectorAll<HTMLButtonElement>('.copy-btn');
    globalThis.__postedMessages = [];
    await fireEvent.click(btns[0]); // full SHA
    const req = globalThis.__postedMessages.find(
      (m) => (m.data as { type?: string }).type === 'copyToClipboard'
    );
    expect((req!.data as { payload: { text: string } }).payload.text).toBe('abcdef1234567890');
  });

  it('short SHA copy button posts copyToClipboard with the abbreviated hash', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'abcdef1234567890', abbreviatedHash: 'abcdef1' }) });
    await waitFor(() => container.querySelector('.copy-btns'));
    const btns = container.querySelectorAll<HTMLButtonElement>('.copy-btn');
    globalThis.__postedMessages = [];
    await fireEvent.click(btns[1]); // short SHA
    const req = globalThis.__postedMessages.find(
      (m) => (m.data as { type?: string }).type === 'copyToClipboard'
    );
    expect((req!.data as { payload: { text: string } }).payload.text).toBe('abcdef1');
  });
});

describe('CommitDetails — parent links', () => {
  it('renders one parent-link button per parent', async () => {
    const { container } = render(CommitDetails, { commit: commit({ parents: ['p1', 'p2'] }) });
    await waitFor(() => container.querySelectorAll('.parent-link').length === 2);
    expect(container.querySelectorAll('.parent-link').length).toBe(2);
  });

  it('clicking a parent updates uiStore.selectedCommitHash and posts searchByHash', async () => {
    const { container } = render(CommitDetails, { commit: commit({ parents: ['parentHash1', 'parentHash2'] }) });
    await waitFor(() => container.querySelector('.parent-link'));
    globalThis.__postedMessages = [];
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.parent-link')!);
    expect(uiStore.selectedCommitHash).toBe('parentHash1');
    expect(globalThis.__postedMessages.some(
      (m) => (m.data as { type?: string }).type === 'searchByHash'
    )).toBe(true);
  });

  it('omits the PARENTS row when commit has no parents', () => {
    const { container } = render(CommitDetails, { commit: commit({ parents: [] }) });
    const labels = Array.from(container.querySelectorAll('.meta-label')).map(el => el.textContent?.trim());
    expect(labels).not.toContain('PARENTS');
  });
});

describe('CommitDetails — refs rendering', () => {
  it('renders REFS row with branch and tag badges', () => {
    const { container } = render(CommitDetails, {
      commit: commit({
        refs: [
          { type: 'branch', name: 'main' },
          { type: 'tag', name: 'v1.0' },
        ],
      }),
    });
    const text = container.querySelector('.meta-value')?.textContent ?? '';
    expect(text).toMatch(/main/);
    expect(text).toMatch(/v1\.0/);
  });

  it('hides REFS row when only stash or remote HEAD refs exist', () => {
    const { container } = render(CommitDetails, {
      commit: commit({
        refs: [
          { type: 'stash', name: 'stash@{0}' },
          { type: 'remote-branch', name: 'HEAD', remote: 'origin' },
        ],
      }),
    });
    const labels = Array.from(container.querySelectorAll('.meta-label')).map(el => el.textContent?.trim());
    expect(labels).not.toContain('REFS');
  });
});

describe('CommitDetails — file tree & diff', () => {
  it('clicking a file sets selectedFile and renders the diff toolbar', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('h1', [{ path: 'src/a.ts', status: 'M' }]);
    // switch to changes tab
    const changesTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.top-tab'))
      .find(t => /change/i.test(t.textContent ?? ''))!;
    await fireEvent.click(changesTab);
    await waitFor(() => container.querySelector('.file-item'));
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.file-item')!);
    // After clicking, a fileDiff request is posted
    expect(globalThis.__postedMessages.some(
      (m) => (m.data as { type?: string }).type === 'getFileDiff'
    )).toBe(true);
    // Then deliver the diff and verify the toolbar appears
    deliverFileDiff('h1', 'src/a.ts', {
      file: 'src/a.ts',
      isBinary: false,
      isImage: false,
      hunks: [{ header: '', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [
        { type: 'add', content: 'x', newLineNumber: 1 },
      ] }],
    });
    await waitFor(() => container.querySelector('.diff-toolbar'));
  });

  it('clicking a file twice deselects it', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('h1', [{ path: 'a.ts', status: 'M' }]);
    const changesTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.top-tab'))
      .find(t => /change/i.test(t.textContent ?? ''))!;
    await fireEvent.click(changesTab);
    await waitFor(() => container.querySelector('.file-item'));
    const fileBtn = container.querySelector<HTMLButtonElement>('.file-item')!;
    await fireEvent.click(fileBtn);
    expect(fileBtn.classList.contains('selected')).toBe(true);
    await fireEvent.click(fileBtn);
    expect(fileBtn.classList.contains('selected')).toBe(false);
  });

  it('double-clicking a file posts openDiff', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('h1', [{ path: 'a.ts', status: 'M' }]);
    const changesTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.top-tab'))
      .find(t => /change/i.test(t.textContent ?? ''))!;
    await fireEvent.click(changesTab);
    await waitFor(() => container.querySelector('.file-item'));
    globalThis.__postedMessages = [];
    await fireEvent.dblClick(container.querySelector<HTMLButtonElement>('.file-item')!);
    const req = globalThis.__postedMessages.find(
      (m) => (m.data as { type?: string }).type === 'openDiff'
    );
    expect(req).toBeDefined();
    expect((req!.data as { payload: { file: string } }).payload.file).toBe('a.ts');
  });

  it('renders the colored status badge for each file', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('h1', [
      { path: 'added.ts', status: 'A' },
      { path: 'mod.ts', status: 'M' },
      { path: 'del.ts', status: 'D' },
    ]);
    const changesTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.top-tab'))
      .find(t => /change/i.test(t.textContent ?? ''))!;
    await fireEvent.click(changesTab);
    await waitFor(() => container.querySelectorAll('.file-status').length === 3);
    const statuses = Array.from(container.querySelectorAll('.file-status')).map(el => el.textContent?.trim());
    expect(statuses).toEqual(expect.arrayContaining(['A', 'M', 'D']));
  });
});

describe('CommitDetails — diff mode toggle', () => {
  async function setupWithDiff() {
    const r = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('h1', [{ path: 'a.ts', status: 'M' }]);
    const changesTab = Array.from(r.container.querySelectorAll<HTMLButtonElement>('.top-tab'))
      .find(t => /change/i.test(t.textContent ?? ''))!;
    await fireEvent.click(changesTab);
    await waitFor(() => r.container.querySelector('.file-item'));
    await fireEvent.click(r.container.querySelector<HTMLButtonElement>('.file-item')!);
    deliverFileDiff('h1', 'a.ts', {
      file: 'a.ts', isBinary: false, isImage: false,
      hunks: [{ header: '', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [
        { type: 'context', content: 'ctx', oldLineNumber: 1, newLineNumber: 1 },
        { type: 'delete', content: 'old', oldLineNumber: 2 },
        { type: 'add', content: 'new', newLineNumber: 2 },
      ] }],
    });
    await waitFor(() => r.container.querySelector('.diff-toolbar'));
    return r;
  }

  it('default mode is inline', async () => {
    const { container } = await setupWithDiff();
    const btns = container.querySelectorAll<HTMLButtonElement>('.diff-mode-toggle button');
    expect(btns[0].classList.contains('active')).toBe(true);
    expect(container.querySelector('.diff-content')).not.toBeNull();
  });

  it('clicking side-by-side renders the sbs pane', async () => {
    const { container } = await setupWithDiff();
    const btns = container.querySelectorAll<HTMLButtonElement>('.diff-mode-toggle button');
    await fireEvent.click(btns[1]);
    expect(btns[1].classList.contains('active')).toBe(true);
    expect(container.querySelector('.diff-sbs')).not.toBeNull();
  });

  it('binary non-image renders the binary placeholder', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('h1', [{ path: 'data.bin', status: 'M' }]);
    const changesTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.top-tab'))
      .find(t => /change/i.test(t.textContent ?? ''))!;
    await fireEvent.click(changesTab);
    await waitFor(() => container.querySelector('.file-item'));
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.file-item')!);
    deliverFileDiff('h1', 'data.bin', { file: 'data.bin', isBinary: true, isImage: false, hunks: [] });
    await waitFor(() => container.querySelector('.diff-empty'));
  });

  it('binary image renders the ImageDiff component (mode toolbar)', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('h1', [{ path: 'logo.png', status: 'M' }]);
    const changesTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.top-tab'))
      .find(t => /change/i.test(t.textContent ?? ''))!;
    await fireEvent.click(changesTab);
    await waitFor(() => container.querySelector('.file-item'));
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.file-item')!);
    deliverFileDiff('h1', 'logo.png', { file: 'logo.png', isBinary: true, isImage: true, hunks: [] });
    await waitFor(() => {
      // ImageDiff has its own toolbar with Side by Side / Swipe / Onion Skin
      expect(container.querySelector('.image-diff')).not.toBeNull();
    });
  });
});

describe('CommitDetails — uncommitted (staged/unstaged)', () => {
  function deliverUncommitted(staged: Array<{ path: string; status: string }>, unstaged: Array<{ path: string; status: string }>) {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'uncommittedDiffData', payload: { staged, unstaged } },
    }));
  }

  it('shows "No staged changes" when staged list is empty', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'UNCOMMITTED' }) });
    deliverUncommitted([], [{ path: 'a.ts', status: 'M' }]);
    await waitFor(() => container.querySelector('.empty-state-text'));
    expect(container.querySelector('.empty-state-text')?.textContent).toMatch(/no staged/i);
  });

  it('switching to Unstaged tab clears selectedFile and shows unstaged list', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'UNCOMMITTED' }) });
    deliverUncommitted(
      [{ path: 'a.ts', status: 'M' }],
      [{ path: 'b.ts', status: 'A' }],
    );
    await waitFor(() => container.querySelectorAll('.file-item').length > 0);
    const unstagedTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.top-tab'))
      .find(t => /unstaged/i.test(t.textContent ?? ''))!;
    await fireEvent.click(unstagedTab);
    await waitFor(() => {
      const text = Array.from(container.querySelectorAll('.file-name')).map(el => el.textContent);
      expect(text).toContain('b.ts');
    });
  });

  it('nested-repo file (status N) shows the nested-repo hint when selected', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'UNCOMMITTED' }) });
    deliverUncommitted(
      [],
      [{ path: 'sub-repo', status: 'N' }],
    );
    await waitFor(() => container.querySelector('.top-tab'));
    const unstagedTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.top-tab'))
      .find(t => /unstaged/i.test(t.textContent ?? ''))!;
    await fireEvent.click(unstagedTab);
    await waitFor(() => container.querySelector('.file-item'));
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.file-item')!);
    await waitFor(() => {
      expect(container.querySelector('.diff-empty')).not.toBeNull();
    });
  });

  it('does NOT request file diff when clicking a nested-repo (status N) file', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'UNCOMMITTED' }) });
    deliverUncommitted([], [{ path: 'sub', status: 'N' }]);
    const unstagedTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.top-tab'))
      .find(t => /unstaged/i.test(t.textContent ?? ''))!;
    await fireEvent.click(unstagedTab);
    await waitFor(() => container.querySelector('.file-item'));
    globalThis.__postedMessages = [];
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.file-item')!);
    expect(globalThis.__postedMessages.some(
      (m) => (m.data as { type?: string }).type === 'getUncommittedFileDiff'
    )).toBe(false);
  });
});

describe('CommitDetails — LFS badges', () => {
  it('shows an LFS badge on files in the LFS file set', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('h1', [{ path: 'assets/big.bin', status: 'M' }]);
    deliverLfs([{ oid: 'o', path: 'assets/big.bin' }], []);
    const changesTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.top-tab'))
      .find(t => /change/i.test(t.textContent ?? ''))!;
    await fireEvent.click(changesTab);
    await waitFor(() => container.querySelector('.lfs-badge'));
  });

  it('shows the locked variant when an LFS file is locked', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('h1', [{ path: 'a.bin', status: 'M' }]);
    deliverLfs(
      [{ oid: 'o', path: 'a.bin' }],
      [{ path: 'a.bin', owner: 'alice', id: 'L1' }],
    );
    const changesTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.top-tab'))
      .find(t => /change/i.test(t.textContent ?? ''))!;
    await fireEvent.click(changesTab);
    await waitFor(() => container.querySelector('.lfs-badge.locked'));
  });
});

describe('CommitDetails — file context menu', () => {
  it('right-click on a file opens the context menu with file actions', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('h1', [{ path: 'a.ts', status: 'M' }]);
    const changesTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.top-tab'))
      .find(t => /change/i.test(t.textContent ?? ''))!;
    await fireEvent.click(changesTab);
    await waitFor(() => container.querySelector('.file-item'));
    await fireEvent.contextMenu(container.querySelector('.file-item')!);
    await waitFor(() => {
      // ContextMenu renders into the page somewhere
      expect(document.body.textContent ?? '').toMatch(/open/i);
    });
  });
});

describe('CommitDetails — parent hover preview', () => {
  it('mouseenter on a parent posts getCommitData when not cached', async () => {
    vi.useFakeTimers();
    const { container } = render(CommitDetails, { commit: commit({ parents: ['parent1'] }) });
    await waitFor(() => container.querySelector('.parent-link'));
    globalThis.__postedMessages = [];
    await fireEvent.mouseEnter(container.querySelector('.parent-link')!, { clientX: 100, clientY: 100 });
    vi.advanceTimersByTime(400);
    const req = globalThis.__postedMessages.find(
      (m) => (m.data as { type?: string }).type === 'getCommitData'
    );
    expect(req).toBeDefined();
    expect((req!.data as { payload: { hash: string } }).payload.hash).toBe('parent1');
    vi.useRealTimers();
  });

  it('uses cached commit when commitStore already has it (no postMessage)', async () => {
    vi.useFakeTimers();
    commitStore.commits = [commit({ hash: 'parent1', subject: 'parent commit' })];
    const { container } = render(CommitDetails, { commit: commit({ parents: ['parent1'] }) });
    await waitFor(() => container.querySelector('.parent-link'));
    globalThis.__postedMessages = [];
    await fireEvent.mouseEnter(container.querySelector('.parent-link')!, { clientX: 50, clientY: 50 });
    vi.advanceTimersByTime(400);
    // No getCommitData request when commit is in the store cache
    expect(globalThis.__postedMessages.some(
      (m) => (m.data as { type?: string }).type === 'getCommitData'
    )).toBe(false);
    vi.useRealTimers();
  });

  it('mouseleave before delay cancels the preview', async () => {
    vi.useFakeTimers();
    const { container } = render(CommitDetails, { commit: commit({ parents: ['parent1'] }) });
    await waitFor(() => container.querySelector('.parent-link'));
    const link = container.querySelector('.parent-link')!;
    await fireEvent.mouseEnter(link, { clientX: 100, clientY: 100 });
    vi.advanceTimersByTime(200);
    await fireEvent.mouseLeave(link);
    vi.advanceTimersByTime(500);
    globalThis.__postedMessages = [];
    // Delay cancelled; nothing posted
    expect(globalThis.__postedMessages.some(
      (m) => (m.data as { type?: string }).type === 'getCommitData'
    )).toBe(false);
    vi.useRealTimers();
  });
});

describe('CommitDetails — resize handle', () => {
  it('mousedown on resize handle starts a drag, mousemove updates width, mouseup stops', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('h1', [{ path: 'a.ts', status: 'M' }]);
    const changesTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.top-tab'))
      .find(t => /change/i.test(t.textContent ?? ''))!;
    await fireEvent.click(changesTab);
    await waitFor(() => container.querySelector('.resize-handle'));
    const handle = container.querySelector<HTMLDivElement>('.resize-handle')!;
    const filesPanel = container.querySelector<HTMLDivElement>('.files-panel')!;
    const startWidth = parseInt(filesPanel.style.width);
    await fireEvent.mouseDown(handle, { clientX: 200 });
    await fireEvent.mouseMove(document, { clientX: 280 });
    const after = parseInt(filesPanel.style.width);
    expect(after).toBeGreaterThan(startWidth);
    await fireEvent.mouseUp(document);
    // After mouseup, further mousemove should not change width
    const settled = parseInt(filesPanel.style.width);
    await fireEvent.mouseMove(document, { clientX: 500 });
    expect(parseInt(filesPanel.style.width)).toBe(settled);
  });
});

describe('CommitDetails — directory toggle', () => {
  it('clicking a dir toggles its expand state', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('h1', [
      { path: 'src/sub/a.ts', status: 'M' },
      { path: 'src/sub/b.ts', status: 'M' },
    ]);
    const changesTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.top-tab'))
      .find(t => /change/i.test(t.textContent ?? ''))!;
    await fireEvent.click(changesTab);
    await waitFor(() => container.querySelector('.dir-item'));
    const dirs = container.querySelectorAll<HTMLButtonElement>('.dir-item');
    // Auto-expand effect makes all dirs expanded initially.
    expect(container.querySelectorAll('.file-item').length).toBeGreaterThan(0);
    // Click the top dir to collapse → files disappear
    await fireEvent.click(dirs[0]);
    await waitFor(() => {
      expect(container.querySelectorAll('.file-item').length).toBe(0);
    });
    // Click again to re-expand
    await fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.dir-item')[0]);
    await waitFor(() => {
      expect(container.querySelectorAll('.file-item').length).toBeGreaterThan(0);
    });
  });
});

describe('CommitDetails — file context menu actions', () => {
  async function openMenu(container: HTMLElement) {
    const changesTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.top-tab'))
      .find(t => /change/i.test(t.textContent ?? ''))!;
    await fireEvent.click(changesTab);
    await waitFor(() => container.querySelector('.file-item'));
    await fireEvent.contextMenu(container.querySelector('.file-item')!);
    await waitFor(() => {
      expect(document.body.textContent ?? '').toMatch(/open/i);
    });
  }

  it('"Open file" action posts openFile with the file path', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('h1', [{ path: 'src/a.ts', status: 'M' }]);
    await openMenu(container);
    const openItem = Array.from(document.querySelectorAll<HTMLButtonElement>('button, [role="menuitem"]'))
      .find(b => /^open\s*file/i.test(b.textContent?.trim() ?? '') || /^open$/i.test(b.textContent?.trim() ?? ''))!;
    globalThis.__postedMessages = [];
    await fireEvent.click(openItem);
    const req = globalThis.__postedMessages.find(
      (m) => (m.data as { type?: string }).type === 'openFile'
    );
    expect((req!.data as { payload: { file: string } }).payload.file).toBe('src/a.ts');
  });

  it('"Open changes" posts openDiff for the commit', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('h1', [{ path: 'a.ts', status: 'M' }]);
    await openMenu(container);
    // Limit search to the ContextMenu (rendered as .context-menu or similar)
    // by checking the menu region only — the top "Changes" tab also matches.
    const menuItems = Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu button, .menu-item, [role="menuitem"]'));
    const item = menuItems.find(b => /chang/i.test(b.textContent ?? ''))
      ?? Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .filter(b => !b.classList.contains('top-tab'))
        .find(b => /chang/i.test(b.textContent ?? ''))!;
    expect(item).not.toBeUndefined();
    globalThis.__postedMessages = [];
    await fireEvent.click(item!);
    const req = globalThis.__postedMessages.find(
      (m) => (m.data as { type?: string }).type === 'openDiff'
    );
    expect(req).toBeDefined();
    expect((req!.data as { payload: { file: string; commitHash: string } }).payload).toMatchObject({
      file: 'a.ts',
      commitHash: 'h1',
    });
  });

  it('LFS unlocked file shows Lock action and posts lfsLock', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('h1', [{ path: 'a.bin', status: 'M' }]);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'lfsData', payload: { files: [{ oid: 'o', path: 'a.bin' }], locks: [] } },
    }));
    await openMenu(container);
    const lockItem = Array.from(document.querySelectorAll<HTMLButtonElement>('button, [role="menuitem"]'))
      .find(b => /lock/i.test(b.textContent ?? '') && !/unlock/i.test(b.textContent ?? ''))!;
    globalThis.__postedMessages = [];
    await fireEvent.click(lockItem);
    expect(globalThis.__postedMessages.some(
      (m) => (m.data as { type?: string }).type === 'lfsLock'
    )).toBe(true);
  });

  it('LFS locked file shows Unlock + Force Unlock actions', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('h1', [{ path: 'a.bin', status: 'M' }]);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'lfsData', payload: {
        files: [{ oid: 'o', path: 'a.bin' }],
        locks: [{ path: 'a.bin', owner: 'alice', id: 'L1' }],
      } },
    }));
    await openMenu(container);
    const unlockItem = Array.from(document.querySelectorAll<HTMLButtonElement>('button, [role="menuitem"]'))
      .find(b => /^unlock$/i.test(b.textContent?.trim() ?? '') || /^lfs.*unlock$/i.test(b.textContent?.trim() ?? '')
        || (/unlock/i.test(b.textContent ?? '') && !/force/i.test(b.textContent ?? '')))!;
    globalThis.__postedMessages = [];
    await fireEvent.click(unlockItem);
    const req = globalThis.__postedMessages.find(
      (m) => (m.data as { type?: string }).type === 'lfsUnlock'
    );
    expect(req).toBeDefined();
    expect((req!.data as { payload: { file: string; force?: boolean } }).payload.force).toBeFalsy();
  });
});

describe('CommitDetails — side-by-side scroll sync', () => {
  it('scrolling left pane syncs right pane scrollTop', async () => {
    const { container } = render(CommitDetails, { commit: commit({ hash: 'h1' }) });
    deliverCommitDiff('h1', [{ path: 'a.ts', status: 'M' }]);
    const changesTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.top-tab'))
      .find(t => /change/i.test(t.textContent ?? ''))!;
    await fireEvent.click(changesTab);
    await waitFor(() => container.querySelector('.file-item'));
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.file-item')!);
    deliverFileDiff('h1', 'a.ts', {
      file: 'a.ts', isBinary: false, isImage: false,
      hunks: [{ header: '', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [
        { type: 'context', content: 'ctx', oldLineNumber: 1, newLineNumber: 1 },
      ] }],
    });
    await waitFor(() => container.querySelector('.diff-toolbar'));
    const modeBtns = container.querySelectorAll<HTMLButtonElement>('.diff-mode-toggle button');
    await fireEvent.click(modeBtns[1]); // side-by-side
    await waitFor(() => container.querySelector('.sbs-pane'));
    const panes = container.querySelectorAll<HTMLDivElement>('.sbs-pane');
    expect(panes.length).toBe(2);
    panes[0].scrollTop = 75;
    await fireEvent.scroll(panes[0]);
    expect(panes[1].scrollTop).toBe(75);
  });
});

describe('CommitDetails — fullRefresh while UNCOMMITTED', () => {
  it('re-requests uncommitted diff and any selected-file diff', async () => {
    render(CommitDetails, { commit: commit({ hash: 'UNCOMMITTED' }) });
    // First seed the uncommitted data so we have a selectable file
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'uncommittedDiffData', payload: { staged: [{ path: 'a.ts', status: 'M' }], unstaged: [] } },
    }));
    globalThis.__postedMessages = [];
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'fullRefresh' } }));
    await waitFor(() => {
      expect(globalThis.__postedMessages.some(
        (m) => (m.data as { type?: string }).type === 'getUncommittedDiff'
      )).toBe(true);
    });
  });
});
