import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ErrorCode } from '../utils/errors.js';
import { subprocessEnv, isStrippedGitVariable } from '../utils/subprocess-env.js';

// --- node:child_process mock: a controllable fake child process ---
// We mock only the external boundary (the agy subprocess). Each test drives the
// fake's stdout/stderr/exit, and the fake honors the AbortSignal so we can test
// the timeout path with fake timers.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinChunks: string[] = [];
  // stdin is a real EventEmitter so tests can drive an EPIPE 'error' on it — a
  // plain object could never emit, which is exactly why C1 went unnoticed.
  stdin: EventEmitter & { write: (s: string) => void; end: ReturnType<typeof vi.fn> };
  constructor(signal?: AbortSignal) {
    super();
    const stdin = new EventEmitter() as EventEmitter & {
      write: (s: string) => void;
      end: ReturnType<typeof vi.fn>;
    };
    stdin.write = (s: string) => {
      this.stdinChunks.push(s);
    };
    stdin.end = vi.fn();
    this.stdin = stdin;
    signal?.addEventListener('abort', () => {
      this.emit(
        'error',
        Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
      );
    });
  }
}

let lastChild: FakeChild;
let lastArgs: string[];
let lastCwd: string | undefined;
let spawnThrows: Error | undefined;
let spawnCount = 0;
// Captured so the env/PWD contract is actually asserted: agy keys its
// conversation cache by workspace path, so a wrong PWD silently files the new
// conversation id under the server's directory and the later lookup misses.
let lastEnv: NodeJS.ProcessEnv | undefined;
// onEmit fires just before a scripted child emits — lets a test mutate the
// id-cache per run, simulating how real agy updates last_conversations.json. Used
// to prove runSerialized makes capture atomic under concurrency.
type Scripted = { stdout?: string; stderr?: string; code?: number; onEmit?: () => void };
let scriptedResponses: Scripted[] = [];

