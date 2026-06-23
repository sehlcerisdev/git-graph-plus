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

  it('offers Reverse Hunk on a context line', () => {
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert });
    const lines = container.querySelectorAll('.diff-content .diff-line');

    const ev = rightClick(lines[0]); // context line → still reverts the whole hunk
    expect(onRevert).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    const arg = onRevert.mock.calls[0][0];
    expect(arg).toMatchObject({ hunkIndex: 0 });
    expect(arg.selectedLineIndices).toBeUndefined();
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
    expect(container.querySelector('.hunk-hunk-btn')).toBeNull();
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

    const btn = container.querySelector('.hunk-hunk-btn');
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
    expect(container.querySelector('.hunk-hunk-btn')).toBeNull();
    const firstChanged = container.querySelector('.diff-content .diff-line.diff-delete')!;
    const ev = rightClick(firstChanged);
    expect(onRevert).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('FileDiffView gutter line-selection', () => {
  // The inline gutters, one per rendered line (indices match sampleDiff()).
  function gutters(container: HTMLElement): NodeListOf<Element> {
    return container.querySelectorAll('.diff-content .diff-line .line-gutter');
  }

  it('drag-selects two changed lines and reverses just those', async () => {
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert });
    const g = gutters(container);

    // Drag from the first add (4) to the second add (5).
    await fireEvent.mouseDown(g[4]);
    await fireEvent.mouseEnter(g[5]);
    await fireEvent.mouseUp(window);

    rightClick(container.querySelectorAll('.diff-content .diff-line')[5]);
    expect(onRevert).toHaveBeenCalledTimes(1);
    expect(onRevert.mock.calls[0][0]).toMatchObject({ hunkIndex: 0, selectedLineIndices: [4, 5] });
  });

  it('excludes context lines from a range that spans them', async () => {
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert });
    const g = gutters(container);

    // Select indices 2..4 — index 3 is a context line and must be dropped.
    await fireEvent.mouseDown(g[2]);
    await fireEvent.mouseEnter(g[3]);
    await fireEvent.mouseEnter(g[4]);
    await fireEvent.mouseUp(window);

    rightClick(container.querySelectorAll('.diff-content .diff-line')[4]);
    expect(onRevert.mock.calls[0][0].selectedLineIndices).toEqual([2, 4]);
  });

  it('shift-click extends the selection', async () => {
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert });
    const g = gutters(container);

    await fireEvent.mouseDown(g[1]);
    await fireEvent.mouseUp(window);
    await fireEvent.mouseDown(g[4], { shiftKey: true });
    await fireEvent.mouseUp(window);

    rightClick(container.querySelectorAll('.diff-content .diff-line')[4]);
    // 1..4 → changed lines are 1 (del), 2 (add), 4 (add); 3 is context.
    expect(onRevert.mock.calls[0][0].selectedLineIndices).toEqual([1, 2, 4]);
  });

  it('Escape clears the selection (context right-click then reverts the whole hunk)', async () => {
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert });
    const g = gutters(container);

    await fireEvent.mouseDown(g[4]);
    await fireEvent.mouseEnter(g[5]);
    await fireEvent.mouseUp(window);
    await fireEvent.keyDown(window, { key: 'Escape' });

    // With the selection cleared, a context-line right-click reverts the whole
    // hunk (no selected lines).
    rightClick(container.querySelectorAll('.diff-content .diff-line')[6]); // context line
    expect(onRevert).toHaveBeenCalledTimes(1);
    expect(onRevert.mock.calls[0][0]).toMatchObject({ hunkIndex: 0 });
    expect(onRevert.mock.calls[0][0].selectedLineIndices).toBeUndefined();
  });

  it('keeps an active selection when right-clicking the gutter (right-click does not reset it)', async () => {
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert });
    const g = gutters(container);

    // Drag-select the two adds (4, 5).
    await fireEvent.mouseDown(g[4]);
    await fireEvent.mouseEnter(g[5]);
    await fireEvent.mouseUp(window);

    // A right-click mousedown in the gutter must NOT collapse the selection.
    await fireEvent.mouseDown(g[1], { button: 2 });

    rightClick(container.querySelectorAll('.diff-content .diff-line')[1]);
    expect(onRevert).toHaveBeenCalledTimes(1);
    expect(onRevert.mock.calls[0][0]).toMatchObject({ hunkIndex: 0, selectedLineIndices: [4, 5] });
  });

  it('renders a Reverse Lines button that reverts the selection on click', async () => {
    const onRevert = vi.fn();
    const onRevertLines = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert, onRevertLines });
    const g = gutters(container);

    await fireEvent.mouseDown(g[4]);
    await fireEvent.mouseEnter(g[5]);
    await fireEvent.mouseUp(window);

    const btn = container.querySelector('.hunk-lines-btn');
    expect(btn).not.toBeNull();
    await fireEvent.click(btn!);
    expect(onRevertLines).toHaveBeenCalledTimes(1);
    expect(onRevertLines.mock.calls[0][0]).toMatchObject({ hunkIndex: 0, lineIndices: [4, 5] });
  });

  it('applies the line-selected class to selected lines', async () => {
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert: vi.fn() });
    const g = gutters(container);

    await fireEvent.mouseDown(g[4]);
    await fireEvent.mouseEnter(g[5]);
    await fireEvent.mouseUp(window);

    const lines = container.querySelectorAll('.diff-content .diff-line');
    expect(lines[4].classList.contains('line-selected')).toBe(true);
    expect(lines[5].classList.contains('line-selected')).toBe(true);
    expect(lines[0].classList.contains('line-selected')).toBe(false);
  });

  it('clears the selection when switching to side-by-side (no stale invisible selection)', async () => {
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert });
    const g = gutters(container);

    await fireEvent.mouseDown(g[4]);
    await fireEvent.mouseEnter(g[5]);
    await fireEvent.mouseUp(window);

    // Toggle to side-by-side (second button in the mode toggle).
    const sbsBtn = container.querySelectorAll('.diff-mode-toggle button')[1];
    await fireEvent.click(sbsBtn);

    // Right-clicking a changed line in SBS reverses the hunk, not a stale selection.
    const addLine = container.querySelector('.sbs-right .diff-line.diff-add')!;
    rightClick(addLine);
    expect(onRevert).toHaveBeenCalledTimes(1);
    expect(onRevert.mock.calls[0][0].selectedLineIndices).toBeUndefined();
  });

  it('offers Reverse Hunk for a right-click anywhere in an SBS hunk (including empty rows)', async () => {
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert });

    const sbsBtn = container.querySelectorAll('.diff-mode-toggle button')[1];
    await fireEvent.click(sbsBtn);

    // Right-click an empty placeholder row inside an SBS hunk → bubbles to the
    // wrapper and offers Reverse Hunk.
    const emptyRow = container.querySelector('.diff-sbs .diff-empty-line')!;
    const ev = rightClick(emptyRow);
    expect(onRevert).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    expect(onRevert.mock.calls[0][0]).toMatchObject({ hunkIndex: 0 });
    expect(onRevert.mock.calls[0][0].selectedLineIndices).toBeUndefined();
  });
});
