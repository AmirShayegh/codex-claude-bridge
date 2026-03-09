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
