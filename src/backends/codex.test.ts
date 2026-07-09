import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCodexBackend } from './codex.js';
import { looksLikeDiff } from './orchestrator.js';
import { ErrorCode } from '../utils/errors.js';
import type { ReviewBridgeConfig } from '../config/types.js';
import { DEFAULT_CONFIG } from '../config/types.js';

// Mock chunking so we can control chunk counts without huge diffs
vi.mock('../utils/chunking.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/chunking.js')>();
  return {
    ...actual,
    chunkDiff: vi.fn(actual.chunkDiff),
  };
});

import { chunkDiff } from '../utils/chunking.js';
const mockChunkDiff = vi.mocked(chunkDiff);

// Mock thread factory — configurable per test
let mockRun: ReturnType<typeof vi.fn>;
let mockThreadId: string | null;

function makeMockThread() {
  return {
    run: mockRun,
    get id() {
      return mockThreadId;
    },
  };
}

type ThreadFactory = (...args: unknown[]) => ReturnType<typeof makeMockThread>;
let mockStartThread: ReturnType<typeof vi.fn<ThreadFactory>>;
let mockResumeThread: ReturnType<typeof vi.fn<ThreadFactory>>;

let mockConstructorThrow: Error | null;
let mockConstructorOptions: { codexPathOverride?: string } | undefined;

vi.mock('@openai/codex-sdk', () => {
  // Must use function (not arrow) so it's valid as a constructor with `new`
  function MockCodex(options?: { codexPathOverride?: string }) {
    mockConstructorOptions = options;
    if (mockConstructorThrow) throw mockConstructorThrow;
    return {
      startThread: (...args: unknown[]) => mockStartThread(...args),
      resumeThread: (...args: unknown[]) => mockResumeThread(...args),
    };
  }
  return { Codex: MockCodex };
});

// ISS-021: binary discovery touches the real filesystem and spawns processes —
// always mocked here so unit tests stay hermetic. Defaults to "nothing found"
// (set per-test in the auto-discovery describe block).
vi.mock('./codex-binary.js', () => ({ discoverCodexBinary: vi.fn() }));
import { discoverCodexBinary } from './codex-binary.js';
const mockDiscover = vi.mocked(discoverCodexBinary);

