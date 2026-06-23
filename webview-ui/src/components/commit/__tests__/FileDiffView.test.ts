import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import FileDiffView from '../FileDiffView.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import type { DiffData } from '../../../lib/types';

// One hunk holding two separate change blocks split by a context line. The whole
// hunk is the revert unit now, so the clicked line only identifies its hunk.
//   0 ctx a
//   1 del b
//   2 add b2
//   3 ctx c
//   4 add d1
//   5 add d2
//   6 ctx e
function sampleDiff(): DiffData {
  return {
    file: 'src/foo.ts',
    isBinary: false,
    isImage: false,
    hunks: [
      {
        header: '@@ -1,4 +1,5 @@',
        oldStart: 1,
        oldLines: 4,
        newStart: 1,
        newLines: 5,
        lines: [
          { type: 'context', content: 'a', oldLineNumber: 1, newLineNumber: 1 },
          { type: 'delete', content: 'b', oldLineNumber: 2 },
          { type: 'add', content: 'b2', newLineNumber: 2 },
          { type: 'context', content: 'c', oldLineNumber: 3, newLineNumber: 3 },
          { type: 'add', content: 'd1', newLineNumber: 4 },
          { type: 'add', content: 'd2', newLineNumber: 5 },
          { type: 'context', content: 'e', oldLineNumber: 4, newLineNumber: 6 },
        ],
      },
    ],
  };
}

// A diff whose single hunk exceeds MAX_RENDER_LINES (3000), so it renders
// truncated. Reverting must be disabled for the partially-shown hunk to avoid
// silently undoing the unseen tail.
function hugeDiff(): DiffData {
  const lines = [
    { type: 'delete' as const, content: 'old', oldLineNumber: 1 },
    { type: 'add' as const, content: 'new', newLineNumber: 1 },
  ];
  for (let i = 0; i < 3100; i++) {
    lines.push({ type: 'context' as const, content: `ctx${i}`, oldLineNumber: i + 2, newLineNumber: i + 2 } as never);
  }
  return {
    file: 'src/big.ts',
    isBinary: false,
    isImage: false,
    hunks: [{ header: '@@ -1,3101 +1,3101 @@', oldStart: 1, oldLines: 3101, newStart: 1, newLines: 3101, lines }],
  };
}

// Dispatch a real contextmenu MouseEvent we can inspect afterwards (so we can
// assert preventDefault was / wasn't called).
function rightClick(el: Element): MouseEvent {
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 });
  el.dispatchEvent(ev);
  return ev;
}

beforeEach(() => i18n.setLocale('en'));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('FileDiffView revert context menu', () => {
  it('reports the hunk for a changed line', () => {
    const onRevert = vi.fn();
    const onRevertHunk = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert, onRevertHunk });

    const lines = container.querySelectorAll('.diff-content .diff-line');
    expect(lines.length).toBe(7);

    // Right-click the added line of the modify pair (index 2) → hunk 0.
    const ev = rightClick(lines[2]);
    expect(onRevert).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    const arg = onRevert.mock.calls[0][0];
    expect(arg).toMatchObject({ commitHash: 'deadbeef', file: 'src/foo.ts', hunkIndex: 0 });
    expect(arg).not.toHaveProperty('blockLineIndices');
    expect(arg).not.toHaveProperty('isSingleLine');
  });

  it('reports the same hunk regardless of which changed line is clicked', () => {
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert });
    const lines = container.querySelectorAll('.diff-content .diff-line');

    rightClick(lines[5]); // second add of the second block, still hunk 0
    expect(onRevert.mock.calls[0][0]).toMatchObject({ hunkIndex: 0 });
  });

  it('does not fire and preserves the native menu for context lines', () => {
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert });
    const lines = container.querySelectorAll('.diff-content .diff-line');

    const ev = rightClick(lines[0]); // context line
    expect(onRevert).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('does not fire and hides the hunk revert button for a wholly-added file', () => {
    const onRevert = vi.fn();
    const onRevertHunk = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'A', onRevert, onRevertHunk });
    const lines = container.querySelectorAll('.diff-content .diff-line');

    const ev = rightClick(lines[2]);
    expect(onRevert).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
    // canRevert is false → no per-hunk revert button.
    expect(container.querySelector('.hunk-revert-btn')).toBeNull();
  });

  it('does nothing without a commit hash (compare/uncommitted view)', () => {
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), fileStatus: 'M', onRevert });
    const lines = container.querySelectorAll('.diff-content .diff-line');

    rightClick(lines[2]);
    expect(onRevert).not.toHaveBeenCalled();
  });

  it('forwards the current text selection', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'picked text' } as unknown as Selection);
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert });
    const lines = container.querySelectorAll('.diff-content .diff-line');

    rightClick(lines[2]);
    expect(onRevert.mock.calls[0][0]).toMatchObject({ selectionText: 'picked text' });
  });

  it('renders a per-hunk revert button that reverts the hunk on click', async () => {
    const onRevert = vi.fn();
    const onRevertHunk = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert, onRevertHunk });

    const btn = container.querySelector('.hunk-revert-btn');
    expect(btn).not.toBeNull();

    await fireEvent.click(btn!);
    expect(onRevertHunk).toHaveBeenCalledTimes(1);
    expect(onRevertHunk.mock.calls[0][0]).toEqual({ commitHash: 'deadbeef', file: 'src/foo.ts', hunkIndex: 0 });
  });

  it('disables revert on a truncated hunk (avoids reverting unseen lines)', () => {
    const onRevert = vi.fn();
    const onRevertHunk = vi.fn();
    const { container } = render(FileDiffView, { diff: hugeDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert, onRevertHunk });

    // The hunk is rendered partially, so no revert button and right-click is a no-op.
    expect(container.querySelector('.hunk-revert-btn')).toBeNull();
    const firstChanged = container.querySelector('.diff-content .diff-line.diff-delete')!;
    const ev = rightClick(firstChanged);
    expect(onRevert).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});
