export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

function splitByFileHeaders(diff: string): string[] {
  const regex = /^diff --git /gm;
  const indices: number[] = [];
  let match;
  while ((match = regex.exec(diff)) !== null) {
    indices.push(match.index);
  }

  if (indices.length === 0) return [diff];

  const files: string[] = [];
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i];
    const end = i + 1 < indices.length ? indices[i + 1] : diff.length;
    files.push(diff.slice(start, end).replace(/\n$/, ''));
  }
  return files;
}

export function chunkDiff(diff: string, maxTokens: number): string[] {
  if (!diff.trim()) return [];
  if (maxTokens <= 0) return [diff];
  if (estimateTokens(diff) <= maxTokens) return [diff];

  const files = splitByFileHeaders(diff);
  if (files.length <= 1) return [diff];

  const chunks: string[] = [];
  let current = '';

  for (const file of files) {
    const combined = current ? `${current}\n${file}` : file;
    if (current && estimateTokens(combined) > maxTokens) {
      chunks.push(current);
      current = file;
    } else {
      current = combined;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
