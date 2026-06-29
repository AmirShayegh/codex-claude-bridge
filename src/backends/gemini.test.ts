import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ErrorCode } from '../utils/errors.js';

// --- node:child_process mock: a controllable fake child process ---
// We mock only the external boundary (the agy subprocess). Each test drives the
// fake's stdout/stderr/exit, and the fake honors the AbortSignal so we can test
// the timeout path with fake timers.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinChunks: string[] = [];
  stdin = {
    write: (s: string) => {
      this.stdinChunks.push(s);
    },
    end: vi.fn(),
  };
  constructor(signal?: AbortSignal) {
    super();
    signal?.addEventListener('abort', () => {
      this.emit('error', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    });
  }
}

let lastChild: FakeChild;
let lastArgs: string[];
let lastCwd: string | undefined;
let spawnThrows: Error | undefined;

vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, args: string[], options: { cwd?: string; signal?: AbortSignal }) => {
    if (spawnThrows) throw spawnThrows;
    lastArgs = args;
    lastCwd = options.cwd;
    lastChild = new FakeChild(options.signal);
    return lastChild;
  },
}));

import { classifyAgyError, runAgyPrint } from './gemini.js';

beforeEach(() => {
  spawnThrows = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('classifyAgyError', () => {
  it('classifies a missing agy binary (ENOENT) as a config error', () => {
    const r = classifyAgyError('spawn agy ENOENT');
    expect(r.code).toBe(ErrorCode.CONFIG_ERROR);
    expect(r.message).toContain('agy');
  });

  it('classifies an auth/not-signed-in failure as an auth error', () => {
    const r = classifyAgyError('Error: you are not authenticated, please sign in');
    expect(r.code).toBe(ErrorCode.AUTH_ERROR);
  });

  it('classifies a model-not-available failure as a model error', () => {
    const r = classifyAgyError('model "Gemini 9 Ultra" is not available');
    expect(r.code).toBe(ErrorCode.MODEL_ERROR);
  });

  it('classifies a rate-limit / quota failure', () => {
    expect(classifyAgyError('429 resource exhausted').code).toBe(ErrorCode.RATE_LIMITED);
    expect(classifyAgyError('quota exceeded').code).toBe(ErrorCode.RATE_LIMITED);
  });

  it('classifies a network failure', () => {
    expect(classifyAgyError('dial tcp: ENOTFOUND').code).toBe(ErrorCode.NETWORK_ERROR);
  });

  it('falls back to UNKNOWN_ERROR with the raw text', () => {
    const r = classifyAgyError('something weird happened');
    expect(r.code).toBe(ErrorCode.UNKNOWN_ERROR);
    expect(r.message).toContain('something weird happened');
  });
});

const OPTS = { prompt: 'review this', model: 'Gemini 3.5 Flash (Medium)', cwd: '/repo', timeoutMs: 5000 };

describe('runAgyPrint', () => {
  it('spawns agy in print+sandbox mode with the model, pipes the prompt to stdin, returns stdout', async () => {
    const p = runAgyPrint(OPTS);
    lastChild.stdout.emit('data', Buffer.from('{"verdict":"approve"}'));
    lastChild.emit('close', 0);
    const res = await p;

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toBe('{"verdict":"approve"}');
    expect(lastArgs).toEqual(['--print', '--sandbox', '--model', 'Gemini 3.5 Flash (Medium)']);
    expect(lastArgs).not.toContain('--conversation');
    expect(lastArgs).not.toContain('--dangerously-skip-permissions');
    expect(lastCwd).toBe('/repo');
    expect(lastChild.stdinChunks.join('')).toBe('review this');
    expect(lastChild.stdin.end).toHaveBeenCalled();
  });

  it('passes --conversation <id> when resuming a session', async () => {
    const p = runAgyPrint({ ...OPTS, conversationId: 'conv-123' });
    lastChild.stdout.emit('data', Buffer.from('{}'));
    lastChild.emit('close', 0);
    await p;
    expect(lastArgs).toContain('--conversation');
    expect(lastArgs[lastArgs.indexOf('--conversation') + 1]).toBe('conv-123');
  });

  it('returns a classified error on non-zero exit, reading stderr', async () => {
    const p = runAgyPrint(OPTS);
    lastChild.stderr.emit('data', Buffer.from('you are not authenticated'));
    lastChild.emit('close', 1);
    const res = await p;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(ErrorCode.AUTH_ERROR);
  });

  it('returns ok with empty string when exit 0 but no output (caller retries via parse)', async () => {
    const p = runAgyPrint(OPTS);
    lastChild.emit('close', 0);
    const res = await p;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toBe('');
  });

  it('classifies a spawn failure (agy not installed) without throwing', async () => {
    spawnThrows = Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' });
    const res = await runAgyPrint(OPTS);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(ErrorCode.CONFIG_ERROR);
  });

  it('returns REVIEW_TIMEOUT when the run exceeds the timeout', async () => {
    vi.useFakeTimers();
    const p = runAgyPrint({ ...OPTS, timeoutMs: 1000 });
    vi.advanceTimersByTime(1001); // fires the timeout → aborts the child
    const res = await p;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(ErrorCode.REVIEW_TIMEOUT);
  });
});
