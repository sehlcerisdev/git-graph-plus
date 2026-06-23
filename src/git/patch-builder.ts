// Builds minimal, reverse-applicable patches from a single-file unified diff so
// we can undo part of a commit's change (one hunk, or a subset of changed lines)
// against the working tree via `git apply --reverse`.
//
// The line indexing here intentionally mirrors `parseDiff` in git-parser.ts:
// `lineIndices` refer to positions in a hunk's `DiffLine[]` exactly as the
// webview sees them, so the frontend can pass back the indices it rendered.

interface PatchEntry {
  kind: 'context' | 'add' | 'delete';
  /** Raw diff line including its leading ' ', '+' or '-'. */
  text: string;
  /** Trailing "\ No newline at end of file" markers attached to this line. */
  markers: string[];
}

interface PatchHunk {
  /** The original `@@ -a,b +c,d @@ ...` header line. */
  headerLine: string;
  entries: PatchEntry[];
}

interface ParsedFileDiff {
  /** Everything before the first hunk: `diff --git`, mode/index lines, ---/+++. */
  header: string[];
  hunks: PatchHunk[];
}

/** Parse a single-file `git diff` (or `git show`) body into header + hunks,
 *  classifying body lines the same way `parseDiff` does so indices line up.
 *  "\ No newline at end of file" markers are attached to the line they follow
 *  (never counted as their own index), matching parseDiff which skips them. */
function parseFileDiff(rawFileDiff: string): ParsedFileDiff {
  const lines = rawFileDiff.split('\n');
  const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
  if (firstHunk === -1) {
    return { header: lines, hunks: [] };
  }

  const header = lines.slice(0, firstHunk);
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;

  for (let i = firstHunk; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('@@')) {
      current = { headerLine: line, entries: [] };
      hunks.push(current);
      continue;
    }
    if (!current) { continue; }

    if (line.startsWith('\\')) {
      // "\ No newline at end of file" — belongs to the preceding content line.
      const last = current.entries[current.entries.length - 1];
      if (last) { last.markers.push(line); }
      continue;
    }

    if (line.startsWith('+')) {
      current.entries.push({ kind: 'add', text: line, markers: [] });
    } else if (line.startsWith('-')) {
      current.entries.push({ kind: 'delete', text: line, markers: [] });
    } else if (line.startsWith(' ')) {
      current.entries.push({ kind: 'context', text: line, markers: [] });
    } else if (line === '' && i < lines.length - 1) {
      // A blank context line whose trailing space was stripped (git's normal
      // output keeps the leading ' '). The final '' is split('\n')'s trailing
      // artifact, not real content — skip it (`i < lines.length - 1`).
      current.entries.push({ kind: 'context', text: ' ', markers: [] });
    }
  }

  return { header, hunks };
}

/** Rewrite a hunk header with recomputed line counts, preserving the original
 *  start positions and the trailing section heading. */
function rewriteHunkHeader(headerLine: string, oldCount: number, newCount: number): string {
  const m = headerLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
  if (!m) { return headerLine; }
  const [, oldStart, newStart, rest] = m;
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${rest}`;
}

/**
 * Build a patch containing a single hunk from `rawFileDiff`, optionally narrowed
 * to a subset of that hunk's changed lines. The result is meant to be applied
 * with `git apply --reverse` to undo those changes in the working tree.
 *
 * Selection semantics (`lineIndices` index into the hunk's `DiffLine[]`):
 *  - omitted → revert every changed (+/-) line in the hunk;
 *  - provided → revert only the listed +/- lines. Unselected additions become
 *    context (they stay in the file); unselected deletions are dropped entirely
 *    (they aren't in the file and we aren't restoring them).
 *
 * @throws if the hunk index is out of range or nothing revertible is selected.
 */
export function buildRevertPatch(rawFileDiff: string, hunkIndex: number, lineIndices?: number[]): string {
  const { header, hunks } = parseFileDiff(rawFileDiff);
  const hunk = hunks[hunkIndex];
  if (!hunk) {
    throw new Error(`Hunk ${hunkIndex} not found in diff`);
  }

  const selected = lineIndices ? new Set(lineIndices) : null;
  const isReverting = (idx: number, kind: PatchEntry['kind']): boolean =>
    kind !== 'context' && (selected ? selected.has(idx) : true);

  const body: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  let revertedAny = false;

  for (let i = 0; i < hunk.entries.length; i++) {
    const entry = hunk.entries[i];

    if (entry.kind === 'context') {
      body.push(entry.text, ...entry.markers);
      oldCount++;
      newCount++;
    } else if (entry.kind === 'add') {
      if (isReverting(i, 'add')) {
        // Keep as an addition; `--reverse` turns it into a removal.
        body.push(entry.text, ...entry.markers);
        newCount++;
        revertedAny = true;
      } else {
        // Demote to context: the line stays in the working tree.
        body.push(' ' + entry.text.slice(1), ...entry.markers);
        oldCount++;
        newCount++;
      }
    } else {
      if (isReverting(i, 'delete')) {
        // Keep as a removal; `--reverse` turns it into an addition (restore).
        body.push(entry.text, ...entry.markers);
        oldCount++;
        revertedAny = true;
      }
      // Unselected deletion: drop it — it's absent from the file either way.
    }
  }

  if (!revertedAny) {
    throw new Error('No changed lines selected to revert');
  }

  const headerLine = rewriteHunkHeader(hunk.headerLine, oldCount, newCount);
  return [...header, headerLine, ...body].join('\n') + '\n';
}