vi.mock('node:child_process', () => ({
  spawn: (
    _cmd: string,
    args: string[],
    options: { cwd?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
  ) => {
    if (spawnThrows) throw spawnThrows;
    lastArgs = args;
    lastCwd = options.cwd;
    lastEnv = options.env;
    spawnCount += 1;
    const child = new FakeChild(options.signal);
    lastChild = child;
    // If a response is scripted, auto-emit it on the next microtask (after the
    // caller registers its listeners). Otherwise the test drives the child by
    // hand (the runAgyPrint unit tests below do this).
    const scripted = scriptedResponses.shift();
    if (scripted) {
      queueMicrotask(() => {
        scripted.onEmit?.();
        if (scripted.stdout !== undefined) child.stdout.emit('data', Buffer.from(scripted.stdout));
        if (scripted.stderr !== undefined) child.stderr.emit('data', Buffer.from(scripted.stderr));
        child.emit('close', scripted.code ?? 0);
      });
    }
    return child;
  },
}));

function script(...responses: Scripted[]): void {
  scriptedResponses.push(...responses);
}

// What agy actually prints for a successful turn: NDJSON progress events and a
// final `result` event whose `response` is the model's text. Review fixtures go
// through this so the tests speak the real protocol, not raw JSON on stdout.
function agyResultLine(response: string, status = 'SUCCESS', error?: string): string {
  const init = JSON.stringify({ event: 'init', conversation_id: 'conv-fixture' });
  const result = JSON.stringify({
    event: 'result',
    result: { conversation_id: 'conv-fixture', status, response, ...(error ? { error } : {}) },
  });
  return `${init}\n${result}\n`;
}

function agyOk(response: unknown): Scripted {
  return { stdout: agyResultLine(JSON.stringify(response)) };
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
  parseAgyModels,
  warnIfUnknownModel,
  clearGeminiModelCatalogCache,
} from './gemini.js';
import { DEFAULT_CONFIG } from '../config/types.js';

// Every backend call now carries WHERE it runs (ISS-027). Tests that don't care
// about the directory share this one fixture; tests that do build their own.
const EXEC = { workingDirectory: '/work/repo-b' };

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
  lastEnv = undefined;
  clearGeminiModelCatalogCache();
  // The flow narrates the resolved model on stderr for unpinned reviews; these
  // tests don't assert on it, so keep their output clean.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

const OPTS = {
  prompt: 'review this',
  model: 'Gemini 3.5 Flash (Medium)',
  cwd: '/repo',
  timeoutMs: 5000,
};

describe('runAgyPrint', () => {
  it('spawns agy in sandbox stream-json mode, sends the prompt as one NDJSON message, returns the result response', async () => {
    const p = runAgyPrint(OPTS);
    lastChild.stdout.emit('data', Buffer.from(agyResultLine('{"verdict":"approve"}')));
    lastChild.emit('close', 0);
    const res = await p;

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toBe('{"verdict":"approve"}');
    // No --print at all: the prompt is not on argv, so nothing on the command
    // line can be mistaken for it, and nothing caps its size.
    expect(lastArgs).toEqual([
      '--sandbox',
      '--model',
      'Gemini 3.5 Flash (Medium)',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ]);
    expect(lastArgs).not.toContain('--print');
    expect(lastArgs).not.toContain('--conversation');
    expect(lastArgs).not.toContain('--dangerously-skip-permissions');
    expect(lastCwd).toBe('/repo');
    // Exactly one stream-json user message, newline-terminated, then EOF.
    const sent = lastChild.stdinChunks.join('');
    expect(sent.endsWith('\n')).toBe(true);
    expect(JSON.parse(sent)).toEqual({
      event: 'user',
      message: { role: 'user', content: 'review this' },
    });
    expect(lastChild.stdin.end).toHaveBeenCalled();
  });

  it('surfaces an agy-reported failure carried inside an exit-0 result event', async () => {
    const p = runAgyPrint(OPTS);
    lastChild.stdout.emit(
      'data',
      Buffer.from(agyResultLine('', 'ERROR', 'you are not authenticated')),
    );
    lastChild.emit('close', 0);
    const res = await p;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(ErrorCode.AUTH_ERROR);
  });

  it('ignores progress events and takes the LAST result event', async () => {
    const p = runAgyPrint(OPTS);
    const progress = JSON.stringify({ event: 'step_update', step_update: { state: 'DONE' } });
    lastChild.stdout.emit('data', Buffer.from(`${progress}\n`));
    lastChild.stdout.emit('data', Buffer.from(agyResultLine('first')));
    lastChild.stdout.emit('data', Buffer.from(agyResultLine('final')));
    lastChild.emit('close', 0);
    const res = await p;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toBe('final');
  });

  // A large multi-commit review diff already measures over 100 KiB before the
  // prompt scaffolding — the channel must carry it, not refuse it.
  it('carries a prompt far larger than any argv string limit', async () => {
    const big = 'x'.repeat(512 * 1024);
    const p = runAgyPrint({ ...OPTS, prompt: big });
    lastChild.stdout.emit('data', Buffer.from(agyResultLine('{}')));
    lastChild.emit('close', 0);
    const res = await p;
    expect(res.ok).toBe(true);
    expect(lastArgs.join(' ').length).toBeLessThan(1024);
    expect(JSON.parse(lastChild.stdinChunks.join('')).message.content).toHaveLength(big.length);
  });

  it('passes --conversation <id> when resuming a session', async () => {
    const p = runAgyPrint({ ...OPTS, conversationId: 'conv-123' });
    lastChild.stdout.emit('data', Buffer.from(agyResultLine('{}')));
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

  it('survives an EPIPE error on agy stdin without crashing the process (C1)', async () => {
    const p = runAgyPrint(OPTS);
    // agy closed its read end mid-write → EPIPE surfaces as an 'error' on the
    // stdin Writable. With no listener this is an uncaught exception that kills
    // the MCP server; with the fix it is swallowed and the run settles normally.
    expect(() =>
      lastChild.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })),
    ).not.toThrow();
    lastChild.stdout.emit('data', Buffer.from(agyResultLine('{"verdict":"approve"}')));
    lastChild.emit('close', 0);
    const res = await p;
    expect(res.ok).toBe(true);
  });

  it('aborts and errors when agy output exceeds the size cap, without crashing (B2)', async () => {
    const p = runAgyPrint(OPTS);
    // One oversized chunk (>10MB) trips the cap: the run resolves to an error and
    // the child is aborted rather than buffering the stream unbounded.
    expect(() =>
      lastChild.stdout.emit('data', Buffer.from('x'.repeat(10 * 1024 * 1024 + 1))),
    ).not.toThrow();
    const res = await p;
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain(ErrorCode.UNKNOWN_ERROR);
      expect(res.error).toContain('aborted to bound memory');
    }
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
  it('invokes `agy models`, closes stdin (agy blocks on it otherwise), and returns raw stdout', async () => {
    const p = runAgyModels();
    lastChild.stdout.emit('data', Buffer.from(REAL_AGY_MODELS));
    lastChild.emit('close', 0);
    const out = await p;

    expect(out).toBe(REAL_AGY_MODELS);
    expect(lastArgs).toEqual(['models']);
    // Without this, real `agy models` hangs waiting for stdin EOF until timeout.
    expect(lastChild.stdin.end).toHaveBeenCalled();
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

  it('returns null (degrades to fallback) when output exceeds the size cap (B2)', async () => {
    const p = runAgyModels();
    expect(() =>
      lastChild.stdout.emit('data', Buffer.from('x'.repeat(10 * 1024 * 1024 + 1))),
    ).not.toThrow();
    expect(await p).toBeNull(); // over-cap output → null, caller falls back to the default model
  });

  it('survives an EPIPE error on stdin without crashing the process (C1)', async () => {
    const p = runAgyModels();
    expect(() =>
      lastChild.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })),
    ).not.toThrow();
    lastChild.stdout.emit('data', Buffer.from('Gemini 3.5 Flash (Medium)'));
    lastChild.emit('close', 0);
    expect(await p).toBe('Gemini 3.5 Flash (Medium)');
  });
});

