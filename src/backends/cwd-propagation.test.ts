import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err } from '../utils/errors.js';
import { DEFAULT_CONFIG } from '../config/types.js';
import {
  runPlanReview,
  runCodeReview,
  runPrecommitReview,
  runCrossReview,
  type TurnParams,
  type TurnRunner,
  type ReviewFlowDeps,
} from './orchestrator.js';
import { createFailoverBackend } from './failover.js';
import { createDeliberationBackend } from './deliberation.js';
import type {
  ReviewBackend,
  ReviewExecutionContext,
  CodeReviewInput,
  PlanReviewInput,
} from './backend.js';
import type { CodeReviewResult, PlanReviewResult } from '../review/types.js';

// ISS-027 in one place: WHERE a review runs must reach the provider on EVERY
// turn — first chunk and last, fresh and resumed, primary and fallback, reviewer
// and cross-review judge. A turn that silently loses it reads a different
// repository than the caller asked about, and nothing in the response says so.
const REQUESTED: ReviewExecutionContext = { workingDirectory: '/work/repo-b' };

let consoleSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleSpy.mockRestore();
});

function recordingTurn(canned: Record<string, unknown>): {
  turn: TurnRunner;
  calls: TurnParams[];
} {
  const calls: TurnParams[] = [];
  let n = 0;
  const turn: TurnRunner = <T extends Record<string, unknown>>(params: TurnParams) => {
    calls.push({ ...params });
    return Promise.resolve(
      ok({ ...canned, session_id: `session-${n++}` } as T & { session_id: string }),
    );
  };
  return { turn, calls };
}

function deps(overrides: Partial<typeof DEFAULT_CONFIG> = {}): ReviewFlowDeps {
  return {
    config: { ...DEFAULT_CONFIG, ...overrides },
    provider: 'codex',
    allowsModelOverrideOnResume: false,
    resolveModel: async (requested) =>
      requested && requested !== 'latest' ? requested : 'default-model',
    resumesAcrossChunks: true,
  };
}

const PLAN_OK = { verdict: 'approve', summary: 'ok', findings: [] };
const CODE_OK = { verdict: 'approve', summary: 'ok', findings: [] };
const PRECOMMIT_OK = { ready_to_commit: true, blockers: [], warnings: [] };

// Large enough to split at a tiny max_chunk_tokens, so the chunk loop runs.
const BIG_DIFF = Array.from(
  { length: 12 },
  (_, i) =>
    `diff --git a/f${i}.ts b/f${i}.ts\n--- a/f${i}.ts\n+++ b/f${i}.ts\n@@ -1 +1 @@\n-${'a'.repeat(200)}\n+${'b'.repeat(200)}\n`,
).join('');
const SMALL_DIFF = 'diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-a\n+b\n';

describe('every orchestrated turn carries the requested directory', () => {
  it('plan review', async () => {
    const { turn, calls } = recordingTurn(PLAN_OK);
    await runPlanReview({ plan: 'p', execution: REQUESTED }, deps(), turn);
    expect(calls).toHaveLength(1);
    expect(calls[0].workingDirectory).toBe('/work/repo-b');
  });

  it('single-chunk code review', async () => {
    const { turn, calls } = recordingTurn(CODE_OK);
    await runCodeReview({ diff: SMALL_DIFF, execution: REQUESTED }, deps(), turn);
    expect(calls[0].workingDirectory).toBe('/work/repo-b');
  });

  it('single-chunk precommit', async () => {
    const { turn, calls } = recordingTurn(PRECOMMIT_OK);
    await runPrecommitReview({ diff: SMALL_DIFF, execution: REQUESTED }, deps(), turn);
    expect(calls[0].workingDirectory).toBe('/work/repo-b');
  });

  it('EVERY chunk of a multi-chunk code review, not just the first', async () => {
    const { turn, calls } = recordingTurn(CODE_OK);
    await runCodeReview(
      { diff: BIG_DIFF, execution: REQUESTED },
      deps({ max_chunk_tokens: 700 }),
      turn,
    );
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((c) => c.workingDirectory === '/work/repo-b')).toBe(true);
  });

  it('EVERY chunk of a multi-chunk precommit', async () => {
    const { turn, calls } = recordingTurn(PRECOMMIT_OK);
    await runPrecommitReview(
      { diff: BIG_DIFF, execution: REQUESTED },
      deps({ max_chunk_tokens: 700 }),
      turn,
    );
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((c) => c.workingDirectory === '/work/repo-b')).toBe(true);
  });

  it('names the files each chunk held, so a reader can tell which files shared a call', async () => {
    const { turn } = recordingTurn(CODE_OK);
    const result = await runCodeReview(
      { diff: BIG_DIFF, execution: REQUESTED },
      deps({ max_chunk_tokens: 700 }),
      turn,
    );
    if (!result.ok) throw new Error(result.error);
    const files = result.data.chunk_files!;
    expect(files).toHaveLength(result.data.chunks_reviewed!);
    // Every file lands in exactly one chunk, in diff order.
    expect(files.flat()).toEqual(Array.from({ length: 12 }, (_, i) => `f${i}.ts`));
    expect(files.every((f) => f.length > 0)).toBe(true);

    const precommit = await runPrecommitReview(
      { diff: BIG_DIFF, execution: REQUESTED },
      deps({ max_chunk_tokens: 700 }),
      recordingTurn(PRECOMMIT_OK).turn,
    );
    if (!precommit.ok) throw new Error(precommit.error);
    expect(precommit.data.chunk_files).toEqual(files);
  });

  it('omits chunk_files when the diff fit in a single call', async () => {
    const { turn } = recordingTurn(CODE_OK);
    const result = await runCodeReview({ diff: SMALL_DIFF, execution: REQUESTED }, deps(), turn);
    if (!result.ok) throw new Error(result.error);
    expect(result.data).not.toHaveProperty('chunk_files');
  });

  it('a RESUMED turn, which is where a divergence would be invisible', async () => {
    // Codex reasserts thread options on resume: a resume that kept the server's
    // directory would move an in-flight review to another repository mid-session.
    const { turn, calls } = recordingTurn(CODE_OK);
    await runCodeReview(
      { diff: SMALL_DIFF, execution: REQUESTED, session_id: 'existing' },
      deps(),
      turn,
    );
    expect(calls[0].sessionId).toBe('existing');
    expect(calls[0].workingDirectory).toBe('/work/repo-b');
  });

  it('the deliberate-deep cross-review turn', async () => {
    const { turn, calls } = recordingTurn({ adjudications: [] });
    await runCrossReview(
      {
        execution: REQUESTED,
        subject: 'code',
        content: SMALL_DIFF,
        findings: [{ severity: 'major', category: 'bug', file: 'f.ts', line: 1, description: 'x' }],
      },
      deps(),
      turn,
    );
    expect(calls[0].workingDirectory).toBe('/work/repo-b');
  });

  it('carries a directory that differs from the process directory', async () => {
    const { turn, calls } = recordingTurn(CODE_OK);
    await runCodeReview({ diff: SMALL_DIFF, execution: REQUESTED }, deps(), turn);
    expect(calls[0].workingDirectory).not.toBe(process.cwd());
  });
});

