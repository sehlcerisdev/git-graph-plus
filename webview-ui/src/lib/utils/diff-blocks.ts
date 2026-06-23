// Locate the contiguous run of changed (add/delete) diff lines around a clicked
// line, so the revert UI can offer "revert this block" without dragging in the
// whole hunk. Line indices match the hunk's `DiffLine[]` exactly as the webview
// renders them — and exactly as the backend re-parses them (see patch-builder /
// git-parser) — so the indices can be handed straight back to the extension.

import type { DiffLine } from '../types';

export interface ChangeBlock {
  /** Indices into the hunk's `lines` array for the contiguous +/- run. */
  lineIndices: number[];
  adds: number;
  dels: number;
  /** A single source-line change (added, removed, or modified): adds<=1 && dels<=1. */
  isSingleLine: boolean;
}

/** The maximal contiguous run of changed (add/delete) lines containing `lineIndex`.
 *  Returns null if that line is context or out of range. A "block" never crosses a
 *  context line, so it stays within one hunk's change region. */
export function getChangeBlock(lines: DiffLine[], lineIndex: number): ChangeBlock | null {
  const line = lines[lineIndex];
  if (!line || line.type === 'context') { return null; }

  let start = lineIndex;
  while (start - 1 >= 0 && lines[start - 1].type !== 'context') { start--; }
  let end = lineIndex;
  while (end + 1 < lines.length && lines[end + 1].type !== 'context') { end++; }

  const lineIndices: number[] = [];
  let adds = 0;
  let dels = 0;
  for (let i = start; i <= end; i++) {
    lineIndices.push(i);
    if (lines[i].type === 'add') { adds++; }
    else if (lines[i].type === 'delete') { dels++; }
  }

  return { lineIndices, adds, dels, isSingleLine: adds <= 1 && dels <= 1 };
}
