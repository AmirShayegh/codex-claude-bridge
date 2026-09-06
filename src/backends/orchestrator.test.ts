import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toJSONSchema } from 'zod';
import { ErrorCode, ok } from '../utils/errors.js';
import { DEFAULT_CONFIG } from '../config/types.js';
import {
  runPlanReview,
  runCodeReview,
  runPrecommitReview,
  runCrossReview,
  deduplicateFindings,
  deduplicateModelIdentities,
  mergeCodeResults,
  mergePrecommitResults,
  RESPONSE_SCHEMAS,
  type TurnParams,
  type TurnRunner,
  type ReviewFlowDeps,
} from './orchestrator.js';
import type { ModelIdentity } from '../review/types.js';

// Every backend call now carries WHERE it runs (ISS-027). Tests that don't care
// about the directory share this one fixture; tests that do build their own.
const EXEC = { workingDirectory: '/work/repo-b' };

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
    return Promise.resolve(
      ok({ ...canned, session_id: 'fake-session' } as T & { session_id: string }),
    );
  };
  return { turn, calls };
}

const CANNED_PLAN = { verdict: 'approve', summary: 'ok', findings: [] };
const CANNED_CODE = { verdict: 'approve', summary: 'ok', findings: [] };

const SMALL_DIFF = 'diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-a\n+b\n';

describe('deduplicateModelIdentities', () => {
  it('removes exact duplicates while preserving first-seen order and every identity dimension', () => {
    const base: ModelIdentity = {
      provider: 'codex',
      role: 'review',
      requested: null,
      resolved: 'gpt-5.6-sol',
      observed: 'gpt-5.6-sol',
      evidence: 'runtime_session_record',
    };
    const distinct: ModelIdentity[] = [
      { ...base, provider: 'gemini' },
      { ...base, role: 'adjudication' },
      { ...base, requested: 'latest' },
      { ...base, resolved: 'gpt-5.5' },
      { ...base, observed: null },
      { ...base, evidence: 'bridge_selection' },
    ];

    expect(deduplicateModelIdentities([base, base, ...distinct, base])).toEqual([
      base,
      ...distinct,
    ]);
  });
});

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
    provider: 'codex',
    allowsModelOverrideOnResume,
    // Faithful stand-in for a backend resolver: an explicit pin passes through,
    // 'latest'/unset collapses to a fixed default. Backend-specific 'latest'
    // discovery (agy models / SDK pin) is tested in the backend suites.
    resolveModel: async (requested) =>
      requested && requested !== 'latest' ? requested : 'default-model',
    resumesAcrossChunks,
  };
}