// --- composites ---

function leaf(
  provider: 'codex' | 'gemini',
  seen: { plan: PlanReviewInput[]; code: CodeReviewInput[]; cross: ReviewExecutionContext[] },
  opts: { failCode?: string } = {},
): ReviewBackend {
  return {
    provider,
    providers: [provider],
    allowsModelOverrideOnResume: provider === 'gemini',
    reviewPlan: (input) => {
      seen.plan.push(input);
      return Promise.resolve(ok({ ...PLAN_OK, session_id: `${provider}-p` } as PlanReviewResult));
    },
    reviewCode: (input) => {
      seen.code.push(input);
      if (opts.failCode) return Promise.resolve(err<CodeReviewResult>(opts.failCode));
      return Promise.resolve(
        ok({
          ...CODE_OK,
          verdict: 'request_changes',
          findings: [
            {
              severity: 'major',
              category: 'bug',
              description: `${provider} finding`,
              file: `${provider}.ts`,
              line: 1,
              suggestion: null,
            },
          ],
          session_id: `${provider}-c`,
        } as CodeReviewResult),
      );
    },
    reviewPrecommit: () => Promise.resolve(err('unused')),
    crossReview: (input) => {
      seen.cross.push(input.execution);
      return Promise.resolve(ok({ adjudications: [] }));
    },
  };
}

function tracker() {
  return {
    plan: [] as PlanReviewInput[],
    code: [] as CodeReviewInput[],
    cross: [] as ReviewExecutionContext[],
  };
}

describe('composites must not drop the directory the way they drop the model', () => {
  it('failover keeps it when falling back to the secondary provider', async () => {
    // The fallback deliberately CLEARS a provider-specific model. The directory
    // is not provider-specific, and clearing it would move the review.
    const seen = tracker();
    const primary = leaf('codex', seen, { failCode: 'RATE_LIMITED: out of usage' });
    const secondary = leaf('gemini', seen);

    const result = await createFailoverBackend(primary, secondary).reviewCode({
      diff: SMALL_DIFF,
      execution: REQUESTED,
      model: 'gpt-5.6-sol',
    });

    expect(result.ok).toBe(true);
    expect(seen.code).toHaveLength(2);
    expect(seen.code[1].execution).toEqual(REQUESTED);
    // ...while the model IS dropped, which is the behavior being contrasted.
    expect(seen.code[1].model).toBeUndefined();
  });

  it('deliberation gives BOTH providers the same directory', async () => {
    const seen = tracker();
    const backend = createDeliberationBackend(leaf('codex', seen), leaf('gemini', seen));

    await backend.reviewCode({ diff: SMALL_DIFF, execution: REQUESTED, model: 'gpt-5.6-sol' });

    expect(seen.code).toHaveLength(2);
    expect(seen.code.every((i) => i.execution === REQUESTED)).toBe(true);
    expect(seen.code[1].model).toBeUndefined();
  });

  it('deliberation gives the plan path the same directory', async () => {
    const seen = tracker();
    const backend = createDeliberationBackend(leaf('codex', seen), leaf('gemini', seen));

    await backend.reviewPlan({ plan: 'p', execution: REQUESTED });

    expect(seen.plan).toHaveLength(2);
    expect(seen.plan.every((i) => i.execution === REQUESTED)).toBe(true);
  });

  it('deliberate-deep hands BOTH cross-review judges the same directory', async () => {
    // Each provider adjudicates the other's divergent findings. A judge running
    // elsewhere would be reasoning about a repository it cannot see.
    const seen = tracker();
    const backend = createDeliberationBackend(leaf('codex', seen), leaf('gemini', seen), {
      crossReview: true,
    });

    await backend.reviewCode({ diff: SMALL_DIFF, execution: REQUESTED });

    expect(seen.cross).toHaveLength(2);
    expect(seen.cross.every((e) => e === REQUESTED)).toBe(true);
  });
});
