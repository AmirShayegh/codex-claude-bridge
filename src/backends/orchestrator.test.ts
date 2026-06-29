import { describe, it, expect } from 'vitest';
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

function deps(allowsModelOverrideOnResume: boolean, overrides: Partial<typeof DEFAULT_CONFIG> = {}): ReviewFlowDeps {
  return { config: { ...DEFAULT_CONFIG, ...overrides }, allowsModelOverrideOnResume, defaultModel: 'default-model' };
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
