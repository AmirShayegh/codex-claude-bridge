/**
 * Extract file paths from a unified diff.
 *
 * Parses `diff --git a/path b/path` headers and returns the
 * deduplicated list of destination (b/) paths.
 */
export function extractFilesFromDiff(diff: string): string[] {
  const regex = /^diff --git a\/.+ b\/(.+)$/gm;
  const files = new Set<string>();
  let match;
  while ((match = regex.exec(diff)) !== null) {
    files.add(match[1]);
  }
  return Array.from(files);
}
