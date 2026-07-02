/**
 * Extract file paths from a unified diff.
 *
 * Parses `diff --git a/path b/path` headers and returns both
 * source and destination paths (excluding dev/null for additions/deletions).
 */
export function extractFilesFromDiff(diff: string): string[] {
  const regex = /^diff --git a\/(.+?) b\/(.+)$/gm;
  const files = new Set<string>();
  let match;
  while ((match = regex.exec(diff)) !== null) {
    if (match[1] !== 'dev/null') files.add(match[1]);
    if (match[2] !== 'dev/null') files.add(match[2]);
  }
  return Array.from(files);
}

/**
 * Slice a unified diff down to only the file sections that touch one of `wanted`
 * (paths as they appear in `diff --git a/<path> b/<path>`, prefix-stripped —
 * i.e. the same form extractFilesFromDiff returns and that a finding's `file`
 * uses). Splits on `diff --git ` boundaries WITHOUT consuming the header, so each
 * kept section is still a valid diff.
 *
 * Falls back to the full `diff` unchanged when there's nothing to slice by
 * (`wanted` empty), the text isn't a git diff (no `diff --git` header — e.g. a
 * plan subject), or no section matched. This keeps plan subjects and findings
 * without a file reference safe.
 */
export function sliceDiffToFiles(diff: string, wanted: Set<string>): string {
  if (wanted.size === 0) return diff;

  const regex = /^diff --git /gm;
  const indices: number[] = [];
  let match;
  while ((match = regex.exec(diff)) !== null) {
    indices.push(match.index);
  }
  if (indices.length === 0) return diff;

  const kept: string[] = [];
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i];
    const end = i + 1 < indices.length ? indices[i + 1] : diff.length;
    const section = diff.slice(start, end).replace(/\n$/, '');
    if (extractFilesFromDiff(section).some((f) => wanted.has(f))) {
      kept.push(section);
    }
  }
  return kept.length > 0 ? kept.join('\n') : diff;
}
