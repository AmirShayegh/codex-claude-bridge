import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { readInput, resetStdinGuard } from './stdin.js';

// Mock fs/promises for file reading tests
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import { readFile } from 'node:fs/promises';
const mockReadFile = vi.mocked(readFile);

beforeEach(() => {
  vi.clearAllMocks();
  resetStdinGuard();
});

function createReadableFrom(content: string): Readable {
  const stream = new Readable({ read() {} });
  // Push content async so listeners can be attached first
  setImmediate(() => {
    stream.push(Buffer.from(content));
    stream.push(null);
  });
  return stream;
}

describe('readInput', () => {
  describe('file reading', () => {
    it('reads content from a file path', async () => {
      mockReadFile.mockResolvedValue('file content here');
      const result = await readInput('/tmp/plan.md');
      expect(result).toEqual({ ok: true, data: 'file content here' });
      expect(mockReadFile).toHaveBeenCalledWith('/tmp/plan.md', 'utf-8');
    });

    it('returns error for nonexistent file', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));
      const result = await readInput('/tmp/nonexistent.md');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Failed to read file');
        expect(result.error).toContain('ENOENT');
      }
    });
  });

  describe('stdin reading', () => {
    it('reads from stdin when source is "-"', async () => {
      const stream = createReadableFrom('piped content');
      const result = await readInput('-', { stdin: stream });
      expect(result).toEqual({ ok: true, data: 'piped content' });
    });

    it('returns timeout error when stdin provides no data', async () => {
      // Create a stream that never emits data
      const stream = new Readable({ read() {} });
      const result = await readInput('-', { stdin: stream, timeoutMs: 50 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('stdin timeout');
      }
    });

    it('returns partial data on idle timeout if stream stalls', async () => {
      const stream = new Readable({ read() {} });
      // Push data but never end the stream — idle timer fires after last chunk
      setImmediate(() => {
        stream.push(Buffer.from('partial'));
      });
      const result = await readInput('-', { stdin: stream, timeoutMs: 100 });
      expect(result).toEqual({ ok: true, data: 'partial' });
    });

    it('resets idle timer on each data chunk (no truncation)', async () => {
      const stream = new Readable({ read() {} });
      // Send chunks spaced 30ms apart, with a 100ms idle timeout.
      // Total time ~90ms but each chunk resets the timer.
      const chunks = ['aaa', 'bbb', 'ccc'];
      let i = 0;
      const iv = setInterval(() => {
        if (i < chunks.length) {
          stream.push(Buffer.from(chunks[i]));
          i++;
        } else {
          clearInterval(iv);
          stream.push(null); // end stream
        }
      }, 30);
      const result = await readInput('-', { stdin: stream, timeoutMs: 100 });
      expect(result).toEqual({ ok: true, data: 'aaabbbccc' });
    });

    it('returns error on stream error', async () => {
      const stream = new Readable({ read() {} });
      setImmediate(() => {
        stream.destroy(new Error('broken pipe'));
      });
      const result = await readInput('-', { stdin: stream });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('stdin error');
        expect(result.error).toContain('broken pipe');
      }
    });
  });

  describe('consumed guard', () => {
    it('prevents reading stdin twice in one invocation', async () => {
      const stream1 = createReadableFrom('first');
      const result1 = await readInput('-', { stdin: stream1 });
      expect(result1.ok).toBe(true);

      const stream2 = createReadableFrom('second');
      const result2 = await readInput('-', { stdin: stream2 });
      expect(result2.ok).toBe(false);
      if (!result2.ok) {
        expect(result2.error).toContain('stdin already consumed');
      }
    });

    it('resetStdinGuard allows reading again', async () => {
      const stream1 = createReadableFrom('first');
      await readInput('-', { stdin: stream1 });

      resetStdinGuard();

      const stream2 = createReadableFrom('second');
      const result = await readInput('-', { stdin: stream2 });
      expect(result).toEqual({ ok: true, data: 'second' });
    });

    it('file reading does not trigger consumed guard', async () => {
      mockReadFile.mockResolvedValue('file content');
      await readInput('/tmp/file.md');

      const stream = createReadableFrom('stdin content');
      const result = await readInput('-', { stdin: stream });
      expect(result).toEqual({ ok: true, data: 'stdin content' });
    });
  });
});
