import { describe, it, expect } from 'vitest';
import { buildRevertPatch } from '../patch-builder';
import { parseDiff } from '../git-parser';

// A replace hunk (delete + two adds) plus surrounding context, the shape the
// webview hands back line indices for.
const SAMPLE = `diff --git a/file.txt b/file.txt
index 1111111..2222222 100644
--- a/file.txt
+++ b/file.txt
@@ -1,4 +1,5 @@
 line1
-line2
+line2-changed
+line2b
 line3
 line4
`;

describe('buildRevertPatch', () => {
  it('reverts a whole hunk verbatim with recounted header', () => {
    const patch = buildRevertPatch(SAMPLE, 0);
    expect(patch).toBe(
      [
        'diff --git a/file.txt b/file.txt',
        'index 1111111..2222222 100644',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1,4 +1,5 @@',
        ' line1',
        '-line2',
        '+line2-changed',
        '+line2b',
        ' line3',
        ' line4',
        '',
      ].join('\n'),
    );
  });

  it('demotes unselected additions to context and drops unselected deletions', () => {
    // Revert only the second added line (index 3 in the parsed hunk).
    const hunk = parseDiff(SAMPLE)[0].hunks[0];
    const idx = hunk.lines.findIndex((l) => l.type === 'add' && l.content === 'line2b');
    expect(idx).toBe(3);

    const patch = buildRevertPatch(SAMPLE, 0, [idx]);
    expect(patch).toBe(
      [
        'diff --git a/file.txt b/file.txt',
        'index 1111111..2222222 100644',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1,4 +1,5 @@',
        ' line1',
        ' line2-changed', // unselected add → context (stays in working tree)
        '+line2b', //         selected add → reversed away
        ' line3',
        ' line4',
        '',
      ].join('\n'),
    );
  });

  it('keeps a selected deletion so reverse-apply restores it', () => {
    const hunk = parseDiff(SAMPLE)[0].hunks[0];
    const idx = hunk.lines.findIndex((l) => l.type === 'delete');
    const patch = buildRevertPatch(SAMPLE, 0, [idx]);
    const body = patch.split('\n');
    expect(body).toContain('-line2'); // restored on reverse-apply
    expect(body).not.toContain('+line2-changed'); // unselected add dropped from new side
    expect(body).toContain(' line2-changed'); // ...as context instead
  });

  it('preserves a "No newline at end of file" marker', () => {
    const noEof = `diff --git a/f b/f
index 1..2 100644
--- a/f
+++ b/f
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
    const patch = buildRevertPatch(noEof, 0);
    expect(patch).toContain('-old\n\\ No newline at end of file');
    expect(patch).toContain('+new\n\\ No newline at end of file');
  });

  it('throws for an out-of-range hunk index', () => {
    expect(() => buildRevertPatch(SAMPLE, 5)).toThrow(/not found/);
  });

  it('throws when the selection contains no changed lines', () => {
    const hunk = parseDiff(SAMPLE)[0].hunks[0];
    const ctxIdx = hunk.lines.findIndex((l) => l.type === 'context');
    expect(() => buildRevertPatch(SAMPLE, 0, [ctxIdx])).toThrow(/No changed lines/);
  });
});