describe('resolveLatestGeminiModel', () => {
  it('single-flights and caches the model catalog for repeated resolutions', async () => {
    script({ stdout: REAL_AGY_MODELS, code: 0 });
    const [a, b] = await Promise.all([resolveLatestGeminiModel(), resolveLatestGeminiModel()]);
    const c = await resolveLatestGeminiModel();
    expect(a).toBe('Gemini 3.5 Flash (Medium)');
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(spawnCount).toBe(1);
  });

  it('refreshes the process catalog after the five-minute TTL', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    script(
      { stdout: 'Gemini 4.0 Flash (Medium)', code: 0 },
      { stdout: 'Gemini 4.1 Flash (Medium)', code: 0 },
    );

    expect(await resolveLatestGeminiModel()).toBe('Gemini 4.0 Flash (Medium)');
    clock.mockReturnValue(301_001);
    expect(await resolveLatestGeminiModel()).toBe('Gemini 4.1 Flash (Medium)');
    expect(spawnCount).toBe(2);
  });

  it('resolves to the newest Flash reported by agy', async () => {
    script({ stdout: 'Gemini 4.0 Flash (Medium)\nGemini 3.5 Flash (Medium)', code: 0 });
    expect(await resolveLatestGeminiModel()).toBe('Gemini 4.0 Flash (Medium)');
  });

  it('falls back to the known-good model when the query fails', async () => {
    script({ stderr: 'boom', code: 1 });
    expect(await resolveLatestGeminiModel()).toBe('Gemini 3.5 Flash (Medium)');
  });

  it('caches an unavailable catalog for five minutes instead of repeatedly spawning agy', async () => {
    script({ stderr: 'boom', code: 1 });

    expect(await resolveLatestGeminiModel()).toBe('Gemini 3.5 Flash (Medium)');
    expect(await resolveLatestGeminiModel()).toBe('Gemini 3.5 Flash (Medium)');
    expect(spawnCount).toBe(1);
  });

  it('falls back to the known-good model when no Flash line is parseable', async () => {
    script({ stdout: 'Gemini 9.0 Pro (High)\nGPT-OSS 120B (Medium)', code: 0 });
    expect(await resolveLatestGeminiModel()).toBe('Gemini 3.5 Flash (Medium)');
  });
});

describe('parseAgyModels', () => {
  it('extracts one trimmed model per non-empty line', () => {
    const models = parseAgyModels(REAL_AGY_MODELS);
    expect(models).toHaveLength(8);
    expect(models).toContain('Gemini 3.1 Pro (Low)');
  });

  it('ignores blank lines and surrounding whitespace', () => {
    expect(parseAgyModels('  Gemini 3.5 Flash (Medium) \n\n  Gemini 3.1 Pro (High)\n')).toEqual([
      'Gemini 3.5 Flash (Medium)',
      'Gemini 3.1 Pro (High)',
    ]);
  });
});

