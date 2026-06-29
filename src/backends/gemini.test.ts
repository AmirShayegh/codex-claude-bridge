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
let spawnCount = 0;
let scriptedResponses: { stdout?: string; stderr?: string; code?: number }[] = [];

vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, args: string[], options: { cwd?: string; signal?: AbortSignal }) => {
    if (spawnThrows) throw spawnThrows;
    lastArgs = args;
    lastCwd = options.cwd;
    spawnCount += 1;
    const child = new FakeChild(options.signal);
    lastChild = child;
    // If a response is scripted, auto-emit it on the next microtask (after the
    // caller registers its listeners). Otherwise the test drives the child by
    // hand (the runAgyPrint unit tests below do this).
    const scripted = scriptedResponses.shift();
    if (scripted) {
      queueMicrotask(() => {
        if (scripted.stdout !== undefined) child.stdout.emit('data', Buffer.from(scripted.stdout));
        if (scripted.stderr !== undefined) child.stderr.emit('data', Buffer.from(scripted.stderr));
        child.emit('close', scripted.code ?? 0);
      });
    }
    return child;
  },
}));

function script(...responses: { stdout?: string; stderr?: string; code?: number }[]): void {
  scriptedResponses.push(...responses);
}

// --- fs/os boundary mock for the conversation-id cache ---
let fakeFiles: Record<string, string> = {};
vi.mock('node:os', () => ({ homedir: () => '/home/test' }));
vi.mock('node:fs', () => ({
  readFileSync: (p: string) => {
    if (!(p in fakeFiles)) {
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    }
    return fakeFiles[p];
  },
}));

import {
  classifyAgyError,
  runAgyPrint,
  readConversationId,
  runSerialized,
  createGeminiBackend,
  pickLatestFlashModel,
  runAgyModels,
  resolveLatestGeminiModel,
} from './gemini.js';
import { DEFAULT_CONFIG } from '../config/types.js';

// Exact `agy models` output captured from agy 1.0.13.
const REAL_AGY_MODELS = [
  'Gemini 3.5 Flash (Medium)',
  'Gemini 3.5 Flash (High)',
  'Gemini 3.5 Flash (Low)',
  'Gemini 3.1 Pro (Low)',
  'Gemini 3.1 Pro (High)',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)',
  'GPT-OSS 120B (Medium)',
].join('\n');

const CACHE = '/home/test/.gemini/antigravity-cli/cache/last_conversations.json';

