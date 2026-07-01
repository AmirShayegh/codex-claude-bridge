import { describe, it, expect, vi } from 'vitest';
import { createDeliberationBackend, computeAgreement } from './deliberation.js';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { ReviewBackend } from './backend.js';
import type { ReviewProvider } from '../config/types.js';

type Methods = Partial<Pick<ReviewBackend, 'reviewPlan' | 'reviewCode' | 'reviewPrecommit'>>;
function backend(provider: ReviewProvider, methods: Methods = {}): ReviewBackend {
  return {
    provider,
    allowsModelOverrideOnResume: provider === 'gemini',
    reviewPlan: methods.reviewPlan ?? vi.fn(),
    reviewCode: methods.reviewCode ?? vi.fn(),
    reviewPrecommit: methods.reviewPrecommit ?? vi.fn(),
  };
}

// Code-severity rank for the direct computeAgreement test.
const rank = (s: string): number => ({ critical: 3, major: 2, minor: 1, nitpick: 0 })[s] ?? -1;
const f = (file: string | null, line: number | null, category: string, severity: string) => ({
  severity,
  category,
  file,
  line,
  description: `${category} finding`,
  suggestion: null,
});

const codeResult = (verdict: string, findings: ReturnType<typeof f>[], session_id = 'sid') => ({
  verdict,
  summary: `${verdict} summary`,
  findings,
  session_id,
});
const DIFF = 'diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b';

describe('computeAgreement', () => {
  it('splits findings into agreed (both flagged) and divergent (one flagged / keyless)', () => {
    const a = { provider: 'codex' as const, findings: [f('a.ts', 1, 'security', 'major'), f(null, null, 'style', 'minor')] };
    const b = { provider: 'gemini' as const, findings: [f('a.ts', 1, 'security', 'critical'), f('b.ts', 2, 'perf', 'major')] };

    const { agreed, divergent } = computeAgreement(a, b, rank);

    // a.ts:1:security flagged by both → agreed, keeping the higher-severity (gemini's critical).
    expect(agreed).toHaveLength(1);
    expect(agreed[0].severity).toBe('critical');
    // keyless style (codex) + b.ts:2:perf (gemini) → divergent.
    expect(divergent).toHaveLength(2);
    expect(divergent.map((d) => d.provider).sort()).toEqual(['codex', 'gemini']);
  });

  it('keeps the higher-severity finding when one provider reports the same key twice', () => {
    // Surfaced by deliberating on this feature's own code: same-key dupes from one
    // provider must collapse to the higher severity, not the last-seen.
    const { agreed, divergent } = computeAgreement(
      { provider: 'codex', findings: [f('a.ts', 1, 'security', 'minor'), f('a.ts', 1, 'security', 'critical')] },
      { provider: 'gemini', findings: [] },
      rank,
    );
    expect(agreed).toHaveLength(0); // only one provider flagged it
    expect(divergent).toHaveLength(1); // collapsed to a single finding
    expect(divergent[0].finding.severity).toBe('critical');
  });

  it('all-agreed when every finding shares a key', () => {
    const shared = [f('x.ts', 3, 'bugs', 'major')];
    const { agreed, divergent } = computeAgreement(
      { provider: 'codex', findings: shared },
      { provider: 'gemini', findings: [f('x.ts', 3, 'bugs', 'minor')] },
      rank,
    );
    expect(agreed).toHaveLength(1);
    expect(divergent).toHaveLength(0);
  });
});

