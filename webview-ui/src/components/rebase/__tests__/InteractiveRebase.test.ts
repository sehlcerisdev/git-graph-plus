import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';
import InteractiveRebase from '../InteractiveRebase.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import type { Commit } from '../../../lib/types';

function commit(over: Partial<Commit>): Commit {
  return {
    hash: over.hash ?? 'h',
    abbreviatedHash: (over.hash ?? 'h').slice(0, 7),
    author: { name: 'A', email: 'a@x.com', date: '' },
    committer: { name: 'A', email: 'a@x.com', date: '' },
    subject: 'subject',
    body: '',
    parents: [],
    refs: [],
    ...over,
  };
}

function deliverCommits(commits: Commit[]) {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'rebaseCommitsData', payload: { commits } },
  }));
}

const baseProps = {
  base: 'baseHash1234567',
  branchName: 'feature/x',
  baseSubject: 'init',
  onClose: vi.fn(),
};

beforeEach(() => {
  i18n.setLocale('en');
  globalThis.__postedMessages = [];
});

describe('InteractiveRebase — initial flow', () => {
  it('requests rebase commits on mount with the base', () => {
    render(InteractiveRebase, baseProps);
    const req = globalThis.__postedMessages.find(
      (m) => (m.data as { type?: string }).type === 'getRebaseCommits'
    );
    expect(req).toBeDefined();
    expect((req!.data as { payload: { base: string } }).payload.base).toBe('baseHash1234567');
  });

  it('shows loading spinner before commits arrive', () => {
    const { container } = render(InteractiveRebase, baseProps);
    expect(container.querySelector('.rebase-loading')).not.toBeNull();
  });

  it('shows empty state when zero commits returned', async () => {
    const { container } = render(InteractiveRebase, baseProps);
    deliverCommits([]);
    await waitFor(() => {
      expect(container.querySelector('.rebase-empty')).not.toBeNull();
    });
  });

  it('renders one todo row per commit', async () => {
    const { container } = render(InteractiveRebase, baseProps);
    deliverCommits([
      commit({ hash: 'c1', subject: 'one' }),
      commit({ hash: 'c2', subject: 'two' }),
      commit({ hash: 'c3', subject: 'three' }),
    ]);
    await waitFor(() => {
      expect(container.querySelectorAll('.todo-item').length).toBe(3);
    });
  });
});

describe('InteractiveRebase — action changes', () => {
  it('changing an action via the dropdown updates the badge label', async () => {
    const { container } = render(InteractiveRebase, baseProps);
    deliverCommits([
      commit({ hash: 'c1', subject: 'one' }),
      commit({ hash: 'c2', subject: 'two' }),
    ]);
    await waitFor(() => container.querySelector('.todo-item'));
    const badges = container.querySelectorAll<HTMLButtonElement>('.action-badge');
    // Open the second badge dropdown (squash/fixup are disabled on the first row)
    await fireEvent.click(badges[1]);
    await waitFor(() => container.querySelector('.action-dropdown'));
    const opts = container.querySelectorAll<HTMLButtonElement>('.action-option');
    const dropOpt = Array.from(opts).find(o => o.textContent?.toLowerCase().includes('drop'))!;
    await fireEvent.click(dropOpt);
    await waitFor(() => {
      expect(badges[1].textContent?.toLowerCase()).toContain('drop');
    });
  });

  it('drop warning appears when at least one row is set to drop', async () => {
    const { container } = render(InteractiveRebase, baseProps);
    deliverCommits([
      commit({ hash: 'c1', subject: 'one' }),
      commit({ hash: 'c2', subject: 'two' }),
    ]);
    await waitFor(() => container.querySelector('.todo-item'));
    expect(container.querySelector('.rebase-warning')).toBeNull();
    const badges = container.querySelectorAll<HTMLButtonElement>('.action-badge');
    await fireEvent.click(badges[1]);
    const opts = container.querySelectorAll<HTMLButtonElement>('.action-option');
    await fireEvent.click(Array.from(opts).find(o => o.textContent?.toLowerCase().includes('drop'))!);
    await waitFor(() => {
      expect(container.querySelector('.rebase-warning')).not.toBeNull();
    });
  });

  it('squash and fixup options are disabled for the first (oldest) row', async () => {
    const { container } = render(InteractiveRebase, baseProps);
    deliverCommits([
      commit({ hash: 'c1', subject: 'one' }),
      commit({ hash: 'c2', subject: 'two' }),
    ]);
    await waitFor(() => container.querySelector('.todo-item'));
    const badges = container.querySelectorAll<HTMLButtonElement>('.action-badge');
    await fireEvent.click(badges[0]);
    const opts = container.querySelectorAll<HTMLButtonElement>('.action-option');
    const squash = Array.from(opts).find(o => o.textContent?.toLowerCase().includes('squash')) as HTMLButtonElement;
    const fixup = Array.from(opts).find(o => o.textContent?.toLowerCase().includes('fixup')) as HTMLButtonElement;
    expect(squash.disabled).toBe(true);
    expect(fixup.disabled).toBe(true);
  });

  it('selecting reword shows an editable message input', async () => {
    const { container } = render(InteractiveRebase, baseProps);
    deliverCommits([
      commit({ hash: 'c1', subject: 'one' }),
      commit({ hash: 'c2', subject: 'two' }),
    ]);
    await waitFor(() => container.querySelector('.todo-item'));
    const badges = container.querySelectorAll<HTMLButtonElement>('.action-badge');
    await fireEvent.click(badges[1]);
    const opts = container.querySelectorAll<HTMLButtonElement>('.action-option');
    await fireEvent.click(Array.from(opts).find(o => o.textContent?.toLowerCase().includes('reword'))!);
    await waitFor(() => {
      const inputs = container.querySelectorAll('.todo-message-input');
      expect(inputs.length).toBeGreaterThan(0);
    });
  });
});

