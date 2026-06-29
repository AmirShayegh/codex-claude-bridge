import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok } from '../utils/errors.js';
import { DEFAULT_CONFIG } from '../config/types.js';
import {
  runPlanReview,
  runCodeReview,
  type TurnParams,
  type TurnRunner,
  type ReviewFlowDeps,
} from './orchestrator.js';

// A fake TurnRunner that records every call and returns a canned valid result.
// Lets us assert how the flow drives the backend (sessionId/model per turn)
// without any SDK or subprocess.
// The flow narrates the resolved model on stderr for unpinned requests; spy it
// so test output stays quiet and the transparency test can assert on it.
let consoleSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleSpy.mockRestore();
});

function makeFakeTurn(canned: Record<string, unknown>): { turn: TurnRunner; calls: TurnParams[] } {
  const calls: TurnParams[] = [];
  const turn: TurnRunner = <T extends Record<string, unknown>>(params: TurnParams) => {
    calls.push({ ...params });
    return Promise.resolve(ok({ ...canned, session_id: 'fake-session' } as T & { session_id: string }));
  };
  return { turn, calls };
}

const CANNED_PLAN = { verdict: 'approve', summary: 'ok', findings: [] };
const CANNED_CODE = { verdict: 'approve', summary: 'ok', findings: [] };

const SMALL_DIFF = 'diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-a\n+b\n';

// Build a multi-file diff large enough to force the chunk loop to split.
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

function deps(
  allowsModelOverrideOnResume: boolean,
  overrides: Partial<typeof DEFAULT_CONFIG> = {},
  resumesAcrossChunks = true,
): ReviewFlowDeps {
  return {
    config: { ...DEFAULT_CONFIG, ...overrides },
    allowsModelOverrideOnResume,
    // Faithful stand-in for a backend resolver: an explicit pin passes through,
    // 'latest'/unset collapses to a fixed default. Backend-specific 'latest'
    // discovery (agy models / SDK pin) is tested in the backend suites.
    resolveModel: async (requested) => (requested && requested !== 'latest' ? requested : 'default-model'),
    resumesAcrossChunks,
  };
}

// Like makeFakeTurn but returns a distinct session id per call (session-0,
// session-1, ...) so tests can assert which session each chunk runs against.
function makeCountingTurn(canned: Record<string, unknown>): { turn: TurnRunner; calls: TurnParams[] } {
  const calls: TurnParams[] = [];
  let n = 0;
  const turn: TurnRunner = <T extends Record<string, unknown>>(params: TurnParams) => {
    calls.push({ ...params });
    const session_id = `session-${n++}`;
    return Promise.resolve(ok({ ...canned, session_id } as T & { session_id: string }));
  };
  return { turn, calls };
}

describe('orchestrator — allowsModelOverrideOnResume capability', () => {
  it('capability=false: session_id + model is rejected as a conflict; turn not called', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_PLAN);
    const res = await runPlanReview({ plan: 'do a thing', session_id: 's1', model: 'm' }, deps(false), turn);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('Cannot change model on a resumed session');
    expect(calls).toHaveLength(0);
  });

  it('capability=true: session_id + model is allowed and the model is forwarded to the turn', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_PLAN);
    const res = await runPlanReview({ plan: 'do a thing', session_id: 's1', model: 'm' }, deps(true), turn);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe('s1');
    expect(calls[0].model).toBe('m');
  });

  it('capability=true single-chunk code review: forwards both session_id and model', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_CODE);
    const res = await runCodeReview({ diff: SMALL_DIFF, session_id: 's1', model: 'm' }, deps(true), turn);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe('s1');
    expect(calls[0].model).toBe('m');
  });

  it('capability=true multi-chunk: model is forwarded on every chunk, including resumed ones', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_CODE);
    // Tiny budget forces the diff to split into several chunks.
    const res = await runCodeReview({ diff: bigDiff(3, 30), model: 'm' }, deps(true, { max_chunk_tokens: 2500 }), turn);
    expect(res.ok).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // Every turn (chunk 1 fresh + chunks 2..N resumed) carries the model.
    expect(calls.every((c) => c.model === 'm')).toBe(true);
  });

  it('capability=false multi-chunk: model applies on chunk 1 only, omitted on resumed chunks', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_CODE);
    const res = await runCodeReview({ diff: bigDiff(3, 30), model: 'm' }, deps(false, { max_chunk_tokens: 2500 }), turn);
    expect(res.ok).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0].model).toBe('m');
    expect(calls.slice(1).every((c) => c.model === undefined)).toBe(true);
  });
});

