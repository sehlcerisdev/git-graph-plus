/**
 * Resolve a graph element's display color: a pattern-matched override wins,
 * otherwise fall back to the auto-assigned palette color (index wraps).
 */
export function resolveGraphColor(palette: string[], index: number, override?: string): string {
  if (override) return override;
  return palette[index % palette.length];
}
