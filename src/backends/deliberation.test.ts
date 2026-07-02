import { describe, it, expect, vi } from 'vitest';
import { createDeliberationBackend, computeAgreement } from './deliberation.js';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { ReviewBackend } from './backend.js';
import type { ReviewProvider } from '../config/types.js';

type Methods = Partial<
  Pick<ReviewBackend, 'reviewPlan' | 'reviewCode' | 'reviewPrecommit' | 'crossReview'>
>;
function backend(provider: ReviewProvider, methods: Methods = {}): ReviewBackend {
  return {
    provider,
    providers: [provider],
    allowsModelOverrideOnResume: provider === 'gemini',
    reviewPlan: methods.reviewPlan ?? vi.fn(),
    reviewCode: methods.reviewCode ?? vi.fn(),
    reviewPrecommit: methods.reviewPrecommit ?? vi.fn(),
    ...(methods.crossReview ? { crossReview: methods.crossReview } : {}),
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
      // ISS-016: a single-provider degraded result must NOT claim 'agree'.
      expect(res.data.deliberation?.agreement).toBe('degraded');
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

  it('deliberates on resume: the owning leaf resumes, the other reviews fresh (ISS-010)', async () => {
    // No lookup → owner defaults to the primary (codex). Primary resumes its
    // session; secondary reviews fresh (session_id stripped). Both run → the
    // resumed review now DELIBERATES instead of silently going single-provider.
    const pReview = vi.fn().mockResolvedValue(ok(codeResult('approve', [], 'codex-sess')));
    const sReview = vi.fn().mockResolvedValue(ok(codeResult('approve', [], 'gem-fresh')));
    const primary = backend('codex', { reviewCode: pReview });
    const secondary = backend('gemini', { reviewCode: sReview });

    const res = await createDeliberationBackend(primary, secondary).reviewCode({
      diff: DIFF,
      session_id: 'codex-sess',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.deliberation).toBeDefined();
    expect(res.data.deliberation?.providers).toEqual(['codex', 'gemini']);
    expect(pReview).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'codex-sess' })); // owner resumes
    expect(sReview).toHaveBeenCalledWith(expect.objectContaining({ session_id: undefined })); // other fresh
    expect(res.data.session_id).toBe('codex-sess'); // combined keeps the resumed owner session
  });

  it('deliberate-on-resume routes the OWNING (secondary) leaf to resume + primary fresh (ISS-011)', async () => {
    // A prior review degraded to gemini; resuming that session must resume on
    // gemini (the owner) while codex reviews fresh — and the combined result keeps
    // the resumed gemini session id, not a fresh one.
    const pReview = vi.fn().mockResolvedValue(ok(codeResult('approve', [], 'cdx-fresh')));
    const sReview = vi.fn().mockResolvedValue(ok(codeResult('approve', [], 'gemini-sess')));
    const primary = backend('codex', { reviewCode: pReview });
    const secondary = backend('gemini', { reviewCode: sReview });
    const lookup = vi.fn().mockReturnValue('gemini');

    const res = await createDeliberationBackend(primary, secondary, { lookup }).reviewCode({
      diff: DIFF,
      session_id: 'gemini-sess',
    });

    expect(lookup).toHaveBeenCalledWith('gemini-sess');
    expect(sReview).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'gemini-sess' })); // owner resumes
    expect(pReview).toHaveBeenCalledWith(expect.objectContaining({ session_id: undefined })); // primary fresh
    expect(res.ok && res.data.provider).toBe('codex'); // composite presents as primary
    expect(res.ok && res.data.session_id).toBe('gemini-sess'); // combined = resumed owner session
    expect(res.ok && res.data.deliberation).toBeDefined();
  });

  it('deliberate-on-resume: if the owner fails, degrade to the fresh other leaf with its NEW session id', async () => {
    // No lookup → owner is primary (codex). Its resume fails; the fresh secondary
    // survives. The degraded result carries the secondary's NEW session id — the
    // old (owner) session couldn't be served this round.
    const pReview = vi.fn().mockResolvedValue(err(`${ErrorCode.RATE_LIMITED}: out of usage`));
    const sReview = vi.fn().mockResolvedValue(ok(codeResult('approve', [], 'gem-fresh')));
    const primary = backend('codex', { reviewCode: pReview });
    const secondary = backend('gemini', { reviewCode: sReview });

    const res = await createDeliberationBackend(primary, secondary).reviewCode({ diff: DIFF, session_id: 'codex-sess' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.provider).toBe('gemini'); // survivor
    expect(res.data.session_id).toBe('gem-fresh'); // fresh NEW session, not the dead 'codex-sess'
    expect(res.data.deliberation?.degraded).toEqual({ failed: 'codex', reason: expect.stringContaining('RATE_LIMITED') });
    expect(res.data.deliberation?.agreement).toBe('degraded');
  });

  it('deliberate-on-resume: both legs fail → error leads with the PRIMARY error, names the secondary', async () => {
    // Owner is the secondary (gemini) via lookup; both fail. The combined error
    // must still be primary-led and name gemini as the "also failed" side — not
    // swap them by owner/other order.
    const primary = backend('codex', { reviewCode: vi.fn().mockResolvedValue(err(`${ErrorCode.AUTH_ERROR}: codex not signed in`)) });
    const secondary = backend('gemini', { reviewCode: vi.fn().mockResolvedValue(err(`${ErrorCode.RATE_LIMITED}: gemini out of usage`)) });
    const lookup = vi.fn().mockReturnValue('gemini');

    const res = await createDeliberationBackend(primary, secondary, { lookup }).reviewCode({ diff: DIFF, session_id: 'gemini-sess' });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('AUTH_ERROR'); // primary (codex) error leads
      expect(res.error).toContain('gemini also failed'); // secondary named correctly
      expect(res.error).toContain('RATE_LIMITED');
    }
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

// A mixed code review where each provider flags one one-sided (divergent) finding:
//   divergent[0] = codex's a.ts:5:bugs  (judged by the gemini secondary)
//   divergent[1] = gemini's b.ts:2:perf (judged by the codex primary)
const cross = (verdict: string, reason: string) => ({ adjudications: [{ index: 0, verdict, reason }] });
function mixedPair(pMethods: Methods = {}, sMethods: Methods = {}) {
  const primary = backend('codex', {
    reviewCode: vi.fn().mockResolvedValue(ok(codeResult('request_changes', [f('a.ts', 1, 'security', 'critical'), f('a.ts', 5, 'bugs', 'major')]))),
    ...pMethods,
  });
  const secondary = backend('gemini', {
    reviewCode: vi.fn().mockResolvedValue(ok(codeResult('request_changes', [f('a.ts', 1, 'security', 'critical'), f('b.ts', 2, 'perf', 'minor')]))),
    ...sMethods,
  });
  return { primary, secondary };
}

describe('createDeliberationBackend — deliberate-deep (cross-review round)', () => {
  it('adjudicates each provider\'s divergent findings with the OTHER provider', async () => {
    const secReview = vi.fn().mockResolvedValue(ok(cross('confirmed', 'yes real'))); // gemini judges codex's finding
    const priReview = vi.fn().mockResolvedValue(ok(cross('disputed', 'false positive'))); // codex judges gemini's finding
    const { primary, secondary } = mixedPair({ crossReview: priReview }, { crossReview: secReview });

    const res = await createDeliberationBackend(primary, secondary, { crossReview: true }).reviewCode({ diff: DIFF });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const div = res.data.deliberation?.divergent ?? [];
    expect(div).toHaveLength(2);
    // codex's divergent finding, adjudicated by gemini.
    expect(div[0].provider).toBe('codex');
    expect(div[0].adjudication).toEqual({ by: 'gemini', verdict: 'confirmed', reason: 'yes real' });
    // gemini's divergent finding, adjudicated by codex.
    expect(div[1].provider).toBe('gemini');
    expect(div[1].adjudication).toEqual({ by: 'codex', verdict: 'disputed', reason: 'false positive' });
    // Each judge saw the diff and only the OTHER provider's one finding.
    expect(secReview).toHaveBeenCalledWith(expect.objectContaining({ content: DIFF, findings: [expect.objectContaining({ file: 'a.ts', line: 5 })] }));
    expect(priReview).toHaveBeenCalledWith(expect.objectContaining({ content: DIFF, findings: [expect.objectContaining({ file: 'b.ts', line: 2 })] }));
  });

  it('ISS-014: forwards the caller model to the PRIMARY judge only', async () => {
    const secReview = vi.fn().mockResolvedValue(ok(cross('confirmed', 'r'))); // gemini judge
    const priReview = vi.fn().mockResolvedValue(ok(cross('disputed', 'r'))); // codex judge
    const { primary, secondary } = mixedPair({ crossReview: priReview }, { crossReview: secReview });

    await createDeliberationBackend(primary, secondary, { crossReview: true }).reviewCode({ diff: DIFF, model: 'gpt-5.4' });

    // codex is the primary → its adjudication turn gets the override; gemini resolves its own default.
    expect(priReview).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.4' }));
    expect(secReview).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
  });

  it('ISS-012: slices the cross-review subject to the files each finding touches', async () => {
    const twoFile =
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+A\n' +
      'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-b\n+B';
    const secReview = vi.fn().mockResolvedValue(ok(cross('confirmed', 'r'))); // judges codex's a.ts finding
    const priReview = vi.fn().mockResolvedValue(ok(cross('disputed', 'r'))); // judges gemini's b.ts finding
    const { primary, secondary } = mixedPair({ crossReview: priReview }, { crossReview: secReview });

    await createDeliberationBackend(primary, secondary, { crossReview: true }).reviewCode({ diff: twoFile });

    // gemini judges the a.ts finding → subject sliced to the a.ts section only.
    const secArg = secReview.mock.calls[0][0];
    expect(secArg.content).toContain('a/a.ts');
    expect(secArg.content).not.toContain('b/b.ts');
    // codex judges the b.ts finding → subject sliced to the b.ts section only.
    const priArg = priReview.mock.calls[0][0];
    expect(priArg.content).toContain('a/b.ts');
    expect(priArg.content).not.toContain('a/a.ts');
  });

  it('ISS-012: an over-budget cross-review subject fails cleanly (cross_review_failures, no judge call)', async () => {
    const secReview = vi.fn().mockResolvedValue(ok(cross('confirmed', 'r')));
    const priReview = vi.fn().mockResolvedValue(ok(cross('disputed', 'r')));
    const { primary, secondary } = mixedPair({ crossReview: priReview }, { crossReview: secReview });

    // maxChunkTokens:1 → any subject blows the budget → both judges skipped.
    const res = await createDeliberationBackend(primary, secondary, { crossReview: true, maxChunkTokens: 1 }).reviewCode({ diff: DIFF });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(secReview).not.toHaveBeenCalled();
    expect(priReview).not.toHaveBeenCalled();
    const failures = res.data.deliberation?.cross_review_failures ?? [];
    expect(failures.map((x) => x.by).sort()).toEqual(['codex', 'gemini']);
    expect(failures[0].reason).toContain('max_chunk_tokens');
  });

  it('does not cross-review by default (plain deliberate leaves divergent un-adjudicated)', async () => {
    const secReview = vi.fn();
    const priReview = vi.fn();
    const { primary, secondary } = mixedPair({ crossReview: priReview }, { crossReview: secReview });

    const res = await createDeliberationBackend(primary, secondary).reviewCode({ diff: DIFF });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(secReview).not.toHaveBeenCalled();
    expect(priReview).not.toHaveBeenCalled();
    expect(res.data.deliberation?.divergent.every((d) => d.adjudication === undefined)).toBe(true);
  });

  it('is best-effort: a judge without crossReview leaves its side un-adjudicated', async () => {
    // secondary (gemini) has no crossReview → codex's divergent finding stays bare;
    // primary (codex) can still adjudicate gemini's finding.
    const priReview = vi.fn().mockResolvedValue(ok(cross('confirmed', 'real')));
    const { primary, secondary } = mixedPair({ crossReview: priReview }, {});

    const res = await createDeliberationBackend(primary, secondary, { crossReview: true }).reviewCode({ diff: DIFF });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const div = res.data.deliberation?.divergent ?? [];
    expect(div[0].adjudication).toBeUndefined(); // gemini couldn't judge
    expect(div[1].adjudication).toEqual({ by: 'codex', verdict: 'confirmed', reason: 'real' });
  });

  it('surfaces a failed crossReview call as cross_review_failures, not silently (ISS-012)', async () => {
    const secReview = vi.fn().mockResolvedValue(err(`${ErrorCode.RATE_LIMITED}: out of usage`));
    const priReview = vi.fn().mockResolvedValue(ok(cross('confirmed', 'real')));
    const { primary, secondary } = mixedPair({ crossReview: priReview }, { crossReview: secReview });

    const res = await createDeliberationBackend(primary, secondary, { crossReview: true }).reviewCode({ diff: DIFF });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const div = res.data.deliberation?.divergent ?? [];
    expect(div[0].adjudication).toBeUndefined(); // gemini's call failed → no adjudication
    expect(div[1].adjudication).toEqual({ by: 'codex', verdict: 'confirmed', reason: 'real' });
    // The failure is now visible, distinguishing "could not run" from "ran, found nothing".
    expect(res.data.deliberation?.cross_review_failures).toEqual([
      { by: 'gemini', reason: expect.stringContaining('RATE_LIMITED') },
    ]);
  });

  it('skips cross-review entirely when there are no divergent findings', async () => {
    const secReview = vi.fn();
    const priReview = vi.fn();
    const shared = [f('a.ts', 1, 'security', 'major')];
    const primary = backend('codex', { reviewCode: vi.fn().mockResolvedValue(ok(codeResult('approve', shared))), crossReview: priReview });
    const secondary = backend('gemini', { reviewCode: vi.fn().mockResolvedValue(ok(codeResult('approve', [f('a.ts', 1, 'security', 'major')]))), crossReview: secReview });

    const res = await createDeliberationBackend(primary, secondary, { crossReview: true }).reviewCode({ diff: DIFF });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.deliberation?.divergent).toHaveLength(0);
    expect(secReview).not.toHaveBeenCalled();
    expect(priReview).not.toHaveBeenCalled();
  });

  it('cross-reviews plan divergent findings against the plan text', async () => {
    const planA = { verdict: 'revise', summary: 's', findings: [f('p.ts', 1, 'feasibility', 'major')], session_id: 'a' };
    const planB = { verdict: 'revise', summary: 's', findings: [f('q.ts', 9, 'security', 'major')], session_id: 'b' };
    const secReview = vi.fn().mockResolvedValue(ok(cross('confirmed', 'agreed'))); // gemini judges codex's finding
    const priReview = vi.fn().mockResolvedValue(ok(cross('unsure', 'cannot tell'))); // codex judges gemini's finding
    const primary = backend('codex', { reviewPlan: vi.fn().mockResolvedValue(ok(planA)), crossReview: priReview });
    const secondary = backend('gemini', { reviewPlan: vi.fn().mockResolvedValue(ok(planB)), crossReview: secReview });

    const res = await createDeliberationBackend(primary, secondary, { crossReview: true }).reviewPlan({ plan: 'do a thing' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const div = res.data.deliberation?.divergent ?? [];
    expect(div).toHaveLength(2);
    expect(div[0].adjudication).toEqual({ by: 'gemini', verdict: 'confirmed', reason: 'agreed' });
    expect(div[1].adjudication).toEqual({ by: 'codex', verdict: 'unsure', reason: 'cannot tell' });
    expect(secReview).toHaveBeenCalledWith(expect.objectContaining({ content: 'do a thing' }));
  });

  it('ISS-014: a FRESH plan review also forwards the model to the primary judge only', async () => {
    // Regression: the fresh deliberatePlan path must thread input.model too.
    const planA = { verdict: 'revise', summary: 's', findings: [f('p.ts', 1, 'feasibility', 'major')], session_id: 'a' };
    const planB = { verdict: 'revise', summary: 's', findings: [f('q.ts', 9, 'security', 'major')], session_id: 'b' };
    const secReview = vi.fn().mockResolvedValue(ok(cross('confirmed', 'r'))); // gemini judge
    const priReview = vi.fn().mockResolvedValue(ok(cross('unsure', 'r'))); // codex judge
    const primary = backend('codex', { reviewPlan: vi.fn().mockResolvedValue(ok(planA)), crossReview: priReview });
    const secondary = backend('gemini', { reviewPlan: vi.fn().mockResolvedValue(ok(planB)), crossReview: secReview });

    await createDeliberationBackend(primary, secondary, { crossReview: true }).reviewPlan({ plan: 'do a thing', model: 'gpt-5.4' });

    expect(priReview).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.4' })); // primary judge gets it
    expect(secReview).toHaveBeenCalledWith(expect.objectContaining({ model: undefined })); // secondary resolves own
  });
});