describe('orchestrator — model resolution wiring', () => {
  function resolverDeps(
    allowsModelOverrideOnResume: boolean,
    resolveModel: (requested: string | undefined) => Promise<string>,
  ): ReviewFlowDeps {
    return { config: { ...DEFAULT_CONFIG }, allowsModelOverrideOnResume, resolveModel, resumesAcrossChunks: true };
  }

  it('uses the resolved id for both model and resolvedModel on a fresh session', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_PLAN);
    await runPlanReview({ plan: 'x' }, resolverDeps(false, async () => 'RESOLVED-X'), turn);
    expect(calls[0].model).toBe('RESOLVED-X');
    expect(calls[0].resolvedModel).toBe('RESOLVED-X');
  });

  it('omits the per-turn model on a Codex-style resume but still reports resolvedModel', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_PLAN);
    await runPlanReview({ plan: 'x', session_id: 's1' }, resolverDeps(false, async () => 'RESOLVED-X'), turn);
    expect(calls[0].sessionId).toBe('s1');
    expect(calls[0].model).toBeUndefined();
    expect(calls[0].resolvedModel).toBe('RESOLVED-X');
  });

  it('forwards the resolved model on resume when the backend allows it (Gemini-style)', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_PLAN);
    await runPlanReview({ plan: 'x', session_id: 's1' }, resolverDeps(true, async () => 'RESOLVED-X'), turn);
    expect(calls[0].model).toBe('RESOLVED-X');
    expect(calls[0].resolvedModel).toBe('RESOLVED-X');
  });

  it('narrates the resolved model on stderr for an unpinned (latest/unset) request', async () => {
    const { turn } = makeFakeTurn(CANNED_PLAN);
    await runPlanReview({ plan: 'x' }, resolverDeps(false, async () => 'RESOLVED-X'), turn);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('RESOLVED-X'));
  });

  it('stays quiet when an explicit model is pinned', async () => {
    const { turn } = makeFakeTurn(CANNED_PLAN);
    await runPlanReview({ plan: 'x', model: 'pinned-1' }, resolverDeps(true, async (r) => r ?? 'x'), turn);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('passes the per-call override (or config.model) into resolveModel verbatim', async () => {
    const { turn } = makeFakeTurn(CANNED_PLAN);
    const seen: (string | undefined)[] = [];
    const resolve = async (req: string | undefined): Promise<string> => {
      seen.push(req);
      return req ?? 'fallback';
    };
    await runPlanReview({ plan: 'x', model: 'pinned-1' }, resolverDeps(true, resolve), turn);
    await runPlanReview({ plan: 'x' }, resolverDeps(true, resolve), turn);
    expect(seen).toEqual(['pinned-1', undefined]);
  });

  it('resolves the model once and applies it across every chunk of a multi-chunk review', async () => {
    const { turn, calls } = makeCountingTurn(CANNED_CODE);
    let resolveCount = 0;
    const d: ReviewFlowDeps = {
      config: { ...DEFAULT_CONFIG, max_chunk_tokens: 2500 },
      allowsModelOverrideOnResume: true,
      resolveModel: async () => { resolveCount++; return 'RESOLVED-X'; },
      resumesAcrossChunks: false,
    };
    const res = await runCodeReview({ diff: bigDiff(3, 30) }, d, turn);
    expect(res.ok).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(resolveCount).toBe(1); // resolved once per review, not per chunk
    expect(calls.every((c) => c.resolvedModel === 'RESOLVED-X' && c.model === 'RESOLVED-X')).toBe(true);
  });
});

describe('orchestrator — resumesAcrossChunks capability (chunked reviews)', () => {
  it('resumesAcrossChunks=true (Codex): chunks 2..N resume the prior chunk session', async () => {
    const { turn, calls } = makeCountingTurn(CANNED_CODE);
    const res = await runCodeReview({ diff: bigDiff(3, 30) }, deps(false, { max_chunk_tokens: 2500 }, true), turn);
    expect(res.ok).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0].sessionId).toBeUndefined(); // chunk 1 starts fresh
    expect(calls[1].sessionId).toBe('session-0'); // chunk 2 resumes chunk 1's session
    // Review id is the last threaded session (all one thread for real Codex).
    if (res.ok) expect(res.data.session_id).toBe(`session-${calls.length - 1}`);
  });

  it('resumesAcrossChunks=false (Gemini): chunks 2..N run independently; review id is chunk 1', async () => {
    const { turn, calls } = makeCountingTurn(CANNED_CODE);
    const res = await runCodeReview({ diff: bigDiff(3, 30) }, deps(true, { max_chunk_tokens: 2500 }, false), turn);
    expect(res.ok).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0].sessionId).toBeUndefined(); // chunk 1 fresh (no cross-phase session)
    // Later chunks do NOT resume chunk 1 — independent sessions, no O(N²) growth.
    expect(calls.slice(1).every((c) => c.sessionId === undefined)).toBe(true);
    if (res.ok) expect(res.data.session_id).toBe('session-0'); // chunk 1's id is the review's
  });

  it('resumesAcrossChunks=false: chunk 1 resumes a cross-phase input session, later chunks do not', async () => {
    const { turn, calls } = makeCountingTurn(CANNED_CODE);
    const res = await runCodeReview(
      { diff: bigDiff(3, 30), session_id: 'prior-phase' },
      deps(true, { max_chunk_tokens: 2500 }, false),
      turn,
    );
    expect(res.ok).toBe(true);
    expect(calls[0].sessionId).toBe('prior-phase'); // cross-phase resume on chunk 1 only
    expect(calls.slice(1).every((c) => c.sessionId === undefined)).toBe(true);
    if (res.ok) expect(res.data.session_id).toBe('session-0'); // chunk 1's fresh id
  });
});