// Like makeFakeTurn but returns a distinct session id per call (session-0,
// session-1, ...) so tests can assert which session each chunk runs against.
function makeCountingTurn(canned: Record<string, unknown>): {
  turn: TurnRunner;
  calls: TurnParams[];
} {
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
    const res = await runPlanReview(
      { execution: EXEC, plan: 'do a thing', session_id: 's1', model: 'm' },
      deps(false),
      turn,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('Cannot change model on a resumed session');
    expect(calls).toHaveLength(0);
  });

  it('capability=true: session_id + model is allowed and the model is forwarded to the turn', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_PLAN);
    const res = await runPlanReview(
      { execution: EXEC, plan: 'do a thing', session_id: 's1', model: 'm' },
      deps(true),
      turn,
    );
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe('s1');
    expect(calls[0].model).toBe('m');
  });

  it('capability=true single-chunk code review: forwards both session_id and model', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_CODE);
    const res = await runCodeReview(
      { execution: EXEC, diff: SMALL_DIFF, session_id: 's1', model: 'm' },
      deps(true),
      turn,
    );
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe('s1');
    expect(calls[0].model).toBe('m');
  });

  it('capability=true multi-chunk: model is forwarded on every chunk, including resumed ones', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_CODE);
    // Tiny budget forces the diff to split into several chunks.
    const res = await runCodeReview(
      { execution: EXEC, diff: bigDiff(3, 30), model: 'm' },
      deps(true, { max_chunk_tokens: 2500 }),
      turn,
    );
    expect(res.ok).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // Every turn (chunk 1 fresh + chunks 2..N resumed) carries the model.
    expect(calls.every((c) => c.model === 'm')).toBe(true);
  });

  it('capability=false multi-chunk: model applies on chunk 1 only, omitted on resumed chunks', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_CODE);
    const res = await runCodeReview(
      { execution: EXEC, diff: bigDiff(3, 30), model: 'm' },
      deps(false, { max_chunk_tokens: 2500 }),
      turn,
    );
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
    return {
      config: { ...DEFAULT_CONFIG },
      provider: allowsModelOverrideOnResume ? 'gemini' : 'codex',
      allowsModelOverrideOnResume,
      resolveModel,
      resumesAcrossChunks: true,
    };
  }

  it('uses the resolved id for both model and resolvedModel on a fresh session', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_PLAN);
    await runPlanReview(
      { execution: EXEC, plan: 'x' },
      resolverDeps(false, async () => 'RESOLVED-X'),
      turn,
    );
    expect(calls[0].model).toBe('RESOLVED-X');
    expect(calls[0].resolvedModel).toBe('RESOLVED-X');
  });

  it('normalizes surrounding whitespace in resolver output before use and reporting', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_PLAN);
    const res = await runPlanReview(
      { execution: EXEC, plan: 'x' },
      resolverDeps(false, async () => '  RESOLVED-X  '),
      turn,
    );

    expect(res.ok).toBe(true);
    expect(calls[0].model).toBe('RESOLVED-X');
    expect(calls[0].resolvedModel).toBe('RESOLVED-X');
    expect(res.ok && res.data.models?.[0]).toMatchObject({ resolved: 'RESOLVED-X' });
  });

  it.each([
    ['control-bearing', 'unsafe\n--another-flag'],
    ['empty after trimming', '   '],
    ['over 200 characters', 'x'.repeat(201)],
  ])('rejects %s resolver output before every provider-facing turn', async (_name, invalid) => {
    const { turn, calls } = makeFakeTurn(CANNED_PLAN);
    const resolveModel = async (): Promise<string> => invalid;
    const finding = {
      severity: 'major' as const,
      category: 'bugs',
      file: 'a.ts',
      line: 1,
      description: 'bug',
    };

    const results = await Promise.all([
      runPlanReview({ execution: EXEC, plan: 'x' }, resolverDeps(false, resolveModel), turn),
      runCodeReview({ execution: EXEC, diff: SMALL_DIFF }, resolverDeps(true, resolveModel), turn),
      runPrecommitReview(
        { execution: EXEC, diff: SMALL_DIFF },
        resolverDeps(false, resolveModel),
        turn,
      ),
      runCrossReview(
        { execution: EXEC, content: SMALL_DIFF, findings: [finding] },
        resolverDeps(true, resolveModel),
        turn,
      ),
    ]);

    expect(calls).toHaveLength(0);
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(
          `${ErrorCode.MODEL_ERROR}: model resolver returned an invalid model label`,
        );
        expect(result.error).not.toContain(invalid);
      }
    }
  });

  it('rejects invalid resolver output once before a multi-chunk review starts', async () => {
    const { turn, calls } = makeCountingTurn(CANNED_CODE);
    const resolveModel = vi.fn().mockResolvedValue('unsafe\u0000model');
    const d = resolverDeps(true, resolveModel);
    d.config = { ...d.config, max_chunk_tokens: 2500 };

    const res = await runCodeReview({ execution: EXEC, diff: bigDiff(3, 30) }, d, turn);

    expect(res.ok).toBe(false);
    expect(resolveModel).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('omits the per-turn model and does not substitute the current default on a Codex-style resume', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_PLAN);
    const resolveModel = vi.fn().mockResolvedValue('CURRENT-DEFAULT');
    const d = resolverDeps(false, resolveModel);
    d.lookupSessionModel = () => ({
      provider: 'codex',
      role: 'review',
      requested: 'gpt-5.5',
      resolved: 'gpt-5.5',
      observed: 'gpt-5.5',
      evidence: 'runtime_session_record',
    });
    const res = await runPlanReview({ execution: EXEC, plan: 'x', session_id: 's1' }, d, turn);
    expect(calls[0].sessionId).toBe('s1');
    expect(calls[0].model).toBeUndefined();
    expect(calls[0].resolvedModel).toBe('gpt-5.5');
    expect(resolveModel).not.toHaveBeenCalled();
    expect(res.ok && res.data.models?.[0]).toMatchObject({
      requested: null,
      resolved: 'gpt-5.5',
      observed: 'gpt-5.5',
    });
  });

  it('prefers fresh runtime observation while retaining the persisted resolved model on resume', async () => {
    const { turn } = makeFakeTurn(CANNED_PLAN);
    const d = resolverDeps(false, vi.fn().mockResolvedValue('CURRENT-DEFAULT'));
    d.lookupSessionModel = () => ({
      provider: 'codex',
      role: 'review',
      requested: 'gpt-5.5',
      resolved: 'gpt-5.5',
      observed: 'gpt-5.5',
      evidence: 'runtime_session_record',
    });
    d.observeSessionModel = vi.fn().mockResolvedValue('gpt-5.6-sol');

    const result = await runPlanReview({ execution: EXEC, plan: 'x', session_id: 's1' }, d, turn);

    expect(result.ok && result.data.models?.[0]).toEqual({
      provider: 'codex',
      role: 'review',
      requested: null,
      resolved: 'gpt-5.5',
      observed: 'gpt-5.6-sol',
      evidence: 'runtime_session_record',
    });
    expect(d.observeSessionModel).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable evidence for a Codex resume with no retained or observed identity', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_PLAN);
    const d = resolverDeps(false, vi.fn().mockResolvedValue('CURRENT-DEFAULT'));

    const result = await runPlanReview(
      { execution: EXEC, plan: 'x', session_id: 'legacy-session' },
      d,
      turn,
    );

    expect(calls[0].model).toBeUndefined();
    expect(calls[0].resolvedModel).toBeUndefined();
    expect(result.ok && result.data.models).toEqual([
      {
        provider: 'codex',
        role: 'review',
        requested: null,
        resolved: null,
        observed: null,
        evidence: 'unavailable',
      },
    ]);
  });

  it('forwards the resolved model on resume when the backend allows it (Gemini-style)', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_PLAN);
    await runPlanReview(
      { execution: EXEC, plan: 'x', session_id: 's1' },
      resolverDeps(true, async () => 'RESOLVED-X'),
      turn,
    );
    expect(calls[0].model).toBe('RESOLVED-X');
    expect(calls[0].resolvedModel).toBe('RESOLVED-X');
  });

  it('narrates the resolved model on stderr for an unpinned (latest/unset) request', async () => {
    const { turn } = makeFakeTurn(CANNED_PLAN);
    await runPlanReview(
      { execution: EXEC, plan: 'x' },
      resolverDeps(false, async () => 'RESOLVED-X'),
      turn,
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('RESOLVED-X'));
  });

  it('stays quiet when an explicit model is pinned', async () => {
    const { turn } = makeFakeTurn(CANNED_PLAN);
    await runPlanReview(
      { execution: EXEC, plan: 'x', model: 'pinned-1' },
      resolverDeps(true, async (r) => r ?? 'x'),
      turn,
    );
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('passes the per-call override (or config.model) into resolveModel verbatim', async () => {
    const { turn } = makeFakeTurn(CANNED_PLAN);
    const seen: (string | undefined)[] = [];
    const resolve = async (req: string | undefined): Promise<string> => {
      seen.push(req);
      return req ?? 'fallback';
    };
    await runPlanReview(
      { execution: EXEC, plan: 'x', model: 'pinned-1' },
      resolverDeps(true, resolve),
      turn,
    );
    await runPlanReview({ execution: EXEC, plan: 'x' }, resolverDeps(true, resolve), turn);
    expect(seen).toEqual(['pinned-1', undefined]);
  });

  it('resolves the model once and applies it across every chunk of a multi-chunk review', async () => {
    const { turn, calls } = makeCountingTurn(CANNED_CODE);
    let resolveCount = 0;
    const d: ReviewFlowDeps = {
      config: { ...DEFAULT_CONFIG, max_chunk_tokens: 2500 },
      provider: 'gemini',
      allowsModelOverrideOnResume: true,
      resolveModel: async () => {
        resolveCount++;
        return 'RESOLVED-X';
      },
      resumesAcrossChunks: false,
    };
    const res = await runCodeReview({ execution: EXEC, diff: bigDiff(3, 30) }, d, turn);
    expect(res.ok).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(resolveCount).toBe(1); // resolved once per review, not per chunk
    expect(calls.every((c) => c.resolvedModel === 'RESOLVED-X' && c.model === 'RESOLVED-X')).toBe(
      true,
    );
  });
});

