/**
 * Validate a git ref name (branch, tag) against git's check-ref-format rules.
 * Returns null if valid, or an error key (i18n) if invalid.
 *
 * Rules enforced (subset of `git check-ref-format` that catches the common mistakes):
 *  - Non-empty
 *  - No ASCII control chars or DEL
 *  - No whitespace
 *  - No `^ ~ : ? * [ \`
 *  - No `..`, no `@{`
 *  - Cannot start with `-` or `.`, cannot end with `.` or `/`
 *  - Cannot end with `.lock`
 *  - Cannot be exactly `@`
 */
export function validateGitRefName(name: string): string | null {
  if (!name || name.length === 0) { return 'gitRef.empty'; }
  if (name === '@') { return 'gitRef.atOnly'; }
  if (/[\x00-\x1f\x7f\s]/.test(name)) { return 'gitRef.whitespaceOrControl'; }
  if (/[\^~:?*\[\\]/.test(name)) { return 'gitRef.forbiddenChars'; }
  if (name.includes('..') || name.includes('@{')) { return 'gitRef.forbiddenSequence'; }
  if (name.startsWith('-') || name.startsWith('.') || name.startsWith('/')) { return 'gitRef.badStart'; }
  if (name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')) { return 'gitRef.badEnd'; }
  return null;
}
