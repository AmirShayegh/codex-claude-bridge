import { describe, it, expect, vi } from 'vitest';
import { createHandler } from './handlers.js';
import type { HandlerIO } from './handlers.js';
import type { Result } from '../utils/errors.js';

function createMockIO(overrides?: Partial<HandlerIO>): HandlerIO & { stdoutBuf: string; stderrBuf: string; exitCode: number | null } {
  const io = {
    stdoutBuf: '',
    stderrBuf: '',
    exitCode: null as number | null,
    stdout: { write: (s: string) => { io.stdoutBuf += s; return true; } },
    stderr: { write: (s: string) => { io.stderrBuf += s; return true; } },
    exit: (code: number) => { io.exitCode = code; },
    color: false,
    json: false,
    ...overrides,
  };
  return io;
}

describe('createHandler', () => {
  describe('successful execution', () => {
    it('formats and writes result to stdout', async () => {
      const handler = createHandler<string>({
        execute: async () => ({ ok: true, data: 'hello' }),
        format: (data) => `formatted: ${data}`,
        exitCode: () => 0,
      });

      const io = createMockIO();
      await handler(io);

      expect(io.stdoutBuf).toBe('formatted: hello\n');
      expect(io.stderrBuf).toBe('');
      expect(io.exitCode).toBe(0);
    });

    it('outputs JSON when json mode is enabled', async () => {
      const handler = createHandler<{ value: number }>({
        execute: async () => ({ ok: true, data: { value: 42 } }),
        format: () => 'not used',
        exitCode: () => 0,
      });

      const io = createMockIO({ json: true });
      await handler(io);

      expect(JSON.parse(io.stdoutBuf)).toEqual({ value: 42 });
      expect(io.exitCode).toBe(0);
    });

    it('uses exitCode callback to determine exit code', async () => {
      const handler = createHandler<{ blocked: boolean }>({
        execute: async () => ({ ok: true, data: { blocked: true } }),
        format: () => 'blocked',
        exitCode: (result) => (result.blocked ? 2 : 0),
      });

      const io = createMockIO();
      await handler(io);

      expect(io.exitCode).toBe(2);
    });

    it('passes color flag to format function', async () => {
      const formatSpy = vi.fn().mockReturnValue('colored');
      const handler = createHandler<string>({
        execute: async () => ({ ok: true, data: 'x' }),
        format: formatSpy,
        exitCode: () => 0,
      });

      const io = createMockIO({ color: true });
      await handler(io);

      expect(formatSpy).toHaveBeenCalledWith('x', true);
    });
  });

  describe('failed execution', () => {
    it('writes error to stderr and exits with 1', async () => {
      const handler = createHandler<string>({
        execute: async (): Promise<Result<string>> => ({ ok: false, error: 'AUTH_ERROR: no key' }),
        format: () => 'not used',
        exitCode: () => 0,
      });

      const io = createMockIO();
      await handler(io);

      expect(io.stderrBuf).toBe('Error: AUTH_ERROR: no key\n');
      expect(io.stdoutBuf).toBe('');
      expect(io.exitCode).toBe(1);
    });

    it('writes JSON error when json mode is enabled', async () => {
      const handler = createHandler<string>({
        execute: async (): Promise<Result<string>> => ({ ok: false, error: 'timeout' }),
        format: () => 'not used',
        exitCode: () => 0,
      });

      const io = createMockIO({ json: true });
      await handler(io);

      expect(JSON.parse(io.stderrBuf)).toEqual({ error: 'timeout' });
      expect(io.exitCode).toBe(1);
    });
  });
});