beforeEach(() => {
  vi.clearAllMocks();
  mockThreadId = 'thread_abc123';
  mockRun = vi.fn();
  mockStartThread = vi.fn(() => makeMockThread());
  mockResumeThread = vi.fn(() => makeMockThread());
  mockConstructorThrow = null;
  mockConstructorOptions = undefined;
  delete process.env.CODEX_PATH;
  // mockReset (not just clear) so a per-test discovery path never leaks into
  // the next test's implementation; default: no system codex found.
  mockDiscover.mockReset();
  mockDiscover.mockResolvedValue(null);
  // The flow narrates the resolved model on stderr for unpinned reviews; these
  // tests don't assert on it, so keep their output clean.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const config: ReviewBridgeConfig = { ...DEFAULT_CONFIG };

// Valid responses matching the response schemas (without session_id)
const validPlanResponse = {
  verdict: 'approve',
  summary: 'Plan looks solid',
  findings: [{ severity: 'minor', category: 'style', description: 'Consider renaming', file: null, line: null, suggestion: null }],
};

const validCodeResponse = {
  verdict: 'request_changes',
  summary: 'Issues found',
  findings: [{ severity: 'critical', category: 'bug', description: 'Null pointer', file: null, line: null, suggestion: null }],
};

const validPrecommitResponse = {
  ready_to_commit: true,
  blockers: [],
  warnings: ['Large diff'],
};

// ISS-021: when the SDK's bundled codex binary can't run (macOS XProtect
// quarantine) and no explicit override is set, the backend discovers a working
// system codex once and retries through codexPathOverride. Discovery itself is
// module-mocked above; these tests drive the recovery wiring.
describe('codex binary auto-discovery (ISS-021)', () => {
  // Classifies as PROVIDER_UNAVAILABLE ("spawn codex" + ENOENT).
  const spawnFailure = () => new Error('spawn codex ENOENT');

  it('discovers a system codex and retries once when the bundled binary cannot run', async () => {
    mockDiscover.mockResolvedValue('/found/bin/codex');
    mockRun
      .mockRejectedValueOnce(spawnFailure())
      .mockResolvedValueOnce({ finalResponse: JSON.stringify(validPlanResponse) });

    const result = await createCodexBackend(config).reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(true);
    expect(mockDiscover).toHaveBeenCalledTimes(1);
    // The SDK client was rebuilt pointing at the discovered binary.
    expect(mockConstructorOptions).toEqual({ codexPathOverride: '/found/bin/codex' });
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('never discovers when config.codex_path is set (explicit pin wins)', async () => {
    mockRun.mockRejectedValue(spawnFailure());
    const pinned = { ...config, codex_path: '/pinned/codex' };

    const result = await createCodexBackend(pinned).reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('PROVIDER_UNAVAILABLE');
      expect(result.error).not.toContain('auto-discovery');
    }
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('never discovers when the CODEX_PATH env is set', async () => {
    process.env.CODEX_PATH = '/env/codex';
    try {
      mockRun.mockRejectedValue(spawnFailure());
      const result = await createCodexBackend(config).reviewPlan({ plan: 'plan' });
      expect(result.ok).toBe(false);
      expect(mockDiscover).not.toHaveBeenCalled();
    } finally {
      delete process.env.CODEX_PATH;
    }
  });

  it('appends an auto-discovery note when no system codex is found', async () => {
    mockDiscover.mockResolvedValue(null);
    mockRun.mockRejectedValue(spawnFailure());

    const result = await createCodexBackend(config).reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('PROVIDER_UNAVAILABLE');
      expect(result.error).toContain('auto-discovery: no working system codex');
    }
  });

  it('attempts discovery at most once per backend instance', async () => {
    mockDiscover.mockResolvedValue(null);
    mockRun.mockRejectedValue(spawnFailure());
    const client = createCodexBackend(config);

    await client.reviewPlan({ plan: 'plan' });
    await client.reviewPlan({ plan: 'plan' });

    expect(mockDiscover).toHaveBeenCalledTimes(1);
  });

  it('does not trigger discovery for non-PROVIDER_UNAVAILABLE failures', async () => {
    mockRun.mockRejectedValue(new Error('429 rate limit exceeded'));

    const result = await createCodexBackend(config).reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('RATE_LIMITED');
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('concurrent failing reviews share ONE discovery and both recover', async () => {
    // Review-round finding: without memoization, the loser of the race got
    // 'skipped' and failed while the winner recovered. State-based mock: every
    // run fails until the SDK client is rebuilt on the discovered binary.
    mockDiscover.mockResolvedValue('/found/bin/codex');
    mockRun.mockImplementation(async () => {
      if (mockConstructorOptions?.codexPathOverride === '/found/bin/codex') {
        return { finalResponse: JSON.stringify(validPlanResponse) };
      }
      throw spawnFailure();
    });
    const client = createCodexBackend(config);

    const [a, b] = await Promise.all([
      client.reviewPlan({ plan: 'plan a' }),
      client.reviewPlan({ plan: 'plan b' }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(mockDiscover).toHaveBeenCalledTimes(1); // shared, not raced
  });

  it('contains a discovery throw as not-found instead of escaping the Result contract', async () => {
    mockDiscover.mockRejectedValue(new Error('fs exploded'));
    mockRun.mockRejectedValue(spawnFailure());

    const result = await createCodexBackend(config).reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('PROVIDER_UNAVAILABLE');
      expect(result.error).toContain('auto-discovery: no working system codex');
    }
  });

  it('returns the failure when the retry with the discovered binary also fails (no loop)', async () => {
    mockDiscover.mockResolvedValue('/found/bin/codex');
    mockRun.mockRejectedValue(spawnFailure());

    const result = await createCodexBackend(config).reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('PROVIDER_UNAVAILABLE');
    expect(mockDiscover).toHaveBeenCalledTimes(1); // once, never looped
    expect(mockRun).toHaveBeenCalledTimes(2); // original + single retry
  });

  it('narrates the substitution on stderr and points at codex_path', async () => {
    mockDiscover.mockResolvedValue('/found/bin/codex');
    mockRun
      .mockRejectedValueOnce(spawnFailure())
      .mockResolvedValueOnce({ finalResponse: JSON.stringify(validPlanResponse) });
    const errSpy = vi.spyOn(console, 'error');

    await createCodexBackend(config).reviewPlan({ plan: 'plan' });

    const narration = errSpy.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('/found/bin/codex'));
    expect(narration).toBeDefined();
    expect(narration).toContain('codex_path');
  });
});

describe('looksLikeDiff', () => {
  it('accepts standard git diff with headers and hunks', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
+new line`;
    expect(looksLikeDiff(diff)).toBe(true);
  });

  it('accepts diff with diff --git and hunks only', () => {
    expect(looksLikeDiff('diff --git a/f b/f\n@@ -1 +1 @@\n-old\n+new')).toBe(true);
  });

  it('accepts diff with file headers and hunks (no diff --git)', () => {
    expect(looksLikeDiff('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new')).toBe(true);
  });

  it('rejects plain prose', () => {
    expect(looksLikeDiff('This is a summary of my changes to the authentication system.')).toBe(false);
  });

  it('rejects prose that mentions diff --git without hunks', () => {
    expect(looksLikeDiff('I ran diff --git and saw some changes in the auth module.')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(looksLikeDiff('')).toBe(false);
  });

  it('rejects text with only hunk markers (no file headers)', () => {
    expect(looksLikeDiff('@@ -1,3 +1,4 @@\nsome content')).toBe(false);
  });

  it('accepts diff --git with file headers (no hunks)', () => {
    expect(looksLikeDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\ncontext line')).toBe(true);
  });

  // ISS-005: hunk-less-but-valid git diffs must be accepted.
  it('accepts a rename-only diff (no hunks, no ---/+++)', () => {
    expect(
      looksLikeDiff('diff --git a/old.js b/new.js\nsimilarity index 100%\nrename from old.js\nrename to new.js'),
    ).toBe(true);
  });

  it('accepts a binary diff (Binary files ... differ)', () => {
    expect(
      looksLikeDiff(
        'diff --git a/img.png b/img.png\nnew file mode 100644\nindex 0000000..abc1234\nBinary files /dev/null and b/img.png differ',
      ),
    ).toBe(true);
  });

  it('accepts a binary diff (GIT binary patch)', () => {
    expect(looksLikeDiff('diff --git a/img.png b/img.png\nindex abc..def 100644\nGIT binary patch\nzcmV')).toBe(true);
  });

  it('accepts a mixed rename + content diff', () => {
    const diff =
      'diff --git a/old.js b/new.js\nsimilarity index 100%\nrename from old.js\nrename to new.js\n' +
      'diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new';
    expect(looksLikeDiff(diff)).toBe(true);
  });

  it('accepts a mode-only change diff', () => {
    expect(looksLikeDiff('diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755')).toBe(true);
  });

  it('accepts a copy-only diff', () => {
    expect(
      looksLikeDiff('diff --git a/orig.js b/copy.js\nsimilarity index 100%\ncopy from orig.js\ncopy to copy.js'),
    ).toBe(true);
  });

  it('accepts an empty-file creation diff', () => {
    expect(looksLikeDiff('diff --git a/empty.txt b/empty.txt\nnew file mode 100644\nindex 0000000..e69de29')).toBe(true);
  });

  it('accepts an empty-file deletion diff', () => {
    expect(
      looksLikeDiff('diff --git a/empty.txt b/empty.txt\ndeleted file mode 100644\nindex e69de29..0000000'),
    ).toBe(true);
  });

  it('rejects metadata lines without diff --git (metadata requires diff --git)', () => {
    expect(looksLikeDiff('rename from old.js\nrename to new.js')).toBe(false);
  });
});

describe('createCodexBackend', () => {
  it('returns object with reviewPlan, reviewCode, reviewPrecommit', () => {
    const client = createCodexBackend(config);
    expect(typeof client.reviewPlan).toBe('function');
    expect(typeof client.reviewCode).toBe('function');
    expect(typeof client.reviewPrecommit).toBe('function');
  });

  it("exposes its provider identity as 'codex'", () => {
    expect(createCodexBackend(config).provider).toBe('codex');
  });

  it('reports it cannot change model on a resumed session (SDK reasserts --model)', () => {
    expect(createCodexBackend(config).allowsModelOverrideOnResume).toBe(false);
  });
});

describe('reviewPlan', () => {
  it('returns parsed PlanReviewResult with session_id from thread', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'My plan' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verdict).toBe('approve');
      expect(result.data.summary).toBe('Plan looks solid');
      expect(result.data.findings).toHaveLength(1);
      expect(result.data.session_id).toBe('thread_abc123');
    }
  });
});

describe('model resolution (codex)', () => {
  it('resolves an unset model to the SDK-pinned default and passes it to startThread', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });
    await createCodexBackend(config).reviewPlan({ plan: 'My plan' });
    expect(mockStartThread.mock.calls[0][0]).toMatchObject({ model: 'gpt-5.6-sol' });
  });

  it("resolves model 'latest' to the SDK-pinned default (never passes the literal 'latest')", async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });
    await createCodexBackend(config).reviewPlan({ plan: 'My plan', model: 'latest' });
    expect(mockStartThread.mock.calls[0][0]).toMatchObject({ model: 'gpt-5.6-sol' });
  });

  it('forwards an explicit model pin unchanged to startThread', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });
    await createCodexBackend(config).reviewPlan({ plan: 'My plan', model: 'gpt-5.4' });
    expect(mockStartThread.mock.calls[0][0]).toMatchObject({ model: 'gpt-5.4' });
  });
});

describe('codex binary override (codex_path)', () => {
  it('passes config.codex_path to the SDK as codexPathOverride', () => {
    createCodexBackend({ ...config, codex_path: '/Users/me/.local/bin/codex' });
    expect(mockConstructorOptions).toEqual({ codexPathOverride: '/Users/me/.local/bin/codex' });
  });

  it('falls back to the CODEX_PATH env var when config.codex_path is unset', () => {
    process.env.CODEX_PATH = '/opt/codex/bin/codex';
    createCodexBackend(config);
    expect(mockConstructorOptions).toEqual({ codexPathOverride: '/opt/codex/bin/codex' });
  });

  it('prefers config.codex_path over the CODEX_PATH env var', () => {
    process.env.CODEX_PATH = '/env/codex';
    createCodexBackend({ ...config, codex_path: '/config/codex' });
    expect(mockConstructorOptions).toEqual({ codexPathOverride: '/config/codex' });
  });

  it('passes codexPathOverride: undefined (SDK uses its bundled binary) when neither is set', () => {
    createCodexBackend(config);
    expect(mockConstructorOptions).toEqual({ codexPathOverride: undefined });
  });
});

describe('provider unavailable (binary missing / killed / quarantined)', () => {
  it('classifies a constructor "unable to locate codex" as PROVIDER_UNAVAILABLE', async () => {
    mockConstructorThrow = new Error('Unable to locate Codex CLI binaries. Ensure @openai/codex is installed.');
    const res = await createCodexBackend(config).reviewPlan({ plan: 'x' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(ErrorCode.PROVIDER_UNAVAILABLE);
  });

  it('classifies a spawn ENOENT (binary trashed) as PROVIDER_UNAVAILABLE', async () => {
    mockRun.mockRejectedValue(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
    const res = await createCodexBackend(config).reviewPlan({ plan: 'x' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(ErrorCode.PROVIDER_UNAVAILABLE);
  });

  it('classifies a SIGKILL as PROVIDER_UNAVAILABLE, not REVIEW_TIMEOUT', async () => {
    mockRun.mockRejectedValue(new Error('codex process was killed with signal SIGKILL'));
    const res = await createCodexBackend(config).reviewPlan({ plan: 'x' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain(ErrorCode.PROVIDER_UNAVAILABLE);
      expect(res.error).not.toContain(ErrorCode.REVIEW_TIMEOUT);
    }
  });
});

describe('reviewCode', () => {
  it('returns parsed CodeReviewResult', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validCodeResponse) });

    const client = createCodexBackend(config);
    const result = await client.reviewCode({ diff: 'some diff' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verdict).toBe('request_changes');
      expect(result.data.session_id).toBe('thread_abc123');
    }
  });
});

describe('reviewPrecommit', () => {
  it('returns parsed PrecommitResult', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPrecommitResponse) });

    const client = createCodexBackend(config);
    const result = await client.reviewPrecommit({ diff: 'staged diff' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.ready_to_commit).toBe(true);
      expect(result.data.warnings).toEqual(['Large diff']);
      expect(result.data.session_id).toBe('thread_abc123');
    }
  });
});

describe('retry on parse failure', () => {
  it('retries once on malformed JSON and succeeds', async () => {
    mockRun
      .mockResolvedValueOnce({ finalResponse: 'not json {{{' })
      .mockResolvedValueOnce({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(true);
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('returns RESPONSE_PARSE_ERROR after two malformed JSON attempts', async () => {
    mockRun.mockResolvedValue({ finalResponse: 'not json' });

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('RESPONSE_PARSE_ERROR');
    }
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('returns RESPONSE_PARSE_ERROR when valid JSON fails Zod validation after retry', async () => {
    const badShape = { verdict: 'invalid_verdict', summary: 123 };
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(badShape) });

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('RESPONSE_PARSE_ERROR');
    }
  });
});

describe('timeout handling', () => {
  it('returns REVIEW_TIMEOUT on AbortError', async () => {
    const abortError = new DOMException('signal is aborted', 'AbortError');
    mockRun.mockRejectedValue(abortError);

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('REVIEW_TIMEOUT');
    }
  });

  it('returns REVIEW_TIMEOUT on generic error containing "aborted"', async () => {
    const err = new Error('The operation was aborted');
    mockRun.mockRejectedValue(err);

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('REVIEW_TIMEOUT');
    }
  });

  it('returns REVIEW_TIMEOUT on case-variant abort message', async () => {
    const err = new Error('Request Aborted by signal');
    mockRun.mockRejectedValue(err);

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('REVIEW_TIMEOUT');
    }
  });

  // m2: a timeout on the RETRY, after attempt 1 already produced unparseable
  // output, must surface the parse failure (the actionable cause) — not mask it
  // as a timeout. A bare timeout with no prior parse failure still reports
  // REVIEW_TIMEOUT (covered above).
  it('reports RESPONSE_PARSE_ERROR, not REVIEW_TIMEOUT, when the retry times out after a malformed first attempt', async () => {
    mockRun
      .mockResolvedValueOnce({ finalResponse: 'not json {{{' })
      .mockRejectedValueOnce(new DOMException('signal is aborted', 'AbortError'));

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('RESPONSE_PARSE_ERROR');
      expect(result.error).not.toContain('REVIEW_TIMEOUT');
    }
    expect(mockRun).toHaveBeenCalledTimes(2);
  });
});

describe('session management', () => {
  it('calls startThread when no session_id provided', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexBackend(config);
    await client.reviewPlan({ plan: 'plan' });

    expect(mockStartThread).toHaveBeenCalledTimes(1);
    expect(mockResumeThread).not.toHaveBeenCalled();
  });

  it('calls resumeThread when session_id provided', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexBackend(config);
    await client.reviewPlan({ plan: 'plan', session_id: 'existing_thread' });

    expect(mockResumeThread).toHaveBeenCalledWith('existing_thread', expect.any(Object));
    expect(mockStartThread).not.toHaveBeenCalled();
  });

  it('returns SESSION_NOT_FOUND when resumeThread throws', async () => {
    mockResumeThread.mockImplementation(() => {
      throw new Error('Thread not found');
    });

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan', session_id: 'bad_id' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('SESSION_NOT_FOUND');
    }
  });

  it('returns UNKNOWN_ERROR when startThread throws unrecognized error (no session_id)', async () => {
    mockStartThread.mockImplementation(() => {
      throw new Error('Failed to spawn');
    });

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('UNKNOWN_ERROR');
      expect(result.error).not.toContain('SESSION_NOT_FOUND');
    }
  });

  it('classifies auth errors from startThread', async () => {
    mockStartThread.mockImplementation(() => {
      throw new Error('api_key not set');
    });

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('AUTH_ERROR');
    }
  });

  it('classifies network errors from startThread', async () => {
    mockStartThread.mockImplementation(() => {
      throw new Error('fetch failed');
    });

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('NETWORK_ERROR');
    }
  });

  it('uses input session_id when thread.id is null', async () => {
    mockThreadId = null;
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan', session_id: 'fallback_id' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.session_id).toBe('fallback_id');
    }
  });
});

describe('runtime errors', () => {
  it('returns UNKNOWN_ERROR when thread.run throws non-abort error', async () => {
    mockRun.mockRejectedValue(new Error('Something completely unexpected'));

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('UNKNOWN_ERROR');
    }
  });
});

describe('error classification', () => {
  it('returns AUTH_ERROR when thread.run throws with "api_key"', async () => {
    mockRun.mockRejectedValue(new Error('Invalid api_key provided'));

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('AUTH_ERROR');
      expect(result.error).toContain('Set OPENAI_API_KEY');
    }
  });

  it('returns AUTH_ERROR when error contains "authentication"', async () => {
    mockRun.mockRejectedValue(new Error('Authentication failed'));

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('AUTH_ERROR');
    }
  });

  it('returns AUTH_ERROR when error contains "401"', async () => {
    mockRun.mockRejectedValue(new Error('401 Unauthorized'));

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('AUTH_ERROR');
    }
  });

  it('returns MODEL_ERROR with extracted model name', async () => {
    mockRun.mockRejectedValue(new Error('The model "o9-turbo" is not supported'));

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('MODEL_ERROR');
      expect(result.error).toContain('o9-turbo');
    }
  });

  it('returns MODEL_ERROR with config model when name not in error', async () => {
    const customConfig = { ...config, model: 'custom-model-7' };
    mockRun.mockRejectedValue(new Error('The model is not found'));

    const client = createCodexBackend(customConfig);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('MODEL_ERROR');
      expect(result.error).toContain('custom-model-7');
    }
  });

  it('returns MODEL_ERROR for backtick-quoted name with "does not exist" phrasing', async () => {
    mockRun.mockRejectedValue(new Error('The model `gpt-9` does not exist'));

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('MODEL_ERROR');
      expect(result.error).toContain('gpt-9');
    }
  });

  // ISS-001: error bodies containing "detail" + "model" + "not supported" in unrelated
  // contexts were misclassified as MODEL_ERROR with the first quoted token ("detail")
  // used as the model name, swallowing the real error.
  it('does NOT misclassify JSON error bodies as MODEL_ERROR with bogus model name (ISS-001)', async () => {
    mockRun.mockRejectedValue(
      new Error(
        'OpenAI API error: {"detail": "Schema validation failed: model field invalid; reasoning_effort value not supported"}',
      ),
    );

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain('Model "detail"');
      expect(result.error).toContain('Schema validation failed');
    }
  });

  it('preserves raw error text in MODEL_ERROR message (ISS-001 defense-in-depth)', async () => {
    mockRun.mockRejectedValue(new Error('The model "o9-turbo" is not supported'));

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('MODEL_ERROR');
      expect(result.error).toContain('o9-turbo');
      expect(result.error).toContain('The model "o9-turbo" is not supported');
    }
  });

  it('surfaces ChatGPT-account fallback tip recommending a different model + the Gemini backend', async () => {
    mockRun.mockRejectedValue(
      new Error(`The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.`),
    );

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('MODEL_ERROR');
      expect(result.error).toContain('gpt-5.6-sol'); // the failing model is named in the error
      expect(result.error).toContain('ChatGPT-tier Codex');
      expect(result.error).toContain('"model": "gpt-5.5"'); // recommend a DIFFERENT model
      expect(result.error).toContain('"provider": "gemini"'); // Gemini fallback
    }
  });

  // ISS-009: the old tip hardcoded a fallback, so a failing fallback model was
  // told to use itself — recommending the model that just failed.
  it('never recommends the failing model in the fallback tip (ISS-009)', async () => {
    const failing = { ...config, model: 'gpt-5.5' };
    mockRun.mockRejectedValue(
      new Error(`The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.`),
    );

    const result = await createCodexBackend(failing).reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('MODEL_ERROR');
      expect(result.error).toContain('"model": "gpt-5.6-sol"'); // recommends the OTHER model
      expect(result.error).not.toContain('Try "model": "gpt-5.5"'); // not the failed one
      expect(result.error).toContain('"provider": "gemini"');
    }
  });

  it('uses generic MODEL_ERROR tip (different model + Gemini) when ChatGPT account is not mentioned', async () => {
    // T-032: pin the model to the rejected name so this stays a same-model case
    // (rejected model === sent model) and keeps exercising the generic tip. With
    // default config sends gpt-5.6-sol, which differs from phantom-99
    // and correctly route to the internal-call mismatch message instead (ISS-003).
    const sameModel = { ...config, model: 'phantom-99' };
    mockRun.mockRejectedValue(new Error('The model "phantom-99" is not supported'));

    const client = createCodexBackend(sameModel);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('MODEL_ERROR');
      expect(result.error).toContain('"model": "gpt-5.6-sol"');
      expect(result.error).toContain('"provider": "gemini"');
      expect(result.error).not.toContain('ChatGPT-tier Codex');
      expect(result.error).not.toContain('will not fix'); // not the mismatch branch
    }
  });

  // ISS-003 (T-032): when Codex rejects a model whose name differs from the one we
  // actually sent, the failure came from a Codex-internal call (e.g. the CLI's
  // memory agent hardcoding gpt-5.1-codex-mini), not the caller's model setting —
  // so surface a distinct message and do NOT offer model-config tips that can't help.
  it('returns the internal-call mismatch message when the rejected model differs from the sent model (ISS-003)', async () => {
    const configured = { ...config, model: 'gpt-5.4' };
    mockRun.mockRejectedValue(new Error('The model "gpt-5.1-codex-mini" is not supported'));

    const result = await createCodexBackend(configured).reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('MODEL_ERROR'); // failover eligibility unchanged
      expect(result.error).toContain('gpt-5.1-codex-mini'); // the rejected internal model
      expect(result.error).toContain('gpt-5.4'); // the model the review actually sent
      expect(result.error).toContain('will not fix'); // distinct mismatch guidance
      expect(result.error).toContain('"provider": "gemini"'); // escape hatch still offered
      // raw error preserved (ISS-001 contract)
      expect(result.error).toContain('The model "gpt-5.1-codex-mini" is not supported');
      // NOT the generic "change your model" tip — that can't fix an internal call
      expect(result.error).not.toContain('Try "model":');
    }
  });

  it('keeps the generic tip when the rejected model equals the sent model (ISS-003 boundary)', async () => {
    const configured = { ...config, model: 'gpt-5.4' };
    mockRun.mockRejectedValue(new Error('The model "gpt-5.4" is not supported'));

    const result = await createCodexBackend(configured).reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('MODEL_ERROR');
      expect(result.error).toContain('"model": "gpt-5.6-sol"'); // recommend the OTHER model
      expect(result.error).toContain('"provider": "gemini"');
      expect(result.error).not.toContain('will not fix'); // not the mismatch branch
      expect(result.error).not.toContain('ChatGPT-tier Codex');
    }
  });

  it('treats a casing-only difference as the same model, not a mismatch (ISS-003)', async () => {
    // Model ids are case-insensitive: "GPT-5.6-SOL" is the same model we sent,
    // so this must take the same-model generic path, not the internal-call message.
    mockRun.mockRejectedValue(new Error('The model "GPT-5.6-SOL" is not supported'));

    const result = await createCodexBackend(config).reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('MODEL_ERROR');
      expect(result.error).not.toContain('will not fix'); // NOT the mismatch branch
      expect(result.error).toContain('"provider": "gemini"');
    }
  });

  it('does NOT match when "model" and "not supported" are in different sentences', async () => {
    mockRun.mockRejectedValue(new Error('The current model works fine. However, the operation is not supported.'));

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain('MODEL_ERROR');
      expect(result.error).toContain('UNKNOWN_ERROR');
    }
  });

  it('returns RATE_LIMITED when error contains "rate_limit"', async () => {
    mockRun.mockRejectedValue(new Error('rate_limit exceeded'));

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('RATE_LIMITED');
      expect(result.error).toContain('Wait');
    }
  });

  // ISS-008: ChatGPT-tier Codex reports a hit monthly cap as "You've hit your
  // usage limit ... try again at <date>" (not a 429). It was falling through to
  // UNKNOWN_ERROR, which is vague and — critically — wouldn't trigger failover.
  it('returns RATE_LIMITED for usage-limit / quota wording (ISS-008)', async () => {
    for (const raw of [
      "You've hit your usage limit. To continue, try again at Jul 28th, 2026.",
      'quota exceeded for this organization',
    ]) {
      mockRun.mockRejectedValue(new Error(raw));
      const result = await createCodexBackend(config).reviewPlan({ plan: 'plan' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('RATE_LIMITED');
    }
  });

  it('returns NETWORK_ERROR when error contains "fetch failed"', async () => {
    mockRun.mockRejectedValue(new Error('fetch failed'));

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('NETWORK_ERROR');
      expect(result.error).toContain('Check your internet connection');
    }
  });

  it('returns NETWORK_ERROR when error contains "ECONNREFUSED"', async () => {
    mockRun.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:443'));

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('NETWORK_ERROR');
    }
  });

  it('returns NETWORK_ERROR when error contains "ENOTFOUND"', async () => {
    mockRun.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.openai.com'));

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('NETWORK_ERROR');
    }
  });

  it('preserves raw message for unknown errors', async () => {
    mockRun.mockRejectedValue(new Error('Something totally unknown'));

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('UNKNOWN_ERROR');
      expect(result.error).toContain('Something totally unknown');
    }
  });
});

describe('per-call model override (T-011)', () => {
  it('reviewPlan forwards override to startThread, not config.model', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexBackend(config);
    await client.reviewPlan({ plan: 'plan', model: 'gpt-5.4' });

    expect(mockStartThread).toHaveBeenCalledOnce();
    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.4' }),
    );
  });

  it('reviewCode forwards override to startThread on single-chunk path', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validCodeResponse) });

    const client = createCodexBackend(config);
    await client.reviewCode({
      diff: 'diff --git a/f b/f\n@@ -1 +1 @@\n-old\n+new',
      model: 'gpt-5.4',
    });

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.4' }),
    );
  });

  it('reviewPrecommit forwards override to startThread on single-chunk path', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPrecommitResponse) });

    const client = createCodexBackend(config);
    await client.reviewPrecommit({
      diff: 'diff --git a/f b/f\n@@ -1 +1 @@\n-old\n+new',
      model: 'gpt-5.4',
    });

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.4' }),
    );
  });

  it('uses config.model when set and no per-call override is given', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexBackend({ ...config, model: 'gpt-5.4' });
    await client.reviewPlan({ plan: 'plan' });

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.4' }),
    );
  });

  it('falls back to the backend default model when neither override nor config.model is set', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexBackend({ ...config, model: undefined });
    await client.reviewPlan({ plan: 'plan' });

    // codex resolves its own default — the schema no longer supplies one.
    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.6-sol' }),
    );
  });

  it('rejects session_id + model combination with INVALID_INPUT', async () => {
    const client = createCodexBackend(config);
    const result = await client.reviewPlan({
      plan: 'plan',
      session_id: 'existing_session',
      model: 'gpt-5.4',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('INVALID_INPUT');
      expect(result.error).toContain('Cannot change model on a resumed session');
    }
    // Must reject before any SDK call
    expect(mockStartThread).not.toHaveBeenCalled();
    expect(mockResumeThread).not.toHaveBeenCalled();
  });

  it('multi-chunk: override applies on chunk 1 via startThread; chunks 2..N resume without override', async () => {
    // Force 2 chunks by mocking chunkDiff
    mockChunkDiff.mockReturnValue([
      'diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+A',
      'diff --git a/b b/b\n@@ -1 +1 @@\n-b\n+B',
    ]);
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validCodeResponse) });

    const client = createCodexBackend(config);
    await client.reviewCode({
      diff: 'large diff',
      model: 'gpt-5.4',
    });

    // Chunk 1: startThread with the override
    expect(mockStartThread).toHaveBeenCalledOnce();
    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.4' }),
    );
    // Chunk 2: resumeThread is called WITHOUT any `model` field. The SDK
    // would otherwise forward `--model` to the CLI and reassert a model
    // on a resumed thread — breaking the "inherit" guarantee. The resumed
    // thread keeps whatever model it was started with.
    expect(mockResumeThread).toHaveBeenCalledOnce();
    expect(mockResumeThread).toHaveBeenCalledWith(
      'thread_abc123',
      expect.not.objectContaining({ model: expect.anything() }),
    );
  });

  it('reviewPrecommit multi-chunk: override on chunk 1; chunks 2..N resume without override', async () => {
    // Mirror of the reviewCode multi-chunk test above. The precommit loop
    // shares the same `sessionId ? undefined : input.model` guard, and a
    // copy-paste error in its version would only be caught here.
    mockChunkDiff.mockReturnValue([
      'diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+A',
      'diff --git a/b b/b\n@@ -1 +1 @@\n-b\n+B',
    ]);
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPrecommitResponse) });

    const client = createCodexBackend(config);
    await client.reviewPrecommit({
      diff: 'large staged diff',
      model: 'gpt-5.4',
    });

    expect(mockStartThread).toHaveBeenCalledOnce();
    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.4' }),
    );
    expect(mockResumeThread).toHaveBeenCalledOnce();
    expect(mockResumeThread).toHaveBeenCalledWith(
      'thread_abc123',
      expect.not.objectContaining({ model: expect.anything() }),
    );
  });
});

describe('constructor error classification', () => {
  it('classifies auth errors during SDK init', async () => {
    mockConstructorThrow = new Error('api_key not set');

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('AUTH_ERROR');
      expect(result.error).toContain('SDK initialization failed');
    }
  });

  it('classifies network errors during SDK init', async () => {
    mockConstructorThrow = new Error('fetch failed');

    const client = createCodexBackend(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('NETWORK_ERROR');
      expect(result.error).toContain('SDK initialization failed');
    }
  });
});

describe('config passthrough', () => {
  it('passes model and reasoning effort to thread options', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const customConfig: ReviewBridgeConfig = {
      ...DEFAULT_CONFIG,
      model: 'o3',
      reasoning_effort: 'high',
    };
    const client = createCodexBackend(customConfig);
    await client.reviewPlan({ plan: 'plan' });

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'o3',
        modelReasoningEffort: 'high',
      }),
    );
  });
});

describe('config flows to prompts', () => {
  const configWithContext: ReviewBridgeConfig = {
    ...DEFAULT_CONFIG,
    project_context: 'Fintech app, PCI-DSS required',
    review_standards: {
      ...DEFAULT_CONFIG.review_standards,
      plan_review: {
        focus: ['security', 'compliance'],
        depth: 'thorough' as const,
      },
      code_review: {
        criteria: ['security', 'performance'],
        require_tests: true,
      },
      precommit: {
        auto_diff: true,
        block_on: ['critical', 'major'] as Array<'critical' | 'major' | 'minor' | 'suggestion' | 'nitpick'>,
      },
    },
  };

  it('reviewPlan prompt includes project_context from config', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexBackend(configWithContext);
    await client.reviewPlan({ plan: 'My plan' });

    const prompt = mockRun.mock.calls[0][0] as string;
    expect(prompt).toContain('Fintech app, PCI-DSS required');
  });

  it('reviewPlan prompt uses config focus as fallback', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexBackend(configWithContext);
    await client.reviewPlan({ plan: 'My plan' });

    const prompt = mockRun.mock.calls[0][0] as string;
    expect(prompt).toContain('security');
    expect(prompt).toContain('compliance');
  });

  it('reviewCode prompt includes project_context from config', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validCodeResponse) });

    const client = createCodexBackend(configWithContext);
    await client.reviewCode({ diff: 'some diff' });

    const prompt = mockRun.mock.calls[0][0] as string;
    expect(prompt).toContain('Fintech app, PCI-DSS required');
  });

  it('reviewCode prompt includes test coverage when require_tests is true', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validCodeResponse) });

    const client = createCodexBackend(configWithContext);
    await client.reviewCode({ diff: 'some diff' });

    const prompt = mockRun.mock.calls[0][0] as string;
    expect(prompt).toContain('Test coverage');
  });

  it('reviewPrecommit prompt includes project_context from config', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPrecommitResponse) });

    const client = createCodexBackend(configWithContext);
    await client.reviewPrecommit({ diff: 'staged diff' });

    const prompt = mockRun.mock.calls[0][0] as string;
    expect(prompt).toContain('Fintech app, PCI-DSS required');
  });

  it('reviewPrecommit prompt includes block_on severity threshold', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPrecommitResponse) });

    const client = createCodexBackend(configWithContext);
    await client.reviewPrecommit({ diff: 'staged diff' });

    const prompt = mockRun.mock.calls[0][0] as string;
    expect(prompt).toContain('critical or major');
  });

  it('reviewPlan prompt uses severity rubric', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexBackend(config);
    await client.reviewPlan({ plan: 'My plan' });

    const prompt = mockRun.mock.calls[0][0] as string;
    expect(prompt).toContain('Severity definitions');
  });

  it('reviewCode prompt uses severity rubric', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validCodeResponse) });

    const client = createCodexBackend(config);
    await client.reviewCode({ diff: 'some diff' });

    const prompt = mockRun.mock.calls[0][0] as string;
    expect(prompt).toContain('Severity definitions');
  });
});

describe('constructor failure', () => {
  it('returns UNKNOWN_ERROR from all methods when SDK constructor throws', async () => {
    mockConstructorThrow = new Error('Missing binary');

    const client = createCodexBackend(config);

    const plan = await client.reviewPlan({ plan: 'plan' });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toContain('UNKNOWN_ERROR');

    const code = await client.reviewCode({ diff: 'diff' });
    expect(code.ok).toBe(false);
    if (!code.ok) expect(code.error).toContain('SDK initialization failed');

    const pre = await client.reviewPrecommit({ diff: 'diff' });
    expect(pre.ok).toBe(false);
    if (!pre.ok) expect(pre.error).toContain('UNKNOWN_ERROR');
  });
});

describe('chunking', () => {
  const makeCodeResponse = (verdict: string, findings: Array<{ severity: string; category: string; file: string | null; line: number | null }> = [], summary = 'chunk summary') =>
    JSON.stringify({
      verdict,
      summary,
      findings: findings.map((f) => ({ ...f, description: 'desc', suggestion: null })),
    });

  const makePrecommitResponse = (ready: boolean, blockers: string[] = [], warnings: string[] = []) =>
    JSON.stringify({ ready_to_commit: ready, blockers, warnings });

  it('small diff (under threshold) uses single startThread, no chunks_reviewed', async () => {
    mockChunkDiff.mockReturnValue(['small diff']);
    mockRun.mockResolvedValue({ finalResponse: makeCodeResponse('approve') });

    const client = createCodexBackend(config);
    const result = await client.reviewCode({ diff: 'small diff' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.chunks_reviewed).toBeUndefined();
    }
    expect(mockStartThread).toHaveBeenCalledTimes(1);
  });

  it('multi-chunk code review uses startThread once then resumeThread', async () => {
    mockChunkDiff.mockReturnValue(['chunk1', 'chunk2']);
    const thread1Id = 'thread_chunk1';
    const thread2Id = 'thread_chunk2';

    mockStartThread.mockImplementation(() => {
      return { run: mockRun, get id() { return thread1Id; } };
    });
    mockResumeThread.mockImplementation(() => {
      return { run: mockRun, get id() { return thread2Id; } };
    });

    mockRun.mockResolvedValue({ finalResponse: makeCodeResponse('approve') });

    const client = createCodexBackend(config);
    const result = await client.reviewCode({ diff: 'big diff' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.chunks_reviewed).toBe(2);
    }
    expect(mockStartThread).toHaveBeenCalledTimes(1);
    expect(mockResumeThread).toHaveBeenCalledTimes(1);
    expect(mockResumeThread).toHaveBeenCalledWith(thread1Id, expect.any(Object));
  });

  it('verdict precedence: approve + request_changes = request_changes', async () => {
    mockChunkDiff.mockReturnValue(['chunk1', 'chunk2']);
    mockRun
      .mockResolvedValueOnce({ finalResponse: makeCodeResponse('approve') })
      .mockResolvedValueOnce({ finalResponse: makeCodeResponse('request_changes') });

    const client = createCodexBackend(config);
    const result = await client.reviewCode({ diff: 'big diff' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verdict).toBe('request_changes');
    }
  });

  it('verdict precedence: reject + approve = reject', async () => {
    mockChunkDiff.mockReturnValue(['chunk1', 'chunk2']);
    mockRun
      .mockResolvedValueOnce({ finalResponse: makeCodeResponse('reject') })
      .mockResolvedValueOnce({ finalResponse: makeCodeResponse('approve') });

    const client = createCodexBackend(config);
    const result = await client.reviewCode({ diff: 'big diff' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verdict).toBe('reject');
    }
  });

  it('dedup: same file:line:category from two chunks keeps worst severity', async () => {
    mockChunkDiff.mockReturnValue(['chunk1', 'chunk2']);
    mockRun
      .mockResolvedValueOnce({
        finalResponse: makeCodeResponse('request_changes', [
          { severity: 'minor', category: 'bug', file: 'src/a.ts', line: 10 },
        ]),
      })
      .mockResolvedValueOnce({
        finalResponse: makeCodeResponse('request_changes', [
          { severity: 'critical', category: 'bug', file: 'src/a.ts', line: 10 },
        ]),
      });

    const client = createCodexBackend(config);
    const result = await client.reviewCode({ diff: 'big diff' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.findings).toHaveLength(1);
      expect(result.data.findings[0].severity).toBe('critical');
    }
  });

  it('null file/line findings are always preserved (no dedup)', async () => {
    mockChunkDiff.mockReturnValue(['chunk1', 'chunk2']);
    mockRun
      .mockResolvedValueOnce({
        finalResponse: makeCodeResponse('approve', [
          { severity: 'minor', category: 'style', file: null, line: null },
        ]),
      })
      .mockResolvedValueOnce({
        finalResponse: makeCodeResponse('approve', [
          { severity: 'minor', category: 'style', file: null, line: null },
        ]),
      });

    const client = createCodexBackend(config);
    const result = await client.reviewCode({ diff: 'big diff' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.findings).toHaveLength(2);
    }
  });

  it('different categories at same file:line are both kept', async () => {
    mockChunkDiff.mockReturnValue(['chunk1', 'chunk2']);
    mockRun
      .mockResolvedValueOnce({
        finalResponse: makeCodeResponse('request_changes', [
          { severity: 'major', category: 'bug', file: 'src/a.ts', line: 10 },
        ]),
      })
      .mockResolvedValueOnce({
        finalResponse: makeCodeResponse('request_changes', [
          { severity: 'major', category: 'security', file: 'src/a.ts', line: 10 },
        ]),
      });

    const client = createCodexBackend(config);
    const result = await client.reviewCode({ diff: 'big diff' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.findings).toHaveLength(2);
    }
  });

  it('error mid-chunk propagates immediately, skips remaining chunks', async () => {
    mockChunkDiff.mockReturnValue(['chunk1', 'chunk2', 'chunk3']);
    mockRun
      .mockResolvedValueOnce({ finalResponse: makeCodeResponse('approve') })
      .mockRejectedValueOnce(new Error('fetch failed'));

    const client = createCodexBackend(config);
    const result = await client.reviewCode({ diff: 'big diff' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('NETWORK_ERROR');
    }
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('caller session_id: first chunk resumes with provided id', async () => {
    mockChunkDiff.mockReturnValue(['chunk1', 'chunk2']);
    mockRun.mockResolvedValue({ finalResponse: makeCodeResponse('approve') });

    const client = createCodexBackend(config);
    await client.reviewCode({ diff: 'big diff', session_id: 'existing_thread' });

    expect(mockStartThread).not.toHaveBeenCalled();
    expect(mockResumeThread).toHaveBeenCalledTimes(2);
    expect(mockResumeThread.mock.calls[0][0]).toBe('existing_thread');
  });

  it('empty diff returns synthetic approve with no thread calls', async () => {
    mockChunkDiff.mockReturnValue([]);

    const client = createCodexBackend(config);
    const result = await client.reviewCode({ diff: '' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verdict).toBe('approve');
      expect(result.data.summary).toBe('No changes to review.');
      expect(result.data.chunks_reviewed).toBeUndefined();
      expect(result.data.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    expect(mockStartThread).not.toHaveBeenCalled();
    expect(mockResumeThread).not.toHaveBeenCalled();
  });

  it('empty diff with session_id preserves the session_id', async () => {
    mockChunkDiff.mockReturnValue([]);

    const client = createCodexBackend(config);
    const result = await client.reviewCode({ diff: '', session_id: 'prev_sess' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.session_id).toBe('prev_sess');
    }
  });

  it('precommit multi-chunk: ready_to_commit false if any chunk false', async () => {
    mockChunkDiff.mockReturnValue(['chunk1', 'chunk2']);
    mockRun
      .mockResolvedValueOnce({ finalResponse: makePrecommitResponse(true, [], ['warn1']) })
      .mockResolvedValueOnce({ finalResponse: makePrecommitResponse(false, ['blocker1'], []) });

    const client = createCodexBackend(config);
    const result = await client.reviewPrecommit({ diff: 'big staged diff' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.ready_to_commit).toBe(false);
      expect(result.data.blockers).toEqual(['blocker1']);
      expect(result.data.warnings).toEqual(['warn1']);
      expect(result.data.chunks_reviewed).toBe(2);
    }
  });

  it('precommit empty diff returns synthetic pass with no thread calls', async () => {
    mockChunkDiff.mockReturnValue([]);

    const client = createCodexBackend(config);
    const result = await client.reviewPrecommit({ diff: '' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.ready_to_commit).toBe(true);
      expect(result.data.blockers).toEqual([]);
      expect(result.data.warnings).toEqual([]);
      expect(result.data.chunks_reviewed).toBeUndefined();
      expect(result.data.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    expect(mockStartThread).not.toHaveBeenCalled();
  });

  it('empty diff without session_id produces unique session_ids per call', async () => {
    mockChunkDiff.mockReturnValue([]);

    const client = createCodexBackend(config);
    const result1 = await client.reviewCode({ diff: '' });
    const result2 = await client.reviewCode({ diff: '' });

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (result1.ok && result2.ok) {
      expect(result1.data.session_id).not.toBe(result2.data.session_id);
    }
  });

  it('criteria: [] falls through to config criteria for budget calculation', async () => {
    mockChunkDiff.mockReturnValue(['single chunk']);
    mockRun.mockResolvedValue({ finalResponse: makeCodeResponse('approve') });

    const client = createCodexBackend(config);

    // Call with no criteria — should use config criteria for budget
    await client.reviewCode({ diff: 'some diff' });
    const budgetWithoutCriteria = mockChunkDiff.mock.calls[0][1];

    mockChunkDiff.mockClear();

    // Call with empty criteria — should also use config criteria for budget (same as above)
    await client.reviewCode({ diff: 'some diff', criteria: [] });
    const budgetWithEmptyCriteria = mockChunkDiff.mock.calls[0][1];

    expect(budgetWithEmptyCriteria).toBe(budgetWithoutCriteria);
  });

  // T-001: when a mid-chunk failure happens after chunk 1 has already
  // established a Codex thread, the partial session id must travel back on
  // the error so the tool layer can mark that session failed instead of
  // leaving it orphaned in_progress.
  it('multi-chunk reviewCode: chunk 2 timeout returns the chunk-1 thread id on the error', async () => {
    mockChunkDiff.mockReturnValue(['chunk1', 'chunk2']);
    const thread1Id = 'thread_partial_failure';
    mockStartThread.mockImplementation(() => ({ run: mockRun, get id() { return thread1Id; } }));
    mockResumeThread.mockImplementation(() => ({ run: mockRun, get id() { return thread1Id; } }));

    mockRun
      .mockResolvedValueOnce({ finalResponse: makeCodeResponse('approve') })
      .mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));

    const client = createCodexBackend(config);
    const result = await client.reviewCode({ diff: 'big diff' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('REVIEW_TIMEOUT');
      expect(result.session_id).toBe(thread1Id);
    }
  });

  it('multi-chunk reviewPrecommit: chunk 2 timeout returns the chunk-1 thread id on the error', async () => {
    mockChunkDiff.mockReturnValue(['chunk1', 'chunk2']);
    const thread1Id = 'thread_pre_partial_failure';
    mockStartThread.mockImplementation(() => ({ run: mockRun, get id() { return thread1Id; } }));
    mockResumeThread.mockImplementation(() => ({ run: mockRun, get id() { return thread1Id; } }));

    const validPrecommit = { ready_to_commit: true, blockers: [], warnings: [] };
    mockRun
      .mockResolvedValueOnce({ finalResponse: JSON.stringify(validPrecommit) })
      .mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));

    const client = createCodexBackend(config);
    const result = await client.reviewPrecommit({ diff: 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('REVIEW_TIMEOUT');
      expect(result.session_id).toBe(thread1Id);
    }
  });
});