describe('orchestrator — resumesAcrossChunks capability (chunked reviews)', () => {
  it('resumesAcrossChunks=true (Codex): chunks 2..N resume the prior chunk session', async () => {
    const { turn, calls } = makeCountingTurn(CANNED_CODE);
    const res = await runCodeReview(
      { execution: EXEC, diff: bigDiff(3, 30) },
      deps(false, { max_chunk_tokens: 2500 }, true),
      turn,
    );
    expect(res.ok).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0].sessionId).toBeUndefined(); // chunk 1 starts fresh
    expect(calls[1].sessionId).toBe('session-0'); // chunk 2 resumes chunk 1's session
    // Review id is the last threaded session (all one thread for real Codex).
    if (res.ok) expect(res.data.session_id).toBe(`session-${calls.length - 1}`);
  });

  it('resumesAcrossChunks=false (Gemini): chunks 2..N run independently; review id is chunk 1', async () => {
    const { turn, calls } = makeCountingTurn(CANNED_CODE);
    const res = await runCodeReview(
      { execution: EXEC, diff: bigDiff(3, 30) },
      deps(true, { max_chunk_tokens: 2500 }, false),
      turn,
    );
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
      { execution: EXEC, diff: bigDiff(3, 30), session_id: 'prior-phase' },
      deps(true, { max_chunk_tokens: 2500 }, false),
      turn,
    );
    expect(res.ok).toBe(true);
    expect(calls[0].sessionId).toBe('prior-phase'); // cross-phase resume on chunk 1 only
    expect(calls.slice(1).every((c) => c.sessionId === undefined)).toBe(true);
    if (res.ok) expect(res.data.session_id).toBe('session-0'); // chunk 1's fresh id
  });
});

