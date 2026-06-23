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

  // Scenario A: old file `a` (no EOF newline) → new `a\nP\nQ` (no EOF newline).
  // Reverting ONLY the last added line `Q`. The new side ends unterminated at the
  // kept add `+Q`. Reversing `+Q` away leaves `P` as the file's last line, which
  // must ALSO be unterminated — but `P` is a shared (demoted) line followed by
  // `+Q`, so a bare marker after it would wrongly truncate the new side too. The
  // builder splits that shared line into `-P`⟵marker / `+P`, terminating only the
  // old side while the new side continues to `+Q`. (The old buggy code emitted
  // ` P` then `+Q`⟵marker, which reverse-applied to `a\nP\n`, gaining a newline.)
  it('Scenario A: splits the shared tail when a no-newline trailing add is reverted', () => {
    const noEof = `diff --git a/f b/f
index 2e65efe..e61a8e2 100644
--- a/f
+++ b/f
@@ -1 +1,3 @@
-a
\\ No newline at end of file
+a
+P
+Q
\\ No newline at end of file
`;
    const hunk = parseDiff(noEof)[0].hunks[0];
    const idxQ = hunk.lines.findIndex((l) => l.type === 'add' && l.content === 'Q');
    const patch = buildRevertPatch(noEof, 0, [idxQ]);
    expect(patch).toBe(
      [
        'diff --git a/f b/f',
        'index 2e65efe..e61a8e2 100644',
        '--- a/f',
        '+++ b/f',
        '@@ -1,2 +1,3 @@',
        ' a',
        '-P',
        '\\ No newline at end of file', // old side ends unterminated at P,
        '+P',                            // ...while the new side continues...
        '+Q',
        '\\ No newline at end of file', // ...to the unterminated new EOF at Q.
        '',
      ].join('\n'),
    );
  });

  // Scenario B: old `X\nold` (no EOF) → new `X\nnew1\nnew2` (no EOF). Reverting
  // ONLY the deleted line `old`. The old buggy code kept `-old` WITH its inline
  // marker, so reverse-apply fused `old` onto `new1` (`X\noldnew1\nnew2`). The
  // marker actually belongs only on the genuine shared last line (`new2`), once.
  it('Scenario B: re-anchors the no-newline marker when only a delete is reverted', () => {
    const noEof = `diff --git a/f b/f
index 84951a9..3e493e2 100644
--- a/f
+++ b/f
@@ -1,2 +1,3 @@
 X
-old
\\ No newline at end of file
+new1
+new2
\\ No newline at end of file
`;
    const hunk = parseDiff(noEof)[0].hunks[0];
    const idxOld = hunk.lines.findIndex((l) => l.type === 'delete' && l.content === 'old');
    const patch = buildRevertPatch(noEof, 0, [idxOld]);
    expect(patch).toBe(
      [
        'diff --git a/f b/f',
        'index 84951a9..3e493e2 100644',
        '--- a/f',
        '+++ b/f',
        '@@ -1,4 +1,3 @@',
        ' X',
        '-old', // restored on reverse-apply, NO inline marker
        ' new1',
        ' new2',
        '\\ No newline at end of file', // single marker on shared last context line
        '',
      ].join('\n'),
    );
  });

  // A no-EOF-newline diff whose hunk ends on a shared context line: the marker
  // must be emitted exactly once on that final context line, not duplicated.
  it('emits a single marker on a shared trailing context line', () => {
    const noEof = `diff --git a/f b/f
index 4d6e807..12db783 100644
--- a/f
+++ b/f
@@ -1,2 +1,2 @@
-a
+A
 tail
\\ No newline at end of file
`;
    const patch = buildRevertPatch(noEof, 0);
    expect(patch).toBe(
      [
        'diff --git a/f b/f',
        'index 4d6e807..12db783 100644',
        '--- a/f',
        '+++ b/f',
        '@@ -1,2 +1,2 @@',
        '-a',
        '+A',
        ' tail',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    );
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