describe('InteractiveRebase — submit', () => {
  it('Start button is disabled until something changes', async () => {
    const { container } = render(InteractiveRebase, baseProps);
    deliverCommits([
      commit({ hash: 'c1', subject: 'one' }),
      commit({ hash: 'c2', subject: 'two' }),
    ]);
    await waitFor(() => container.querySelector('.todo-item'));
    const start = container.querySelector<HTMLButtonElement>('button.primary')!;
    expect(start.disabled).toBe(true);
  });

  it('Start posts interactiveRebase with current todos and calls onClose', async () => {
    const onClose = vi.fn();
    const { container } = render(InteractiveRebase, { ...baseProps, onClose });
    deliverCommits([
      commit({ hash: 'c1', subject: 'one' }),
      commit({ hash: 'c2', subject: 'two' }),
    ]);
    await waitFor(() => container.querySelector('.todo-item'));
    const badges = container.querySelectorAll<HTMLButtonElement>('.action-badge');
    await fireEvent.click(badges[1]);
    const opts = container.querySelectorAll<HTMLButtonElement>('.action-option');
    await fireEvent.click(Array.from(opts).find(o => o.textContent?.toLowerCase().includes('drop'))!);
    globalThis.__postedMessages = [];
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.primary')!);
    const req = globalThis.__postedMessages.find(
      (m) => (m.data as { type?: string }).type === 'interactiveRebase'
    );
    expect(req).toBeDefined();
    const payload = (req!.data as { payload: { base: string; todos: Array<{ action: string; hash: string }> } }).payload;
    expect(payload.base).toBe('baseHash1234567');
    expect(payload.todos.map(t => t.action)).toEqual(['pick', 'drop']);
    expect(payload.todos.map(t => t.hash)).toEqual(['c1', 'c2']);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('InteractiveRebase — reordering', () => {
  it('move-down on row 0 swaps it with row 1', async () => {
    const { container } = render(InteractiveRebase, baseProps);
    deliverCommits([
      commit({ hash: 'c1', subject: 'one' }),
      commit({ hash: 'c2', subject: 'two' }),
    ]);
    await waitFor(() => container.querySelectorAll('.todo-item').length === 2);
    // Each row has [move up, move down] buttons. Click row-0's down button.
    const moveBtns = container.querySelectorAll<HTMLButtonElement>('.move-btn');
    await fireEvent.click(moveBtns[1]); // row 0, down
    await waitFor(() => {
      const hashes = Array.from(container.querySelectorAll('.todo-hash')).map(h => h.textContent?.trim());
      expect(hashes).toEqual(['c2', 'c1']);
    });
  });

  it('reordering enables the Start button (hasChanges via orderChanged)', async () => {
    const { container } = render(InteractiveRebase, baseProps);
    deliverCommits([
      commit({ hash: 'c1', subject: 'one' }),
      commit({ hash: 'c2', subject: 'two' }),
    ]);
    await waitFor(() => container.querySelectorAll('.todo-item').length === 2);
    const moveBtns = container.querySelectorAll<HTMLButtonElement>('.move-btn');
    await fireEvent.click(moveBtns[1]);
    await waitFor(() => {
      const start = container.querySelector<HTMLButtonElement>('button.primary')!;
      expect(start.disabled).toBe(false);
    });
  });

  it('move-up on row 1 swaps it with row 0', async () => {
    const { container } = render(InteractiveRebase, baseProps);
    deliverCommits([
      commit({ hash: 'c1', subject: 'one' }),
      commit({ hash: 'c2', subject: 'two' }),
    ]);
    await waitFor(() => container.querySelectorAll('.todo-item').length === 2);
    const moveBtns = container.querySelectorAll<HTMLButtonElement>('.move-btn');
    // Each row has [up, down]; row 1's up button is at index 2
    await fireEvent.click(moveBtns[2]);
    await waitFor(() => {
      const hashes = Array.from(container.querySelectorAll('.todo-hash')).map(h => h.textContent?.trim());
      expect(hashes).toEqual(['c2', 'c1']);
    });
  });

  it('drag-over from row 1 onto row 0 reorders', async () => {
    const { container } = render(InteractiveRebase, baseProps);
    deliverCommits([
      commit({ hash: 'c1', subject: 'one' }),
      commit({ hash: 'c2', subject: 'two' }),
    ]);
    await waitFor(() => container.querySelectorAll('.todo-item').length === 2);
    const items = container.querySelectorAll<HTMLDivElement>('.todo-item');
    await fireEvent.dragStart(items[1]);
    await fireEvent.dragOver(items[0]);
    await fireEvent.dragEnd(items[1]);
    await waitFor(() => {
      const hashes = Array.from(container.querySelectorAll('.todo-hash')).map(h => h.textContent?.trim());
      expect(hashes).toEqual(['c2', 'c1']);
    });
  });

  it('dragging a squash row to position 0 demotes it back to "pick"', async () => {
    const { container } = render(InteractiveRebase, baseProps);
    deliverCommits([
      commit({ hash: 'c1', subject: 'one' }),
      commit({ hash: 'c2', subject: 'two' }),
    ]);
    await waitFor(() => container.querySelectorAll('.todo-item').length === 2);
    // First set row 1 to squash
    const badges = container.querySelectorAll<HTMLButtonElement>('.action-badge');
    await fireEvent.click(badges[1]);
    const opts = container.querySelectorAll<HTMLButtonElement>('.action-option');
    await fireEvent.click(Array.from(opts).find(o => o.textContent?.toLowerCase().includes('squash'))!);
    // Move it to position 0 via drag → guardFirstItem should reset to pick
    const items = container.querySelectorAll<HTMLDivElement>('.todo-item');
    await fireEvent.dragStart(items[1]);
    await fireEvent.dragOver(items[0]);
    await fireEvent.dragEnd(items[1]);
    await waitFor(() => {
      const firstBadge = container.querySelectorAll<HTMLButtonElement>('.action-badge')[0];
      expect(firstBadge.textContent?.toLowerCase()).toContain('pick');
    });
  });

  it('clicking outside closes the open action dropdown', async () => {
    const { container } = render(InteractiveRebase, baseProps);
    deliverCommits([commit({ hash: 'c1', subject: 'one' })]);
    await waitFor(() => container.querySelector('.todo-item'));
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.action-badge')!);
    await waitFor(() => container.querySelector('.action-dropdown'));
    // Window click closes the dropdown (registered in onMount)
    await fireEvent.click(window);
    await waitFor(() => {
      expect(container.querySelector('.action-dropdown')).toBeNull();
    });
  });
});