describe('orchestrator — runCrossReview (deliberate-deep)', () => {
  const CANNED_CROSS = { adjudications: [{ index: 0, verdict: 'confirmed', reason: 'real' }] };
  const finding = {
    severity: 'major',
    category: 'bugs',
    file: 'a.ts',
    line: 5,
    description: 'off-by-one',
  };

  it('runs a single turn and returns adjudications with the session_id stripped', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_CROSS);
    const res = await runCrossReview(
      { execution: EXEC, content: SMALL_DIFF, findings: [finding] },
      deps(false),
      turn,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject(CANNED_CROSS);
    expect(res.data.models).toEqual([
      {
        provider: 'codex',
        role: 'adjudication',
        requested: null,
        resolved: 'default-model',
        observed: null,
        evidence: 'bridge_selection',
      },
    ]);
    expect(res.data).not.toHaveProperty('session_id'); // cross-review is stateless — no thread leaks out
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain('off-by-one'); // the finding reached the prompt
    expect(calls[0].prompt).toContain(SMALL_DIFF); // against the real change
  });

  it('forwards an explicit model pin to the turn', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_CROSS);
    await runCrossReview(
      { execution: EXEC, content: 'x', findings: [finding], model: 'gpt-5.5' },
      deps(false),
      turn,
    );
    expect(calls[0].model).toBe('gpt-5.5');
  });

  it('resolves the model quietly — no stderr narration even for an unpinned request', async () => {
    const { turn } = makeFakeTurn(CANNED_CROSS);
    await runCrossReview({ execution: EXEC, content: 'x', findings: [finding] }, deps(false), turn);
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});

