import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import FileDiffView from '../FileDiffView.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import type { DiffData } from '../../../lib/types';

// One replace hunk: context / delete / add / context. Indices here are exactly
// what onRevert reports and what the backend re-parses.
function sampleDiff(): DiffData {
  return {
    file: 'src/foo.ts',
    isBinary: false,
    isImage: false,
    hunks: [
      {
        header: '@@ -1,3 +1,3 @@',
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [
          { type: 'context', content: 'a', oldLineNumber: 1, newLineNumber: 1 },
          { type: 'delete', content: 'b', oldLineNumber: 2 },
          { type: 'add', content: 'b2', newLineNumber: 2 },
          { type: 'context', content: 'c', oldLineNumber: 3, newLineNumber: 3 },
        ],
      },
    ],
  };
}

beforeEach(() => i18n.setLocale('en'));
afterEach(() => cleanup());

describe('FileDiffView revert context menu', () => {
  it('reports hunk/line index and type when a changed line is right-clicked', async () => {
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onRevert });

    const lines = container.querySelectorAll('.diff-content .diff-line');
    expect(lines.length).toBe(4);

    // The added line (index 2 in the hunk).
    await fireEvent.contextMenu(lines[2]);
    expect(onRevert).toHaveBeenCalledTimes(1);
    expect(onRevert.mock.calls[0][0]).toMatchObject({
      commitHash: 'deadbeef',
      file: 'src/foo.ts',
      hunkIndex: 0,
      lineIndex: 2,
      lineType: 'add',
    });
  });

  it('still fires for context lines (parent decides what to offer)', async () => {
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), commitHash: 'deadbeef', onRevert });
    const lines = container.querySelectorAll('.diff-content .diff-line');

    await fireEvent.contextMenu(lines[0]);
    expect(onRevert.mock.calls[0][0]).toMatchObject({ lineIndex: 0, lineType: 'context' });
  });

  it('does nothing without a commit hash (compare/uncommitted view)', async () => {
    const onRevert = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), onRevert });
    const lines = container.querySelectorAll('.diff-content .diff-line');

    await fireEvent.contextMenu(lines[1]);
    expect(onRevert).not.toHaveBeenCalled();
  });
});
