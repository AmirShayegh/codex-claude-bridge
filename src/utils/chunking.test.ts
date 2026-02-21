import { describe, it, expect } from 'vitest';
import { estimateTokens, chunkDiff } from './chunking.js';

describe('estimateTokens', () => {
  it('returns ceil(chars / 4) for non-empty string', () => {
    expect(estimateTokens('hello')).toBe(2); // 5 / 4 = 1.25 → 2
    expect(estimateTokens('abcdefgh')).toBe(2); // 8 / 4 = 2
    expect(estimateTokens('abcdefghi')).toBe(3); // 9 / 4 = 2.25 → 3
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

const makeFileDiff = (path: string, lines: number): string => {
  const header = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${lines} +1,${lines} @@`;
  const body = Array.from({ length: lines }, (_, i) => `+line ${i}`).join('\n');
  return `${header}\n${body}`;
};

describe('chunkDiff', () => {
  it('returns empty array for empty string', () => {
    expect(chunkDiff('', 1000)).toEqual([]);
  });

  it('returns empty array for whitespace-only diff', () => {
    expect(chunkDiff('   \n\t\n  ', 1000)).toEqual([]);
  });

  it('returns single-element array for small diff under maxTokens', () => {
    const diff = makeFileDiff('src/a.ts', 5);
    const tokens = estimateTokens(diff);
    const result = chunkDiff(diff, tokens + 100);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(diff);
  });

  it('splits large diff at file boundaries', () => {
    const file1 = makeFileDiff('src/a.ts', 10);
    const file2 = makeFileDiff('src/b.ts', 10);
    const diff = `${file1}\n${file2}`;

    // Set maxTokens so each file fits alone but not both together
    const singleFileTokens = estimateTokens(file1);
    const result = chunkDiff(diff, singleFileTokens + 10);

    expect(result).toHaveLength(2);
  });

  it('keeps single oversized file as one chunk', () => {
    const bigFile = makeFileDiff('src/huge.ts', 500);
    const tokens = estimateTokens(bigFile);
    // maxTokens much smaller than the file
    const result = chunkDiff(bigFile, Math.floor(tokens / 3));
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(bigFile);
  });

  it('preserves all content: joining chunks equals original diff', () => {
    const file1 = makeFileDiff('src/a.ts', 20);
    const file2 = makeFileDiff('src/b.ts', 20);
    const file3 = makeFileDiff('src/c.ts', 20);
    const diff = `${file1}\n${file2}\n${file3}`;

    const singleFileTokens = estimateTokens(file1);
    const result = chunkDiff(diff, singleFileTokens + 10);

    expect(result.join('\n')).toBe(diff);
  });

  it('returns [diff] when maxTokens <= 0', () => {
    const diff = makeFileDiff('src/a.ts', 5);
    expect(chunkDiff(diff, 0)).toEqual([diff]);
    expect(chunkDiff(diff, -10)).toEqual([diff]);
  });

  it('handles mixed small + oversized file', () => {
    const smallFile = makeFileDiff('src/small.ts', 5);
    const bigFile = makeFileDiff('src/big.ts', 200);
    const diff = `${smallFile}\n${bigFile}`;

    const smallTokens = estimateTokens(smallFile);
    // maxTokens fits the small file but not the big file
    const result = chunkDiff(diff, smallTokens + 10);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(smallFile);
    expect(result[1]).toBe(bigFile);
  });

  it('returns single chunk for diff without file headers', () => {
    const rawText = 'some text without diff headers\nline 2\nline 3';
    const result = chunkDiff(rawText, 5); // very small maxTokens
    expect(result).toEqual([rawText]);
  });

  describe('intra-file hunk splitting', () => {
    const makeMultiHunkDiff = (path: string, hunkCount: number, linesPerHunk: number): string => {
      const header = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}`;
      const hunks: string[] = [];
      for (let h = 0; h < hunkCount; h++) {
        const start = h * linesPerHunk + 1;
        const hunkHeader = `@@ -${start},${linesPerHunk} +${start},${linesPerHunk} @@`;
        const body = Array.from({ length: linesPerHunk }, (_, i) => `+hunk${h}_line${i}`).join('\n');
        hunks.push(`${hunkHeader}\n${body}`);
      }
      return `${header}\n${hunks.join('\n')}`;
    };

    it('splits single oversized file with multiple hunks at hunk boundaries', () => {
      const diff = makeMultiHunkDiff('src/big.ts', 4, 50);
      const totalTokens = estimateTokens(diff);
      // Budget fits ~2 hunks but not all 4
      const result = chunkDiff(diff, Math.floor(totalTokens / 2));
      expect(result.length).toBeGreaterThan(1);
    });

    it('each hunk chunk includes the file header', () => {
      const diff = makeMultiHunkDiff('src/big.ts', 4, 50);
      const totalTokens = estimateTokens(diff);
      const result = chunkDiff(diff, Math.floor(totalTokens / 2));
      for (const chunk of result) {
        expect(chunk).toMatch(/^diff --git /);
        expect(chunk).toContain('--- a/src/big.ts');
        expect(chunk).toContain('+++ b/src/big.ts');
      }
    });

    it('keeps single-hunk oversized file as one chunk', () => {
      const diff = makeFileDiff('src/huge.ts', 500);
      const tokens = estimateTokens(diff);
      const result = chunkDiff(diff, Math.floor(tokens / 3));
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(diff);
    });

    it('returns binary/rename diff unchanged when no @@ markers', () => {
      const binaryDiff =
        'diff --git a/image.png b/image.png\n' +
        'Binary files a/image.png and b/image.png differ';
      const result = chunkDiff(binaryDiff, 5);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(binaryDiff);
    });

    it('each hunk chunk is a valid diff section', () => {
      const diff = makeMultiHunkDiff('src/big.ts', 6, 40);
      const totalTokens = estimateTokens(diff);
      const result = chunkDiff(diff, Math.floor(totalTokens / 3));
      expect(result.length).toBeGreaterThan(1);
      for (const chunk of result) {
        expect(chunk).toMatch(/^diff --git /);
        expect(chunk).toContain('@@ ');
      }
    });
  });
});