describe('createDeliberationBackend', () => {
  it('both agree → agreement "agree", agreed populated, divergent empty, verdicts per provider', async () => {
    const shared = [f('a.ts', 1, 'security', 'major')];
    const primary = backend('codex', { reviewCode: vi.fn().mockResolvedValue(ok(codeResult('approve', shared, 'cdx'))) });
    const secondary = backend('gemini', {
      reviewCode: vi.fn().mockResolvedValue(ok(codeResult('approve', [f('a.ts', 1, 'security', 'major')], 'gem'))),
    });

    const res = await createDeliberationBackend(primary, secondary).reviewCode({ diff: DIFF });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.deliberation?.agreement).toBe('agree');
      expect(res.data.deliberation?.agreed).toHaveLength(1);
      expect(res.data.deliberation?.divergent).toHaveLength(0);
      expect(res.data.deliberation?.providers).toEqual(['codex', 'gemini']);
      expect(res.data.deliberation?.verdicts).toHaveLength(2);
      expect(res.data.session_id).toBe('cdx'); // primary's
      expect(res.data.provider).toBe('codex');
      expect(res.data).not.toHaveProperty('chunks_reviewed'); // not a misleading "2"
    }
  });

  it('partial overlap → agreement "mixed", one-sided findings are divergent', async () => {
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(ok(codeResult('request_changes', [f('a.ts', 1, 'security', 'critical'), f('a.ts', 5, 'bugs', 'major')]))),
    });
    const secondary = backend('gemini', {
      reviewCode: vi.fn().mockResolvedValue(ok(codeResult('request_changes', [f('a.ts', 1, 'security', 'critical'), f('b.ts', 2, 'perf', 'minor')]))),
    });

    const res = await createDeliberationBackend(primary, secondary).reviewCode({ diff: DIFF });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.deliberation?.agreement).toBe('mixed');
      expect(res.data.deliberation?.agreed).toHaveLength(1); // a.ts:1:security
      expect(res.data.deliberation?.divergent).toHaveLength(2); // codex bugs + gemini perf
      // Top-level findings = deduped union of agreed + divergent.
      expect(res.data.findings).toHaveLength(3);
    }
  });

  it('conflicting verdicts → agreement "conflict"; top-level verdict is the worst', async () => {
    const primary = backend('codex', { reviewCode: vi.fn().mockResolvedValue(ok(codeResult('approve', []))) });
    const secondary = backend('gemini', { reviewCode: vi.fn().mockResolvedValue(ok(codeResult('reject', []))) });

    const res = await createDeliberationBackend(primary, secondary).reviewCode({ diff: DIFF });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.deliberation?.agreement).toBe('conflict');
      expect(res.data.verdict).toBe('reject'); // worst of approve/reject
    }
  });

  it('runs both providers in parallel (both review methods called once)', async () => {
    const pReview = vi.fn().mockResolvedValue(ok(codeResult('approve', [])));
    const sReview = vi.fn().mockResolvedValue(ok(codeResult('approve', [])));
    await createDeliberationBackend(backend('codex', { reviewCode: pReview }), backend('gemini', { reviewCode: sReview })).reviewCode({ diff: DIFF });
    expect(pReview).toHaveBeenCalledOnce();
    expect(sReview).toHaveBeenCalledOnce();
    expect(sReview).toHaveBeenCalledWith(expect.objectContaining({ model: undefined })); // secondary model cleared
  });

  it('degrades to the survivor + a `degraded` marker when one provider fails', async () => {
    const primary = backend('codex', { reviewCode: vi.fn().mockResolvedValue(err(`${ErrorCode.RATE_LIMITED}: out of usage`)) });
    const secondary = backend('gemini', { reviewCode: vi.fn().mockResolvedValue(ok(codeResult('reject', [f('a.ts', 1, 'security', 'critical')], 'gem'))) });

    const res = await createDeliberationBackend(primary, secondary).reviewCode({ diff: DIFF });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.provider).toBe('gemini'); // survivor
      expect(res.data.verdict).toBe('reject');
      expect(res.data.deliberation?.degraded).toEqual({ failed: 'codex', reason: expect.stringContaining('RATE_LIMITED') });
      expect(res.data.deliberation?.providers).toEqual(['gemini']);
    }
  });

  it('returns a combined error when both providers fail', async () => {
    const primary = backend('codex', { reviewCode: vi.fn().mockResolvedValue(err(`${ErrorCode.RATE_LIMITED}: usage`)) });
    const secondary = backend('gemini', { reviewCode: vi.fn().mockResolvedValue(err(`${ErrorCode.AUTH_ERROR}: not signed in`)) });

    const res = await createDeliberationBackend(primary, secondary).reviewCode({ diff: DIFF });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.startsWith(`${ErrorCode.RATE_LIMITED}:`)).toBe(true);
      expect(res.error).toContain('gemini also failed');
    }
  });

  it('a resumed session does NOT deliberate (delegates to the primary, no deliberation block)', async () => {
    const sReview = vi.fn();
    const primary = backend('codex', { reviewCode: vi.fn().mockResolvedValue(ok(codeResult('approve', []))) });
    const res = await createDeliberationBackend(primary, backend('gemini', { reviewCode: sReview })).reviewCode({
      diff: DIFF,
      session_id: 'codex-sess',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.deliberation).toBeUndefined();
    expect(sReview).not.toHaveBeenCalled(); // no parallel second review on resume
  });

  it('reviewPrecommit uses failover, not deliberation', async () => {
    const pre = { ready_to_commit: true, blockers: [], warnings: [], session_id: 'p' };
    const sPre = vi.fn();
    const primary = backend('codex', { reviewPrecommit: vi.fn().mockResolvedValue(ok(pre)) });
    const res = await createDeliberationBackend(primary, backend('gemini', { reviewPrecommit: sPre })).reviewPrecommit({ diff: DIFF });
    expect(res.ok).toBe(true);
    expect(sPre).not.toHaveBeenCalled(); // primary succeeded → no second call (failover semantics)
  });

  it('reviewPlan deliberates too', async () => {
    const planA = { verdict: 'revise', summary: 's', findings: [f('p.ts', 1, 'feasibility', 'major')], session_id: 'a' };
    const planB = { verdict: 'approve', summary: 's', findings: [], session_id: 'b' };
    const res = await createDeliberationBackend(
      backend('codex', { reviewPlan: vi.fn().mockResolvedValue(ok(planA)) }),
      backend('gemini', { reviewPlan: vi.fn().mockResolvedValue(ok(planB)) }),
    ).reviewPlan({ plan: 'do a thing' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.verdict).toBe('revise'); // worst of revise/approve
      expect(res.data.deliberation?.agreement).toBe('conflict'); // verdicts differ
      expect(res.data.deliberation?.divergent).toHaveLength(1);
    }
  });
});
