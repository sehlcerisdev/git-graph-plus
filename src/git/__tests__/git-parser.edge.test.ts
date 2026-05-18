import { describe, it, expect } from 'vitest';
import {
  parseLog,
  parseRefs,
  parseBranches,
  parseTags,
  parseRemotes,
  parseStashList,
  parseDiff,
  parseWorktreeList,
} from '../git-parser';

describe('parseRefs — edge cases', () => {
  it('handles stash refs (refs/stash and stash)', () => {
    expect(parseRefs('refs/stash')).toEqual([{ type: 'stash', name: 'stash' }]);
    expect(parseRefs('stash')).toEqual([{ type: 'stash', name: 'stash' }]);
  });

  it('skips blank entries between commas', () => {
    expect(parseRefs('main, ,origin/main', ['origin'])).toEqual([
      { type: 'branch', name: 'main' },
      { type: 'remote-branch', name: 'main', remote: 'origin' },
    ]);
  });

  it('whitespace-only refStr returns empty', () => {
    expect(parseRefs('   ')).toEqual([]);
  });
});

describe('parseLog — edge cases', () => {
  it('record without refs field produces empty refs array', () => {
    const raw = '\x01h\x00h\x00A\x00a@x.com\x002024-01-01\x00A\x00a@x.com\x002024-01-01\x00msg\x00\x00';
    const result = parseLog(raw);
    expect(result[0].refs).toEqual([]);
  });

  it('record with whitespace-only refs field produces empty refs array', () => {
    const raw = '\x01h\x00h\x00A\x00a@x.com\x002024-01-01\x00A\x00a@x.com\x002024-01-01\x00msg\x00\x00   ';
    const result = parseLog(raw);
    expect(result[0].refs).toEqual([]);
  });

  it('parses commit body when present', () => {
    const raw = '\x01h\x00h\x00A\x00a@x.com\x002024-01-01\x00A\x00a@x.com\x002024-01-01\x00subject\x00\x00\x00body line\n\nmore';
    const result = parseLog(raw);
    expect(result[0].body).toBe('body line\n\nmore');
  });
});

describe('parseBranches — edge cases', () => {
  it('parses only-ahead and only-behind correctly', () => {
    const onlyAhead = parseBranches('*main\x00h\x00origin/main\x00ahead 3');
    expect(onlyAhead[0].ahead).toBe(3);
    expect(onlyAhead[0].behind).toBe(0);

    const onlyBehind = parseBranches(' feat\x00h\x00origin/feat\x00behind 5');
    expect(onlyBehind[0].ahead).toBe(0);
    expect(onlyBehind[0].behind).toBe(5);
  });

  it('drops entries whose name is empty', () => {
    const raw = ' \x00\x00\x00\n main\x00h\x00\x00\x00refs/heads/main';
    const result = parseBranches(raw);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('main');
  });

  it('treats empty upstream field as undefined', () => {
    const raw = ' feat\x00h\x00\x00';
    expect(parseBranches(raw)[0].upstream).toBeUndefined();
  });
});

describe('parseTags — edge cases', () => {
  it('annotated tag with body but no subject becomes undefined message', () => {
    // body-only is treated like no subject → no message
    const raw = 'v1\x00h\x00tag\x00\x00body only\x01';
    expect(parseTags(raw)[0].message).toBeUndefined();
  });
});

describe('parseRemotes — edge cases', () => {
  it('ignores malformed lines without a (fetch)/(push) suffix', () => {
    const raw = 'garbage line without suffix\norigin\thttps://x.git (fetch)';
    const result = parseRemotes(raw);
    expect(result).toHaveLength(1);
    expect(result[0].fetchUrl).toBe('https://x.git');
  });
});

describe('parseStashList — edge cases', () => {
  it('returns index 0 when refStr lacks the stash@{N} pattern', () => {
    const raw = 'malformed\x00msg\x00date\x00\x00';
    expect(parseStashList(raw)[0].index).toBe(0);
  });

  it('parentHash and hash are undefined when omitted', () => {
    const raw = 'stash@{0}\x00msg\x00date';
    const result = parseStashList(raw);
    expect(result[0].parentHash).toBeUndefined();
    expect(result[0].hash).toBeUndefined();
  });
});

