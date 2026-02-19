import { describe, it, expect } from 'vitest';
import { ok, err, ErrorCode, type Result } from './errors.js';

describe('Result type helpers', () => {
  describe('ok()', () => {
    it('returns an ok result with the given data', () => {
      const result = ok(42);
      expect(result).toEqual({ ok: true, data: 42 });
    });

    it('works with string data', () => {
      const result = ok('hello');
      expect(result).toEqual({ ok: true, data: 'hello' });
    });

    it('works with object data', () => {
      const data = { name: 'test', count: 3 };
      const result = ok(data);
      expect(result).toEqual({ ok: true, data });
    });
  });

  describe('err()', () => {
    it('returns an error result with the given message', () => {
      const result = err('something failed');
      expect(result).toEqual({ ok: false, error: 'something failed' });
    });
  });

  describe('type narrowing', () => {
    it('narrows to ok branch when ok is true', () => {
      const result: Result<number> = ok(42);
      if (result.ok) {
        const data: number = result.data;
        expect(data).toBe(42);
      } else {
        expect.unreachable('should not reach error branch');
      }
    });

    it('narrows to error branch when ok is false', () => {
      const result: Result<number> = err('fail');
      if (!result.ok) {
        const error: string = result.error;
        expect(error).toBe('fail');
      } else {
        expect.unreachable('should not reach ok branch');
      }
    });
  });
});

describe('ErrorCode enum', () => {
  it('has all expected error codes', () => {
    expect(ErrorCode.CODEX_TIMEOUT).toBe('CODEX_TIMEOUT');
    expect(ErrorCode.CODEX_PARSE_ERROR).toBe('CODEX_PARSE_ERROR');
    expect(ErrorCode.GIT_ERROR).toBe('GIT_ERROR');
    expect(ErrorCode.CONFIG_ERROR).toBe('CONFIG_ERROR');
    expect(ErrorCode.STORAGE_ERROR).toBe('STORAGE_ERROR');
    expect(ErrorCode.SESSION_NOT_FOUND).toBe('SESSION_NOT_FOUND');
    expect(ErrorCode.UNKNOWN_ERROR).toBe('UNKNOWN_ERROR');
  });

  it('works with err() to create structured error messages', () => {
    const result = err(`${ErrorCode.CODEX_TIMEOUT}: request timed out after 30s`);
    expect(result).toEqual({
      ok: false,
      error: 'CODEX_TIMEOUT: request timed out after 30s',
    });
  });

  it('has exactly 7 members', () => {
    const keys = Object.keys(ErrorCode);
    expect(keys).toHaveLength(7);
  });
});
