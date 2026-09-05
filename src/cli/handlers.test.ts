import { describe, it, expect, vi } from 'vitest';
import { createHandler } from './handlers.js';
import type { HandlerIO } from './handlers.js';
import type { Result } from '../utils/errors.js';

function createMockIO(
  overrides?: Partial<HandlerIO>,
): HandlerIO & { stdoutBuf: string; stderrBuf: string; exitCode: number | null } {
  const io = {
    stdoutBuf: '',
    stderrBuf: '',
    exitCode: null as number | null,
    stdout: {
      write: (s: string) => {
        io.stdoutBuf += s;
        return true;
      },
    },
    stderr: {
      write: (s: string) => {
        io.stderrBuf += s;
        return true;
      },
    },
    exit: (code: number) => {
      io.exitCode = code;
    },
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

    it('adds not_recorded provenance to a successful CLI review when absent', async () => {
      const data = { session_id: 'session-1', value: 42 };
      const formatSpy = vi.fn().mockReturnValue('formatted');
      const handler = createHandler<typeof data>({
        execute: async () => ({ ok: true, data }),
        format: formatSpy,
        exitCode: () => 0,
      });

      const io = createMockIO({ json: true });
      await handler(io);

      expect(JSON.parse(io.stdoutBuf)).toEqual({
        ...data,
        provenance: { persistence: 'not_recorded', warning: null },
      });
      expect(data).not.toHaveProperty('provenance');
    });

    it('preserves existing provenance and passes JSON through exactly', async () => {
      const data = {
        session_id: 'session-1',
        value: 42,
        models: [
          {
            provider: 'codex',
            role: 'review',
            requested: null,
            resolved: 'gpt-5.6-sol',
            observed: 'gpt-5.6-sol',
            evidence: 'runtime_session_record',
          },
        ],
        provenance: { persistence: 'memory_only', warning: 'DB unavailable' },
      };
      const handler = createHandler<typeof data>({
        execute: async () => ({ ok: true, data }),
        format: () => 'not used',
        exitCode: () => 0,
      });

      const io = createMockIO({ json: true });
      await handler(io);

      expect(io.stdoutBuf).toBe(`${JSON.stringify(data)}\n`);
    });

    it('keeps JSON output parse-equivalent without emitting raw DEL or C1 controls', async () => {
      const del = String.fromCharCode(0x7f);
      const c1 = String.fromCharCode(0x85);
      const data = { value: `before${del}middle${c1}after` };
      const handler = createHandler<typeof data>({
        execute: async () => ({ ok: true, data }),
        format: () => 'not used',
        exitCode: () => 0,
      });

      const io = createMockIO({ json: true });
      await handler(io);

      expect(JSON.parse(io.stdoutBuf)).toEqual(data);
      expect(io.stdoutBuf).not.toContain(del);
      expect(io.stdoutBuf).not.toContain(c1);
      expect(io.stdoutBuf).toContain('\\u007f');
      expect(io.stdoutBuf).toContain('\\u0085');
    });

    it('passes enriched provenance to human formatters and exit-code logic', async () => {
      const data = { session_id: 'session-1', blocked: false };
      const formatSpy = vi.fn().mockReturnValue('formatted');
      const exitCodeSpy = vi.fn().mockReturnValue(0);
      const handler = createHandler<typeof data>({
        execute: async () => ({ ok: true, data }),
        format: formatSpy,
        exitCode: exitCodeSpy,
      });

      await handler(createMockIO());

      const expected = {
        ...data,
        provenance: { persistence: 'not_recorded', warning: null },
      };
      expect(formatSpy).toHaveBeenCalledWith(expected, false);
      expect(exitCodeSpy).toHaveBeenCalledWith(expected);
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

    it('escapes control characters in human error output', async () => {
      const escape = String.fromCharCode(0x1b);
      const c1 = String.fromCharCode(0x85);
      const handler = createHandler<string>({
        execute: async (): Promise<Result<string>> => ({
          ok: false,
          error: `bad\nline${escape}escape${c1}c1`,
        }),
        format: () => 'not used',
        exitCode: () => 0,
      });

      const io = createMockIO();
      await handler(io);

      expect(io.stderrBuf).toBe('Error: bad\\nline\\x1Bescape\\x85c1\n');
      expect(io.stderrBuf).not.toContain(escape);
      expect(io.stderrBuf).not.toContain(c1);
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

    it('preserves the exact error value in JSON mode while JSON-escaping controls', async () => {
      const del = String.fromCharCode(0x7f);
      const c1 = String.fromCharCode(0x85);
      const error = `bad\n${String.fromCharCode(0x1b)}${del}${c1}`;
      const handler = createHandler<string>({
        execute: async (): Promise<Result<string>> => ({ ok: false, error }),
        format: () => 'not used',
        exitCode: () => 0,
      });

      const io = createMockIO({ json: true });
      await handler(io);

      expect(JSON.parse(io.stderrBuf)).toEqual({ error });
      expect(io.stderrBuf).not.toContain(del);
      expect(io.stderrBuf).not.toContain(c1);
      expect(io.stderrBuf).toContain('\\u007f');
      expect(io.stderrBuf).toContain('\\u0085');
    });
  });
});