describe('orchestrator — evidence-aware model identity', () => {
  it('reports selected and runtime-observed identity for a fresh Codex review', async () => {
    const { turn } = makeFakeTurn(CANNED_PLAN);
    const d = deps(false);
    d.observeSessionModel = vi.fn().mockResolvedValue('gpt-5.6-sol');
    const res = await runPlanReview({ execution: EXEC, plan: 'x' }, d, turn);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.models).toEqual([
      {
        provider: 'codex',
        role: 'review',
        requested: null,
        resolved: 'default-model',
        observed: 'gpt-5.6-sol',
        evidence: 'runtime_session_record',
      },
    ]);
  });

  it('reports Gemini bridge selection without claiming runtime observation', async () => {
    const { turn } = makeFakeTurn(CANNED_PLAN);
    const d = deps(true);
    d.provider = 'gemini';
    const res = await runPlanReview(
      { execution: EXEC, plan: 'x', model: 'Gemini 3.5 Flash (High)' },
      d,
      turn,
    );
    expect(res.ok && res.data.models).toEqual([
      {
        provider: 'gemini',
        role: 'review',
        requested: 'Gemini 3.5 Flash (High)',
        resolved: 'Gemini 3.5 Flash (High)',
        observed: null,
        evidence: 'bridge_selection',
      },
    ]);
  });

  it('returns both identities and warns once when observation differs from selection', async () => {
    const { turn } = makeFakeTurn(CANNED_PLAN);
    const d = deps(false);
    d.observeSessionModel = vi.fn().mockResolvedValue('gpt-5.5');
    const res = await runPlanReview({ execution: EXEC, plan: 'x', model: 'gpt-5.6-sol' }, d, turn);
    expect(res.ok && res.data.models?.[0]).toMatchObject({
      resolved: 'gpt-5.6-sol',
      observed: 'gpt-5.5',
    });
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('model identity mismatch'));
  });

  it('observes once after the final successful chunk', async () => {
    const { turn } = makeCountingTurn(CANNED_CODE);
    const d = deps(false, { max_chunk_tokens: 2500 }, true);
    d.observeSessionModel = vi.fn().mockResolvedValue('gpt-5.6-sol');
    const res = await runCodeReview({ execution: EXEC, diff: bigDiff(3, 30) }, d, turn);
    expect(res.ok).toBe(true);
    expect(d.observeSessionModel).toHaveBeenCalledTimes(1);
    expect(res.ok && res.data.models).toHaveLength(1);
  });

  it('emits empty model arrays for synthetic code and precommit results', async () => {
    const { turn, calls } = makeFakeTurn(CANNED_CODE);
    const d = deps(false);
    const code = await runCodeReview({ execution: EXEC, diff: '' }, d, turn);
    const precommit = await runPrecommitReview({ execution: EXEC, diff: '' }, d, turn);
    expect(code.ok && code.data.models).toEqual([]);
    expect(precommit.ok && precommit.data.models).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// Direct units for the merge helpers. They're the same key/severity logic that
// deliberation.computeAgreement mirrors, but were only exercised through the
// chunk loop — so their edge cases (severity precedence, keyless preservation,
// verdict precedence, cross-chunk AND, string dedup) had no direct coverage.
describe('merge helpers', () => {
  const cf = (
    file: string | null,
    line: number | null,
    category: string,
    severity: 'critical' | 'major' | 'minor' | 'nitpick',
  ) => ({
    severity,
    category,
    description: `${category} issue`,
    file,
    line,
    suggestion: null,
  });

  describe('deduplicateFindings', () => {
    it('collapses same file:line:category to the higher-severity finding', () => {
      const out = deduplicateFindings([
        cf('a.ts', 1, 'bugs', 'minor'),
        cf('a.ts', 1, 'bugs', 'critical'),
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('critical');
    });

    it('keeps distinct keys separate', () => {
      const out = deduplicateFindings([
        cf('a.ts', 1, 'bugs', 'major'),
        cf('a.ts', 2, 'bugs', 'major'),
      ]);
      expect(out).toHaveLength(2);
    });

    it('preserves keyless findings (null file or line) without deduping them', () => {
      const out = deduplicateFindings([
        cf(null, null, 'style', 'minor'),
        cf(null, null, 'style', 'minor'),
      ]);
      expect(out).toHaveLength(2); // keyless can't be matched → both kept
    });
  });

  describe('mergeCodeResults', () => {
    const cr = (
      verdict: 'approve' | 'request_changes' | 'reject',
      summary: string,
      findings: ReturnType<typeof cf>[],
    ) => ({ verdict, summary, findings, session_id: 's' });

    it('takes the worst verdict (approve < request_changes < reject)', () => {
      const merged = mergeCodeResults(
        [cr('approve', 'a', []), cr('reject', 'b', []), cr('request_changes', 'c', [])],
        'sid',
      );
      expect(merged.verdict).toBe('reject');
    });

    it('joins summaries, dedups findings across chunks, and records chunks_reviewed', () => {
      const merged = mergeCodeResults(
        [
          cr('approve', 'first.', [cf('a.ts', 1, 'bugs', 'minor')]),
          cr('approve', 'second.', [cf('a.ts', 1, 'bugs', 'critical')]),
        ],
        'sid',
      );
      expect(merged.summary).toBe('first. second.');
      expect(merged.findings).toHaveLength(1); // same key → deduped
      expect(merged.findings[0].severity).toBe('critical'); // higher severity wins
      expect(merged.chunks_reviewed).toBe(2);
      expect(merged.session_id).toBe('sid');
    });
  });

  describe('mergePrecommitResults', () => {
    const pr = (ready: boolean, blockers: string[], warnings: string[]) => ({
      ready_to_commit: ready,
      blockers,
      warnings,
      session_id: 's',
    });

    it('is ready_to_commit only when EVERY chunk is ready (AND across chunks)', () => {
      expect(
        mergePrecommitResults([pr(true, [], []), pr(true, [], [])], 'sid').ready_to_commit,
      ).toBe(true);
      expect(
        mergePrecommitResults([pr(true, [], []), pr(false, ['x'], [])], 'sid').ready_to_commit,
      ).toBe(false);
    });

    it('dedupes identical blockers/warnings across chunks, preserving first-seen order', () => {
      const merged = mergePrecommitResults(
        [
          pr(false, ['secret in config', 'debug log'], ['slow test']),
          pr(false, ['secret in config'], ['slow test', 'todo left']),
        ],
        'sid',
      );
      expect(merged.blockers).toEqual(['secret in config', 'debug log']); // 'secret in config' not repeated
      expect(merged.warnings).toEqual(['slow test', 'todo left']);
      expect(merged.chunks_reviewed).toBe(2);
    });
  });

  // ISS-019: OpenAI structured outputs reject any schema whose `required` omits a
  // property — and that rejection only fires against a live provider, never against
  // the mocked SDK in unit tests. review_mode (an optional field the backend stamps
  // itself) leaked into the model-facing response schemas and broke every live Codex
  // review. This locks the whole category, recursively, so any future optional field
  // that leaks into a model-facing schema fails here instead of in production.
  describe('model-facing response schemas — required covers all properties (ISS-019)', () => {
    // Every object node in the JSON Schema must list every one of its properties in
    // `required`. Descend into properties, array items, and anyOf/allOf/oneOf branches.
    const assertRequiredCoversProps = (node: unknown, path: string): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      if (n.type === 'object' && n.properties && typeof n.properties === 'object') {
        const props = Object.keys(n.properties as Record<string, unknown>);
        const required = Array.isArray(n.required) ? (n.required as string[]) : [];
        expect(new Set(required), `${path}: required must cover every property`).toEqual(
          new Set(props),
        );
        for (const [k, v] of Object.entries(n.properties as Record<string, unknown>)) {
          assertRequiredCoversProps(v, `${path}.${k}`);
        }
      }
      if (n.items) assertRequiredCoversProps(n.items, `${path}[]`);
      for (const key of ['anyOf', 'allOf', 'oneOf'] as const) {
        if (Array.isArray(n[key])) {
          (n[key] as unknown[]).forEach((child, idx) =>
            assertRequiredCoversProps(child, `${path}.${key}[${idx}]`),
          );
        }
      }
    };

    for (const [name, schema] of Object.entries(RESPONSE_SCHEMAS)) {
      it(`${name} response schema: every property is required at every level`, () => {
        const json = toJSONSchema(schema) as { properties?: Record<string, unknown> };
        expect(json.properties).not.toHaveProperty('models');
        expect(json.properties).not.toHaveProperty('provenance');
        assertRequiredCoversProps(json, name);
      });
    }
  });
});

// ISS-028 + ISS-019: capture location is host knowledge stamped at the response
// boundary. Leaving it in a model-facing schema would both let a reviewer forge
// it and make toJSONSchema emit a non-required property, which OpenAI structured
// outputs reject outright.
describe('capture metadata is never model-facing (ISS-028)', () => {
  it('omits captured_from from the code and precommit response schemas', () => {
    expect(Object.keys(RESPONSE_SCHEMAS.code.shape)).not.toContain('captured_from');
    expect(Object.keys(RESPONSE_SCHEMAS.precommit.shape)).not.toContain('captured_from');
  });

  it('drops a captured_from a model tried to emit', () => {
    const forged = {
      verdict: 'approve',
      summary: 'ok',
      findings: [],
      captured_from: '/forged/by/model',
    };
    const parsed = RESPONSE_SCHEMAS.code.parse(forged);
    expect(parsed).not.toHaveProperty('captured_from');
  });
});
