import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import FileDiffView from '../FileDiffView.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import type { DiffData } from '../../../lib/types';

// One hunk holding two separate change blocks split by a context line. Indices
// here are exactly what onRevert reports and what the backend re-parses.
//   0 ctx a
//   1 del b
//   2 add b2     ← block A (modify pair: indices 1,2)
//   3 ctx c
//   4 add d1
//   5 add d2     ← block B (multi-add: indices 4,5)
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
  it('reports the contiguous block for a changed line (modify pair)', () => {
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert });

    const lines = container.querySelectorAll('.diff-content .diff-line');
    expect(lines.length).toBe(7);

    // Right-click the added line of the modify pair (index 2). Block = [1, 2].
    const ev = rightClick(lines[2]);
    expect(onRevert).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    expect(onRevert.mock.calls[0][0]).toMatchObject({
      commitHash: 'deadbeef',
      file: 'src/foo.ts',
      hunkIndex: 0,
      blockLineIndices: [1, 2],
      isSingleLine: true,
    });
  });

  it('reports only the second block when its line is clicked', () => {
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert });
    const lines = container.querySelectorAll('.diff-content .diff-line');

    rightClick(lines[5]); // second add of block B
    expect(onRevert.mock.calls[0][0]).toMatchObject({ blockLineIndices: [4, 5], isSingleLine: false });
  });

  it('does not fire and preserves the native menu for context lines', () => {
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'M', onRevert });
    const lines = container.querySelectorAll('.diff-content .diff-line');

    const ev = rightClick(lines[0]); // context line
    expect(onRevert).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('does not fire for changed lines in a wholly-added file', () => {
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', fileStatus: 'A', onRevert });
    const lines = container.querySelectorAll('.diff-content .diff-line');

    const ev = rightClick(lines[2]);
    expect(onRevert).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
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
});