beforeEach(() => {
  spawnThrows = undefined;
  fakeFiles = {};
  scriptedResponses = [];
  spawnCount = 0;
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

describe('pickLatestFlashModel', () => {
  it('picks the newest Flash at the preferred (Medium) tier from real agy output', () => {
    expect(pickLatestFlashModel(REAL_AGY_MODELS)).toBe('Gemini 3.5 Flash (Medium)');
  });

  it('prefers a newer version even when it only offers a non-preferred tier', () => {
    const out = 'Gemini 4.0 Flash (High)\nGemini 3.5 Flash (Medium)';
    expect(pickLatestFlashModel(out)).toBe('Gemini 4.0 Flash (High)');
  });

  it('compares versions numerically (3.10 is newer than 3.5)', () => {
    const out = 'Gemini 3.5 Flash (Medium)\nGemini 3.10 Flash (Low)';
    expect(pickLatestFlashModel(out)).toBe('Gemini 3.10 Flash (Low)');
  });

  it('falls down the tier preference when the newest version omits Medium', () => {
    const out = 'Gemini 3.5 Flash (Low)\nGemini 3.5 Flash (High)';
    expect(pickLatestFlashModel(out)).toBe('Gemini 3.5 Flash (High)');
  });

  it('stays within the Flash line — a higher-version Pro never wins', () => {
    const out = 'Gemini 9.0 Pro (High)\nGemini 3.5 Flash (Medium)';
    expect(pickLatestFlashModel(out)).toBe('Gemini 3.5 Flash (Medium)');
  });

  it('returns null when no Flash model is present', () => {
    const out = 'Gemini 3.1 Pro (High)\nClaude Opus 4.6 (Thinking)';
    expect(pickLatestFlashModel(out)).toBeNull();
  });

  it('returns null on empty output', () => {
    expect(pickLatestFlashModel('')).toBeNull();
  });
});

describe('runAgyModels', () => {
  it('invokes `agy models` and returns raw stdout on success', async () => {
    const p = runAgyModels();
    lastChild.stdout.emit('data', Buffer.from(REAL_AGY_MODELS));
    lastChild.emit('close', 0);
    const out = await p;

    expect(out).toBe(REAL_AGY_MODELS);
    expect(lastArgs).toEqual(['models']);
  });

  it('returns null on a non-zero exit', async () => {
    const p = runAgyModels();
    lastChild.stderr.emit('data', Buffer.from('boom'));
    lastChild.emit('close', 1);
    expect(await p).toBeNull();
  });

  it('returns null when stdout is empty on a clean exit', async () => {
    const p = runAgyModels();
    lastChild.emit('close', 0);
    expect(await p).toBeNull();
  });

  it('returns null without throwing when agy is not installed', async () => {
    spawnThrows = Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' });
    expect(await runAgyModels()).toBeNull();
  });

  it('returns null when the query exceeds its timeout', async () => {
    vi.useFakeTimers();
    const p = runAgyModels(1000);
    vi.advanceTimersByTime(1001);
    expect(await p).toBeNull();
  });
});

describe('resolveLatestGeminiModel', () => {
  it('resolves to the newest Flash reported by agy', async () => {
    script({ stdout: 'Gemini 4.0 Flash (Medium)\nGemini 3.5 Flash (Medium)', code: 0 });
    expect(await resolveLatestGeminiModel()).toBe('Gemini 4.0 Flash (Medium)');
  });

  it('falls back to the known-good model when the query fails', async () => {
    script({ stderr: 'boom', code: 1 });
    expect(await resolveLatestGeminiModel()).toBe('Gemini 3.5 Flash (Medium)');
  });

  it('falls back to the known-good model when no Flash line is parseable', async () => {
    script({ stdout: 'Gemini 9.0 Pro (High)\nGPT-OSS 120B (Medium)', code: 0 });
    expect(await resolveLatestGeminiModel()).toBe('Gemini 3.5 Flash (Medium)');
  });
});

describe('readConversationId', () => {
  it('returns the conversation id agy recorded for the given cwd', () => {
    fakeFiles[CACHE] = JSON.stringify({ '/repo': 'conv-abc', '/other': 'conv-xyz' });
    expect(readConversationId('/repo')).toBe('conv-abc');
  });

  it('returns undefined when the cwd has no recorded conversation', () => {
    fakeFiles[CACHE] = JSON.stringify({ '/other': 'conv-xyz' });
    expect(readConversationId('/repo')).toBeUndefined();
  });

  it('returns undefined when the cache file is missing', () => {
    expect(readConversationId('/repo')).toBeUndefined();
  });

  it('returns undefined when the cache file is malformed JSON', () => {
    fakeFiles[CACHE] = '{ not valid json';
    expect(readConversationId('/repo')).toBeUndefined();
  });
});

describe('runSerialized', () => {
  it('runs critical sections one at a time, in call order', async () => {
    const order: string[] = [];
    const a = runSerialized(async () => {
      order.push('a-start');
      await Promise.resolve();
      await Promise.resolve();
      order.push('a-end');
    });
    const b = runSerialized(async () => {
      order.push('b-start');
      order.push('b-end');
    });
    await Promise.all([a, b]);
    // b must not interleave with a — it waits for a to fully settle.
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('keeps the chain alive after a section rejects (no deadlock)', async () => {
    await expect(runSerialized(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(runSerialized(async () => 'ok')).resolves.toBe('ok');
  });
});

const CWD = process.cwd();
const SMALL_DIFF = 'diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b';
const PLAN_OK = { verdict: 'approve', summary: 's', findings: [] };
const CODE_OK = { verdict: 'approve', summary: 's', findings: [] };

describe('createGeminiBackend', () => {
  it("exposes its provider identity as 'gemini'", () => {
    expect(createGeminiBackend(DEFAULT_CONFIG).provider).toBe('gemini');
  });

  it('reviewPlan: fresh run uses the default model in sandbox, captures the conversation id', async () => {
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-new' });
    script({ stdout: JSON.stringify(PLAN_OK) });

    const res = await createGeminiBackend(DEFAULT_CONFIG).reviewPlan({ plan: 'do a thing' });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.verdict).toBe('approve');
      expect(res.data.session_id).toBe('conv-new'); // captured from agy's cache
    }
    expect(lastArgs).toContain('--sandbox');
    expect(lastArgs[lastArgs.indexOf('--model') + 1]).toBe('Gemini 3.5 Flash (Medium)');
    expect(lastArgs).not.toContain('--conversation');
    expect(lastCwd).toBe(CWD);
  });

  it('reviewCode: resuming a session passes --conversation and reuses that id (no capture needed)', async () => {
    // No cache entry on purpose — the resume path must not depend on capture.
    script({ stdout: JSON.stringify(CODE_OK) });

    const res = await createGeminiBackend(DEFAULT_CONFIG).reviewCode({ diff: SMALL_DIFF, session_id: 'conv-prev' });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.session_id).toBe('conv-prev');
    expect(lastArgs[lastArgs.indexOf('--conversation') + 1]).toBe('conv-prev');
  });

  it('retries once on malformed JSON, then succeeds (two spawns)', async () => {
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-retry' });
    script({ stdout: 'not json at all' }, { stdout: JSON.stringify(PLAN_OK) });

    const res = await createGeminiBackend(DEFAULT_CONFIG).reviewPlan({ plan: 'x' });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.session_id).toBe('conv-retry');
    expect(spawnCount).toBe(2);
  });

  it('strips a markdown code fence around the JSON before parsing', async () => {
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-fence' });
    script({ stdout: '```json\n' + JSON.stringify(PLAN_OK) + '\n```' });

    const res = await createGeminiBackend(DEFAULT_CONFIG).reviewPlan({ plan: 'x' });
    expect(res.ok).toBe(true);
  });

  it('returns a classified error when agy fails (auth), never throws', async () => {
    script({ stderr: 'Error: you are not authenticated', code: 1 });

    const res = await createGeminiBackend(DEFAULT_CONFIG).reviewPlan({ plan: 'x' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(ErrorCode.AUTH_ERROR);
  });

  it('errors clearly when a fresh run cannot capture a conversation id', async () => {
    // cache has no entry for CWD → capture fails
    script({ stdout: JSON.stringify(PLAN_OK) });

    const res = await createGeminiBackend(DEFAULT_CONFIG).reviewPlan({ plan: 'x' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(ErrorCode.RESPONSE_PARSE_ERROR);
  });

  it('allows session_id + model together — model override on a resumed session', async () => {
    script({ stdout: JSON.stringify(CODE_OK) });

    const res = await createGeminiBackend(DEFAULT_CONFIG).reviewCode({
      diff: SMALL_DIFF,
      session_id: 'conv-x',
      model: 'Gemini 3.1 Pro (High)',
    });

    expect(res.ok).toBe(true); // no INVALID_INPUT conflict — Gemini allows override on resume
    expect(lastArgs[lastArgs.indexOf('--model') + 1]).toBe('Gemini 3.1 Pro (High)');
    expect(lastArgs[lastArgs.indexOf('--conversation') + 1]).toBe('conv-x');
  });
});