describe('parseDiff — edge cases', () => {
  it('hunk header without explicit oldLines/newLines defaults to 1', () => {
    const raw = `diff --git a/f.ts b/f.ts
@@ -1 +1 @@
-x
+y`;
    const result = parseDiff(raw);
    expect(result[0].hunks[0].oldLines).toBe(1);
    expect(result[0].hunks[0].newLines).toBe(1);
  });

  it('non-image binary diff sets isImage=false', () => {
    const raw = `diff --git a/blob.bin b/blob.bin
Binary files a/blob.bin and b/blob.bin differ`;
    const result = parseDiff(raw);
    expect(result[0].isBinary).toBe(true);
    expect(result[0].isImage).toBe(false);
  });

  it('content lines before a hunk header are skipped (no currentHunk)', () => {
    const raw = `diff --git a/f.ts b/f.ts
some preamble
+ orphan add
@@ -1 +1 @@
-x
+y`;
    const result = parseDiff(raw);
    expect(result[0].hunks).toHaveLength(1);
    // Orphan "+ orphan add" must not appear among the parsed lines.
    const contents = result[0].hunks[0].lines.map(l => l.content);
    expect(contents).not.toContain(' orphan add');
  });

  it('treats blank lines inside a hunk as context', () => {
    const raw = `diff --git a/f.ts b/f.ts
@@ -1,3 +1,3 @@
 a

 c`;
    const result = parseDiff(raw);
    const ctxLines = result[0].hunks[0].lines.filter(l => l.type === 'context');
    expect(ctxLines).toHaveLength(3);
    expect(ctxLines[1].content).toBe('');
  });

  it('image extensions are detected case-insensitively', () => {
    const raw = `diff --git a/Logo.PNG b/Logo.PNG
Binary files a/Logo.PNG and b/Logo.PNG differ`;
    expect(parseDiff(raw)[0].isImage).toBe(true);
  });
});

describe('parseWorktreeList — edge cases', () => {
  it('skips blocks without a worktree path', () => {
    const raw = 'worktree /repo/main\nHEAD h\nbranch refs/heads/main\n\n\nHEAD h2\nbranch refs/heads/other\n';
    const result = parseWorktreeList(raw);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/repo/main');
  });

  it('handles "locked <reason>" and "prunable <reason>" prefixed forms', () => {
    const raw = 'worktree /repo/main\nHEAD h0\nbranch refs/heads/main\n\n' +
      'worktree /tmp/wt\nHEAD h1\nbranch refs/heads/x\nlocked because reasons\nprunable old worktree\n';
    const result = parseWorktreeList(raw);
    expect(result[1].locked).toBe(true);
    expect(result[1].prunable).toBe(true);
  });
});

describe('parseDiff — git path unescaping edge cases', () => {
  it('decodes \\n, \\r, \\\\ and \\" escape forms in quoted paths', () => {
    const raw = [
      'diff --git "a/has\\nnewline.txt" "b/has\\nnewline.txt"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(parseDiff(raw)[0].file).toBe('has\nnewline.txt');

    const raw2 = [
      'diff --git "a/back\\\\slash.txt" "b/back\\\\slash.txt"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(parseDiff(raw2)[0].file).toBe('back\\slash.txt');

    const raw3 = [
      'diff --git "a/has\\rreturn.txt" "b/has\\rreturn.txt"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(parseDiff(raw3)[0].file).toBe('has\rreturn.txt');

    const raw4 = [
      'diff --git "a/quoted\\".txt" "b/quoted\\".txt"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(parseDiff(raw4)[0].file).toBe('quoted".txt');
  });

  it('falls through unknown escape sequences to the literal character', () => {
    // \b is not in the recognised switch — should yield the literal "b".
    const raw = [
      'diff --git "a/foo\\bbar.txt" "b/foo\\bbar.txt"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(parseDiff(raw)[0].file).toBe('foobbar.txt');
  });
});