// ISS-006: agy silently runs a fallback for an unknown --model (exit 0, no error),
// so a typo'd pin would review on the wrong model unnoticed. The backend validates
// non-recommended pins against `agy models` and warns (non-blocking) on a miss.
describe('warnIfUnknownModel (ISS-006)', () => {
  it('warns when an explicit model is absent from `agy models`', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    script({ stdout: REAL_AGY_MODELS, code: 0 });
    await warnIfUnknownModel('FakeModel-9000');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('FakeModel-9000'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('agy models'));
  });

  it("stays silent when the model is in agy's list", async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    script({ stdout: REAL_AGY_MODELS, code: 0 });
    await warnIfUnknownModel('Gemini 3.1 Pro (Low)');
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent (no false alarm) when `agy models` is unavailable', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    script({ stderr: 'boom', code: 1 });
    await warnIfUnknownModel('Whatever Model');
    expect(warn).not.toHaveBeenCalled();
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

  it.each([
    ['empty', ''],
    ['surrounding whitespace', ' conv-abc '],
    ['control characters', 'conv\u007fabc'],
    ['more than 256 characters', 'x'.repeat(257)],
  ])('returns undefined when the cached conversation id has %s', (_case, conversationId) => {
    fakeFiles[CACHE] = JSON.stringify({ '/repo': conversationId });
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
    await expect(runSerialized(async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    await expect(runSerialized(async () => 'ok')).resolves.toBe('ok');
  });
});

// The directory the REQUEST names — deliberately NOT process.cwd(). agy keys its
// conversation cache by workspace path, so every capture below only works if the
// backend runs in, and looks up under, the requested directory (ISS-027).
const CWD = EXEC.workingDirectory;

const SMALL_DIFF = 'diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b';
const PLAN_OK = { verdict: 'approve', summary: 's', findings: [] };
const CODE_OK = { verdict: 'approve', summary: 's', findings: [] };
// An explicit pin short-circuits `latest` resolution, so the backend makes no
// `agy models` call — these tests then exercise pure agy review mechanics
// (resume / retry / fence / error / capture) with a single spawn per review.
const PINNED_CONFIG = { ...DEFAULT_CONFIG, model: 'Gemini 3.5 Flash (Medium)' };

// A multi-file diff large enough to force the chunk loop to split (paired with a
// tiny max_chunk_tokens). Mirrors the orchestrator suite's bigDiff shape.
function bigDiff(files: number, lines: number): string {
  let out = '';
  for (let f = 0; f < files; f++) {
    out += `diff --git a/file${f}.ts b/file${f}.ts\n--- a/file${f}.ts\n+++ b/file${f}.ts\n@@ -1,${lines} +1,${lines} @@\n`;
    for (let l = 0; l < lines; l++) {
      out += `+const value_${f}_${l} = ${l}; // padding line to grow the diff past the chunk budget\n`;
    }
  }
  return out;
}
const BIG_DIFF = bigDiff(3, 30);

describe('createGeminiBackend', () => {
  it("exposes its provider identity as 'gemini'", () => {
    expect(createGeminiBackend(DEFAULT_CONFIG).provider).toBe('gemini');
  });

  it('reports it can change model on a resumed session', () => {
    expect(createGeminiBackend(DEFAULT_CONFIG).allowsModelOverrideOnResume).toBe(true);
  });

  it('notes on construction that a non-default reasoning_effort is ignored (m3)', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    createGeminiBackend({ ...DEFAULT_CONFIG, reasoning_effort: 'high' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reasoning_effort'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored'));
  });

  it('stays quiet about reasoning_effort when it is the default (medium)', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    createGeminiBackend(DEFAULT_CONFIG);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('reasoning_effort'));
  });

  it('reviewPlan: fresh run with no model resolves the latest Flash from agy, runs in sandbox, captures the id', async () => {
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-new' });
    // First spawn: `agy models`. Second spawn: the review itself.
    script({ stdout: REAL_AGY_MODELS, code: 0 }, agyOk(PLAN_OK));

    const res = await createGeminiBackend(DEFAULT_CONFIG).reviewPlan({
      execution: EXEC,
      plan: 'do a thing',
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.verdict).toBe('approve');
      expect(res.data.session_id).toBe('conv-new'); // captured from agy's cache
    }
    expect(spawnCount).toBe(2); // agy models + the review
    expect(lastArgs).toContain('--sandbox');
    // Resolved to the newest Flash agy reported.
    expect(lastArgs[lastArgs.indexOf('--model') + 1]).toBe('Gemini 3.5 Flash (Medium)');
    expect(lastArgs).not.toContain('--conversation');
    expect(lastCwd).toBe(CWD);
    expect(lastCwd).not.toBe(process.cwd());
  });

  it('reviewCode: resuming a session passes --conversation and reuses that id (no capture needed)', async () => {
    // No cache entry on purpose — the resume path must not depend on capture.
    script(agyOk(CODE_OK));

    const res = await createGeminiBackend(PINNED_CONFIG).reviewCode({
      execution: EXEC,
      diff: SMALL_DIFF,
      session_id: 'conv-prev',
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.session_id).toBe('conv-prev');
    expect(lastArgs[lastArgs.indexOf('--conversation') + 1]).toBe('conv-prev');
  });

  it.each([
    ['empty', ''],
    ['surrounding whitespace', ' conv-prev '],
    ['control characters', 'conv\nforged'],
    ['more than 256 characters', 'x'.repeat(257)],
  ])('rejects a resumed session id with %s before calling agy', async (_case, sessionId) => {
    const result = await createGeminiBackend(PINNED_CONFIG).reviewPlan({
      execution: EXEC,
      plan: 'x',
      session_id: sessionId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(ErrorCode.INVALID_INPUT);
      expect(result.error).toContain('invalid session ID');
      expect(result).not.toHaveProperty('session_id');
    }
    expect(spawnCount).toBe(0);
  });

  it.each([
    ['empty', ''],
    ['surrounding whitespace', ' conv-new '],
    ['control characters', 'conv\u009fforged'],
    ['more than 256 characters', 'x'.repeat(257)],
  ])('rejects a fresh cached conversation id with %s', async (_case, conversationId) => {
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: conversationId });
    script(agyOk(PLAN_OK));

    const result = await createGeminiBackend(PINNED_CONFIG).reviewPlan({
      execution: EXEC,
      plan: 'x',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(ErrorCode.STORAGE_ERROR);
      expect(result.error).toContain('no conversation id was captured');
      expect(result).not.toHaveProperty('session_id');
    }
  });

  it('retries once on malformed JSON, then succeeds (two spawns)', async () => {
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-retry' });
    script({ stdout: 'not json at all' }, agyOk(PLAN_OK));

    const res = await createGeminiBackend(PINNED_CONFIG).reviewPlan({ execution: EXEC, plan: 'x' });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.session_id).toBe('conv-retry');
    expect(spawnCount).toBe(2);
  });

  // m2: when the retry runs out of the shared budget AFTER a malformed first
  // attempt, surface the parse failure — not a timeout. Attempt 1 is scripted
  // malformed (exit 0); attempt 2 is undriven and aborted by advancing past the
  // budget.
  it('reports RESPONSE_PARSE_ERROR, not REVIEW_TIMEOUT, when the retry times out after a malformed attempt (m2)', async () => {
    vi.useFakeTimers();
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-x' });
    script({ stdout: 'not json', code: 0 }); // attempt 1 malformed; attempt 2 left to time out

    const p = createGeminiBackend({ ...PINNED_CONFIG, timeout_seconds: 10 }).reviewPlan({
      execution: EXEC,
      plan: 'x',
    });
    await vi.advanceTimersByTimeAsync(10_000 + 50); // blow past the total budget → attempt 2 aborts
    const res = await p;

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain(ErrorCode.RESPONSE_PARSE_ERROR);
      expect(res.error).not.toContain(ErrorCode.REVIEW_TIMEOUT);
    }
    expect(spawnCount).toBe(2);
  });

  // m2: a genuine process failure (e.g. auth) on the retry after a malformed
  // first attempt must still surface as itself — the mask-fix only diverts
  // timeouts, never real classified errors.
  it('still surfaces a genuine process error on the retry, not a masked parse error (m2)', async () => {
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-x' });
    script(
      { stdout: 'not json', code: 0 },
      { stderr: 'Error: you are not authenticated', code: 1 },
    );

    const res = await createGeminiBackend(PINNED_CONFIG).reviewPlan({ execution: EXEC, plan: 'x' });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain(ErrorCode.AUTH_ERROR);
      expect(res.error).not.toContain(ErrorCode.RESPONSE_PARSE_ERROR);
    }
    expect(spawnCount).toBe(2);
  });

  // m2: the retry gets only the REMAINING budget, not a fresh full timeout.
  // Attempt 1 is driven by hand to consume 6s of a 10s budget, then attempt 2 is
  // aborted after only ~4s more — which a fresh per-attempt 10s timer would not do.
  it('gives the retry only the remaining budget, not a fresh full timeout (m2)', async () => {
    vi.useFakeTimers();
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-x' });

    const p = createGeminiBackend({ ...PINNED_CONFIG, timeout_seconds: 10 }).reviewPlan({
      execution: EXEC,
      plan: 'x',
    });
    // Let attempt 1 spawn, consume 6s, then return malformed (exit 0).
    await vi.advanceTimersByTimeAsync(6_000);
    lastChild.stdout.emit('data', Buffer.from('not json'));
    lastChild.emit('close', 0);
    // Attempt 2 now has only ~4s of budget left; advancing past that aborts it.
    await vi.advanceTimersByTimeAsync(4_000 + 50);
    const res = await p;

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(ErrorCode.RESPONSE_PARSE_ERROR); // timeout-after-malformed → parse error
    expect(spawnCount).toBe(2);
  });

  it('strips a markdown code fence around the JSON before parsing', async () => {
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-fence' });
    script({ stdout: '```json\n' + JSON.stringify(PLAN_OK) + '\n```' });

    const res = await createGeminiBackend(PINNED_CONFIG).reviewPlan({ execution: EXEC, plan: 'x' });
    expect(res.ok).toBe(true);
  });

  it('returns a classified error when agy fails (auth), never throws', async () => {
    script({ stderr: 'Error: you are not authenticated', code: 1 });

    const res = await createGeminiBackend(PINNED_CONFIG).reviewPlan({ execution: EXEC, plan: 'x' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(ErrorCode.AUTH_ERROR);
  });

  it('reports a cache-capture miss as a STORAGE_ERROR, not a parse error (m4)', async () => {
    // cache has no entry for CWD → the review parsed fine but the id can't be read.
    script(agyOk(PLAN_OK));

    const res = await createGeminiBackend(PINNED_CONFIG).reviewPlan({ execution: EXEC, plan: 'x' });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      // The review JSON was valid — this is a storage read failure, not RESPONSE_PARSE_ERROR.
      expect(res.error).toContain(ErrorCode.STORAGE_ERROR);
      expect(res.error).not.toContain(ErrorCode.RESPONSE_PARSE_ERROR);
    }
  });

  it('allows session_id + model together — model override on a resumed session', async () => {
    script(agyOk(CODE_OK));

    const res = await createGeminiBackend(DEFAULT_CONFIG).reviewCode({
      execution: EXEC,
      diff: SMALL_DIFF,
      session_id: 'conv-x',
      model: 'Gemini 3.1 Pro (High)',
    });

    expect(res.ok).toBe(true); // no INVALID_INPUT conflict — Gemini allows override on resume
    expect(lastArgs[lastArgs.indexOf('--model') + 1]).toBe('Gemini 3.1 Pro (High)');
    expect(lastArgs[lastArgs.indexOf('--conversation') + 1]).toBe('conv-x');
  });

  it('model "latest" resolves the newest Flash via `agy models`, then runs the review on it', async () => {
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-latest' });
    script(
      { stdout: 'Gemini 4.0 Flash (Medium)\nGemini 3.5 Flash (Medium)', code: 0 },
      agyOk(CODE_OK),
    );

    const res = await createGeminiBackend(DEFAULT_CONFIG).reviewCode({
      execution: EXEC,
      diff: SMALL_DIFF,
      model: 'latest',
    });

    expect(res.ok).toBe(true);
    expect(spawnCount).toBe(2);
    expect(lastArgs[lastArgs.indexOf('--model') + 1]).toBe('Gemini 4.0 Flash (Medium)');
  });

  it('resolves a tier to its Gemini model without querying `agy models`', async () => {
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-tier' });
    script(agyOk(CODE_OK));

    const res = await createGeminiBackend(DEFAULT_CONFIG).reviewCode({
      execution: EXEC,
      diff: SMALL_DIFF,
      model: 'max',
    });

    expect(res.ok).toBe(true);
    expect(spawnCount).toBe(1);
    expect(lastArgs[lastArgs.indexOf('--model') + 1]).toBe('Gemini 3.1 Pro (High)');
  });

  it('completes the review on the safe fallback model when the `agy models` query fails', async () => {
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-fallback' });
    script({ stderr: 'boom', code: 1 }, agyOk(PLAN_OK));

    const res = await createGeminiBackend(DEFAULT_CONFIG).reviewPlan({
      execution: EXEC,
      plan: 'do a thing',
    });

    expect(res.ok).toBe(true);
    expect(spawnCount).toBe(2);
    expect(lastArgs[lastArgs.indexOf('--model') + 1]).toBe('Gemini 3.5 Flash (Medium)');
  });

  it('sends the orchestrator-built review prompt (including the diff) as the stream-json message', async () => {
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-stdin' });
    script(agyOk(CODE_OK));

    await createGeminiBackend(PINNED_CONFIG).reviewCode({ execution: EXEC, diff: SMALL_DIFF });

    const sent = JSON.parse(lastChild.stdinChunks.join(''));
    expect(sent.event).toBe('user');
    expect(sent.message.content).toContain(SMALL_DIFF); // the diff itself reaches agy
    expect(sent.message.content.length).toBeGreaterThan(SMALL_DIFF.length); // wrapped in a prompt
    expect(lastArgs).not.toContain('--print');
    expect(lastChild.stdin.end).toHaveBeenCalled();
  });

  it('keeps stream-json mode with --conversation on a resumed session', async () => {
    script(agyOk(CODE_OK));

    await createGeminiBackend(PINNED_CONFIG).reviewCode({
      execution: EXEC,
      diff: SMALL_DIFF,
      session_id: 'conv-order',
    });

    expect(lastArgs[lastArgs.indexOf('--conversation') + 1]).toBe('conv-order');
    expect(lastArgs[lastArgs.indexOf('--input-format') + 1]).toBe('stream-json');
    expect(lastArgs[lastArgs.indexOf('--output-format') + 1]).toBe('stream-json');
  });

  it('retries once on empty agy output, then succeeds', async () => {
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-empty' });
    script({ stdout: '', code: 0 }, agyOk(PLAN_OK));

    const res = await createGeminiBackend(PINNED_CONFIG).reviewPlan({ execution: EXEC, plan: 'x' });

    expect(res.ok).toBe(true);
    expect(spawnCount).toBe(2);
  });

  it('chunked review: each chunk is an independent agy run; the review id is chunk 1’s captured id', async () => {
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-chunk1' });
    // Generously script success for every chunk (extra entries are ignored).
    script(...Array.from({ length: 10 }, () => agyOk(CODE_OK)));

    const res = await createGeminiBackend({ ...PINNED_CONFIG, max_chunk_tokens: 2500 }).reviewCode({
      execution: EXEC,
      diff: BIG_DIFF,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.chunks_reviewed).toBeGreaterThanOrEqual(2);
      expect(res.data.session_id).toBe('conv-chunk1'); // chunk 1's id, not a later chunk's
    }
    expect(spawnCount).toBeGreaterThanOrEqual(2);
    // resumesAcrossChunks=false: later chunks run fresh, never resuming a thread.
    expect(lastArgs).not.toContain('--conversation');
  });

  it('an unknown pinned model still runs, but emits a non-blocking warning (ISS-006)', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-bad' });
    // First spawn validates against `agy models`; second is the review.
    script({ stdout: REAL_AGY_MODELS, code: 0 }, agyOk(CODE_OK));

    const res = await createGeminiBackend({
      ...DEFAULT_CONFIG,
      model: 'FakeModel-9000',
    }).reviewCode({ execution: EXEC, diff: SMALL_DIFF });

    expect(res.ok).toBe(true);
    expect(spawnCount).toBe(2);
    // Forwarded as-is — we warn, we don't block (L-006).
    expect(lastArgs[lastArgs.indexOf('--model') + 1]).toBe('FakeModel-9000');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('FakeModel-9000'));
  });

  it('a valid but non-recommended pinned model runs with no warning (ISS-006)', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-low' });
    script({ stdout: REAL_AGY_MODELS, code: 0 }, agyOk(CODE_OK));

    const res = await createGeminiBackend({
      ...DEFAULT_CONFIG,
      model: 'Gemini 3.5 Flash (Low)',
    }).reviewCode({ execution: EXEC, diff: SMALL_DIFF });

    expect(res.ok).toBe(true);
    expect(spawnCount).toBe(2);
    expect(lastArgs[lastArgs.indexOf('--model') + 1]).toBe('Gemini 3.5 Flash (Low)');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a recommended pinned model skips the `agy models` validation query entirely (ISS-006)', async () => {
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-rec' });
    script(agyOk(CODE_OK));

    const res = await createGeminiBackend({
      ...DEFAULT_CONFIG,
      model: 'Gemini 3.1 Pro (High)',
    }).reviewCode({ execution: EXEC, diff: SMALL_DIFF });

    expect(res.ok).toBe(true);
    expect(spawnCount).toBe(1); // known-good model → no extra validation spawn
  });

  it('multi-chunk: a later chunk failure surfaces chunk 1’s session id (T-001)', async () => {
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-partial' });
    // Chunk 1 succeeds (captures conv-partial); chunk 2 fails at the agy boundary.
    script(agyOk(CODE_OK), { stderr: 'you are not authenticated', code: 1 });

    const res = await createGeminiBackend({ ...PINNED_CONFIG, max_chunk_tokens: 2500 }).reviewCode({
      execution: EXEC,
      diff: BIG_DIFF,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain(ErrorCode.AUTH_ERROR);
      expect(res.session_id).toBe('conv-partial'); // T-001: partial session surfaced for cleanup
    }
  });

  it('serializes capture so concurrent fresh reviews get distinct, correctly-paired ids (runSerialized)', async () => {
    // Each run rewrites the id-cache as it emits, the way real agy would. Without
    // runSerialized, review A reads the cache AFTER B has overwritten it, so both
    // capture B's id. Serialization makes each run+capture atomic — this fails
    // deterministically (both become 'race-id-B') if the serialization is removed.
    script(
      {
        ...agyOk(PLAN_OK),
        onEmit: () => {
          fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'race-id-A' });
        },
      },
      {
        ...agyOk(PLAN_OK),
        onEmit: () => {
          fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'race-id-B' });
        },
      },
    );
    const backend = createGeminiBackend(PINNED_CONFIG);

    const [a, b] = await Promise.all([
      backend.reviewPlan({ execution: EXEC, plan: 'A' }),
      backend.reviewPlan({ execution: EXEC, plan: 'B' }),
    ]);

    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.data.session_id).toBe('race-id-A');
      expect(b.data.session_id).toBe('race-id-B');
      expect(a.data.session_id).not.toBe(b.data.session_id);
    }
  });
});

