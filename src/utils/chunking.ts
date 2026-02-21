export function estimateTokens(text: string): number {
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

function splitByHunks(fileDiff: string, maxTokens: number): string[] {
  const hunkRegex = /^@@ /gm;
  const indices: number[] = [];
  let match;
  while ((match = hunkRegex.exec(fileDiff)) !== null) {
    indices.push(match.index);
  }

  // No hunk markers (binary/rename diff) — return unchanged
  if (indices.length === 0) return [fileDiff];

  const header = fileDiff.slice(0, indices[0]).replace(/\n$/, '');
  const hunks: string[] = [];
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i];
    const end = i + 1 < indices.length ? indices[i + 1] : fileDiff.length;
    hunks.push(fileDiff.slice(start, end).replace(/\n$/, ''));
  }

  // Single hunk — can't split further
  if (hunks.length <= 1) return [fileDiff];

  // Greedy bin-pack hunks, prepending the file header to each chunk
  const chunks: string[] = [];
  let currentHunks = '';

  for (const hunk of hunks) {
    const piece = currentHunks ? `${currentHunks}\n${hunk}` : hunk;
    const candidate = `${header}\n${piece}`;
    if (currentHunks && estimateTokens(candidate) > maxTokens) {
      chunks.push(`${header}\n${currentHunks}`);
      currentHunks = hunk;
    } else {
      currentHunks = piece;
    }
  }

  if (currentHunks) chunks.push(`${header}\n${currentHunks}`);
  return chunks;
}

export function chunkDiff(diff: string, maxTokens: number): string[] {
  if (!diff.trim()) return [];
  if (maxTokens <= 0) return [diff];
  if (estimateTokens(diff) <= maxTokens) return [diff];

  const files = splitByFileHeaders(diff);

  // Expand oversized files into hunk-level pieces, keep small files intact
  const pieces: string[] = [];
  for (const file of files) {
    if (estimateTokens(file) > maxTokens) {
      pieces.push(...splitByHunks(file, maxTokens));
    } else {
      pieces.push(file);
    }
  }

  // Single piece that can't be split further
  if (pieces.length <= 1) return [diff];

  // Greedy bin-pack pieces into chunks
  const chunks: string[] = [];
  let current = '';

  for (const piece of pieces) {
    const combined = current ? `${current}\n${piece}` : piece;
    if (current && estimateTokens(combined) > maxTokens) {
      chunks.push(current);
      current = piece;
    } else {
      current = combined;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