// The env handed to agy is as load-bearing as the cwd: agy keys its conversation
// cache by WORKSPACE PATH, so a PWD naming the server's directory files the new
// conversation id under the wrong key and the later lookup misses — turning a
// successful review into STORAGE_ERROR. An inherited GIT_DIR would likewise
// redirect the reviewer's own view of the repository. Without these assertions
// the spawn mock discards `options.env` and deleting it entirely stays green.
describe('agy subprocess environment', () => {
  it('spawns the reviewer with a sanitized environment whose PWD is the request directory', async () => {
    fakeFiles[CACHE] = JSON.stringify({ [CWD]: 'conv-env' });
    script(agyOk(CODE_OK));

    const res = await createGeminiBackend(PINNED_CONFIG).reviewCode({ diff: 'x', execution: EXEC });

    expect(res.ok).toBe(true);
    expect(lastEnv).toBeDefined();
    expect(lastEnv?.PWD).toBe(CWD);
    expect(lastEnv?.PWD).not.toBe(process.cwd());
    expect(Object.keys(lastEnv ?? {}).filter(isStrippedGitVariable)).toEqual([]);
    expect(lastEnv?.PATH).toBe(subprocessEnv().PATH);
  });

  it('gives the model-catalog probe a sanitized environment too', async () => {
    script({ stdout: REAL_AGY_MODELS });

    await runAgyModels();

    expect(lastEnv).toBeDefined();
    expect(Object.keys(lastEnv ?? {}).filter(isStrippedGitVariable)).toEqual([]);
  });
});
