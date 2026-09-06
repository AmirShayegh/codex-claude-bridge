import { describe, it, expect, vi } from 'vitest';
import { createDeliberationBackend, computeAgreement } from './deliberation.js';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { ReviewBackend } from './backend.js';
import type { ReviewProvider } from '../config/types.js';

// Every backend call now carries WHERE it runs (ISS-027). Tests that don't care
// about the directory share this one fixture; tests that do build their own.
const EXEC = { workingDirectory: '/work/repo-b' };

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
const model = (provider: ReviewProvider, role: 'review' | 'adjudication' = 'review') => ({
  provider,
  role,
  requested: null,
  resolved: provider === 'codex' ? 'gpt-5.6-sol' : 'Gemini 3.5 Flash (High)',
  observed: provider === 'codex' ? 'gpt-5.6-sol' : null,
  evidence:
    provider === 'codex' ? ('runtime_session_record' as const) : ('bridge_selection' as const),
});
const DIFF = 'diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b';
const REJECTED_PROVIDER_ERROR = `${ErrorCode.UNKNOWN_ERROR}: provider call failed unexpectedly`;
const PRIVATE_REJECTION = new Error(
  'provider exploded at /Users/alice/private/reviewer.ts\nsecret=super-secret',
);

describe('computeAgreement', () => {
  it('splits findings into agreed (both flagged) and divergent (one flagged / keyless)', () => {
    const a = {
      provider: 'codex' as const,
      findings: [f('a.ts', 1, 'security', 'major'), f(null, null, 'style', 'minor')],
    };
    const b = {
      provider: 'gemini' as const,
      findings: [f('a.ts', 1, 'security', 'critical'), f('b.ts', 2, 'perf', 'major')],
    };

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
      {
        provider: 'codex',
        findings: [f('a.ts', 1, 'security', 'minor'), f('a.ts', 1, 'security', 'critical')],
      },
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

  // ISS-013: the tests below use REAL cross-provider finding pairs captured from 3
  // live deliberate-deep runs on the N-001 planted-bug diff (note N-002). Exact-key
  // matching left agreed[] empty on all of them; semantic matching must merge them.
  const norm = (c: string): string => c.trim().toLowerCase().replace(/\s+/g, ' ').replace(/s$/, '');

  it('merges the same defect when providers use different category vocab on the same line', () => {
    // run3 assignment bug: codex "Incorrect logic" @12, gemini "bug" @12 (Δ0).
    const { agreed, divergent } = computeAgreement(
      { provider: 'codex', findings: [f('payment.js', 12, 'Incorrect logic', 'major')] },
      { provider: 'gemini', findings: [f('payment.js', 12, 'bug', 'critical')] },
      rank,
    );
    expect(agreed).toHaveLength(1);
    expect(agreed[0].severity).toBe('critical'); // higher-severity representative
    expect(divergent).toHaveLength(0);
  });

  it('merges same-category findings across the observed line drift (Δ2)', () => {
    // run2 assignment bug: codex "bugs" @10, gemini "Bug" @12 → normalized "bug" == "bug", Δ2 ≤ 2.
    const { agreed, divergent } = computeAgreement(
      { provider: 'codex', findings: [f('payment.js', 10, 'bugs', 'major')] },
      { provider: 'gemini', findings: [f('payment.js', 12, 'Bug', 'critical')] },
      rank,
    );
    expect(agreed).toHaveLength(1);
    expect(agreed[0].severity).toBe('critical');
    expect(divergent).toHaveLength(0);
  });

  it('disambiguates a same-line cluster by category preference, not by proximity alone', () => {
    // run2/run4 cluster: codex flags BOTH security + error-handling at L17, gemini flags
    // only security at L17. The SQL finding must pair with the SQL finding (category
    // preference), leaving codex error-handling divergent — never a cross-mispair.
    const { agreed, divergent } = computeAgreement(
      {
        provider: 'codex',
        findings: [
          f('payment.js', 17, 'security', 'critical'),
          f('payment.js', 17, 'error handling', 'major'),
        ],
      },
      { provider: 'gemini', findings: [f('payment.js', 17, 'Security', 'critical')] },
      rank,
    );
    expect(agreed).toHaveLength(1);
    expect(norm(agreed[0].category)).toBe('security'); // SQL paired with SQL, not error-handling
    expect(divergent).toHaveLength(1);
    expect(divergent[0].provider).toBe('codex');
    expect(norm(divergent[0].finding.category)).toBe('error handling');
  });

  it('merges both defects of a cluster when both providers flag both (no cross-mismatch)', () => {
    // run3 cluster: both providers flag SQL and error-handling at L17. Category-preference
    // pairs error-handling↔error-handling first, leaving injection↔security to pair.
    const { agreed, divergent } = computeAgreement(
      {
        provider: 'codex',
        findings: [
          f('payment.js', 17, 'Injection vulnerabilities', 'critical'),
          f('payment.js', 17, 'Error handling', 'major'),
        ],
      },
      {
        provider: 'gemini',
        findings: [
          f('payment.js', 17, 'security', 'critical'),
          f('payment.js', 17, 'error handling', 'major'),
        ],
      },
      rank,
    );
    expect(agreed).toHaveLength(2);
    expect(divergent).toHaveLength(0);
    // Both defects present and correctly paired — one error-handling, one SQL/injection —
    // i.e. no cross-mismatch (SQL did not pair with error-handling). Representatives keep
    // codex's copy on the severity ties, so norm() of the injection category ends "...ie"
    // (the normalizer strips a single trailing 's').
    expect(agreed.map((x) => norm(x.category)).sort()).toEqual([
      'error handling',
      norm('Injection vulnerabilities'),
    ]);
  });

  it('does NOT merge distinct defects that are more than the window apart (acceptance c)', () => {
    // assignment bug @12 vs SQL injection @17 (Δ5): different defects, must stay divergent.
    const { agreed, divergent } = computeAgreement(
      { provider: 'codex', findings: [f('payment.js', 12, 'bugs', 'major')] },
      { provider: 'gemini', findings: [f('payment.js', 17, 'Security', 'critical')] },
      rank,
    );
    expect(agreed).toHaveLength(0);
    expect(divergent).toHaveLength(2);
  });

  it('does NOT merge different-category findings within the window unless on the exact same line', () => {
    // assignment "bugs" @12 vs validation "Null safety" @14 (Δ2, different category):
    // a different-category match is only trusted at Δ0, so these stay divergent — guards
    // against false-merging distinct nearby defects and silently discarding one.
    const { agreed, divergent } = computeAgreement(
      { provider: 'codex', findings: [f('payment.js', 12, 'bugs', 'major')] },
      { provider: 'gemini', findings: [f('payment.js', 14, 'Null safety', 'major')] },
      rank,
    );
    expect(agreed).toHaveLength(0);
    expect(divergent).toHaveLength(2);
  });

  it('keeps keyless findings (null file/line) divergent even with identical category', () => {
    const { agreed, divergent } = computeAgreement(
      { provider: 'codex', findings: [f(null, null, 'bugs', 'major')] },
      { provider: 'gemini', findings: [f(null, null, 'bugs', 'major')] },
      rank,
    );
    expect(agreed).toHaveLength(0);
    expect(divergent).toHaveLength(2);
  });
});

describe('createDeliberationBackend', () => {
  it('orders and preserves both successful reviewer model identities', async () => {
    const primaryResult = { ...codeResult('approve', [], 'cdx'), models: [model('codex')] };
    const secondaryResult = { ...codeResult('approve', [], 'gem'), models: [model('gemini')] };
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(ok(primaryResult)),
    });
    const secondary = backend('gemini', {
      reviewCode: vi.fn().mockResolvedValue(ok(secondaryResult)),
    });

    const res = await createDeliberationBackend(primary, secondary).reviewCode({
      execution: EXEC,
      diff: DIFF,
    });

    expect(res.ok && res.data.models).toEqual([model('codex'), model('gemini')]);
  });
  it('both agree → agreement "agree", agreed populated, divergent empty, verdicts per provider', async () => {
    const shared = [f('a.ts', 1, 'security', 'major')];
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(ok(codeResult('approve', shared, 'cdx'))),
    });
    const secondary = backend('gemini', {
      reviewCode: vi
        .fn()
        .mockResolvedValue(ok(codeResult('approve', [f('a.ts', 1, 'security', 'major')], 'gem'))),
    });

    const res = await createDeliberationBackend(primary, secondary).reviewCode({
      execution: EXEC,
      diff: DIFF,
    });

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
      reviewCode: vi
        .fn()
        .mockResolvedValue(
          ok(
            codeResult('request_changes', [
              f('a.ts', 1, 'security', 'critical'),
              f('a.ts', 5, 'bugs', 'major'),
            ]),
          ),
        ),
    });
    const secondary = backend('gemini', {
      reviewCode: vi
        .fn()
        .mockResolvedValue(
          ok(
            codeResult('request_changes', [
              f('a.ts', 1, 'security', 'critical'),
              f('b.ts', 2, 'perf', 'minor'),
            ]),
          ),
        ),
    });

    const res = await createDeliberationBackend(primary, secondary).reviewCode({
      execution: EXEC,
      diff: DIFF,
    });

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
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(ok(codeResult('approve', []))),
    });
    const secondary = backend('gemini', {
      reviewCode: vi.fn().mockResolvedValue(ok(codeResult('reject', []))),
    });

    const res = await createDeliberationBackend(primary, secondary).reviewCode({
      execution: EXEC,
      diff: DIFF,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.deliberation?.agreement).toBe('conflict');
      expect(res.data.verdict).toBe('reject'); // worst of approve/reject
    }
  });

  it('runs both providers in parallel (both review methods called once)', async () => {
    const pReview = vi.fn().mockResolvedValue(ok(codeResult('approve', [])));
    const sReview = vi.fn().mockResolvedValue(ok(codeResult('approve', [])));
    await createDeliberationBackend(
      backend('codex', { reviewCode: pReview }),
      backend('gemini', { reviewCode: sReview }),
    ).reviewCode({ execution: EXEC, diff: DIFF });
    expect(pReview).toHaveBeenCalledOnce();
    expect(sReview).toHaveBeenCalledOnce();
    expect(sReview).toHaveBeenCalledWith(expect.objectContaining({ model: undefined })); // secondary model cleared
  });

  it('degrades to the survivor + a `degraded` marker when one provider fails', async () => {
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(err(`${ErrorCode.RATE_LIMITED}: out of usage`)),
    });
    const secondary = backend('gemini', {
      reviewCode: vi
        .fn()
        .mockResolvedValue(ok(codeResult('reject', [f('a.ts', 1, 'security', 'critical')], 'gem'))),
    });

    const res = await createDeliberationBackend(primary, secondary).reviewCode({
      execution: EXEC,
      diff: DIFF,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.provider).toBe('gemini'); // survivor
      expect(res.data.verdict).toBe('reject');
      expect(res.data.deliberation?.degraded).toEqual({
        failed: 'codex',
        reason: expect.stringContaining('RATE_LIMITED'),
      });
      expect(res.data.deliberation?.providers).toEqual(['gemini']);
      // ISS-016: a single-provider degraded result must NOT claim 'agree'.
      expect(res.data.deliberation?.agreement).toBe('degraded');
    }
  });

  it('fresh code: sanitizes a rejected reviewer promise and preserves the successful peer', async () => {
    const survivor = {
      ...codeResult('approve', [], 'codex-session'),
      models: [model('codex')],
    };
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(ok(survivor)),
    });
    const secondary = backend('gemini', {
      reviewCode: vi.fn().mockRejectedValue(PRIVATE_REJECTION),
    });

    const result = await createDeliberationBackend(primary, secondary).reviewCode({
      execution: EXEC,
      diff: DIFF,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.session_id).toBe('codex-session');
    expect(result.data.models).toEqual([model('codex')]);
    expect(result.data.deliberation?.degraded).toEqual({
      failed: 'gemini',
      reason: REJECTED_PROVIDER_ERROR,
    });
    expect(result.data.deliberation?.degraded?.reason).not.toContain('/Users/alice');
    expect(result.data.deliberation?.degraded?.reason).not.toContain('super-secret');
  });

  it('resumed code: sanitizes a rejected owner promise and preserves the fresh peer', async () => {
    const primary = backend('codex', {
      reviewCode: vi.fn().mockRejectedValue(PRIVATE_REJECTION),
    });
    const survivor = {
      ...codeResult('approve', [], 'gemini-fresh'),
      models: [model('gemini')],
    };
    const secondary = backend('gemini', {
      reviewCode: vi.fn().mockResolvedValue(ok(survivor)),
    });

    const result = await createDeliberationBackend(primary, secondary).reviewCode({
      execution: EXEC,
      diff: DIFF,
      session_id: 'codex-resumed',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.session_id).toBe('gemini-fresh');
    expect(result.data.models).toEqual([model('gemini')]);
    expect(result.data.deliberation?.degraded).toEqual({
      failed: 'codex',
      reason: REJECTED_PROVIDER_ERROR,
    });
    expect(result.data.deliberation?.degraded?.reason).not.toContain('/Users/alice');
    expect(result.data.deliberation?.degraded?.reason).not.toContain('super-secret');
  });

  it('fresh plan: sanitizes a rejected reviewer promise and preserves the successful peer', async () => {
    const survivor = {
      verdict: 'approve' as const,
      summary: 'safe plan',
      findings: [],
      session_id: 'gemini-plan',
      models: [model('gemini')],
    };
    const primary = backend('codex', {
      reviewPlan: vi.fn().mockRejectedValue(PRIVATE_REJECTION),
    });
    const secondary = backend('gemini', {
      reviewPlan: vi.fn().mockResolvedValue(ok(survivor)),
    });

    const result = await createDeliberationBackend(primary, secondary).reviewPlan({
      execution: EXEC,
      plan: 'plan',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.session_id).toBe('gemini-plan');
    expect(result.data.models).toEqual([model('gemini')]);
    expect(result.data.deliberation?.degraded).toEqual({
      failed: 'codex',
      reason: REJECTED_PROVIDER_ERROR,
    });
    expect(result.data.deliberation?.degraded?.reason).not.toContain('/Users/alice');
    expect(result.data.deliberation?.degraded?.reason).not.toContain('super-secret');
  });

  it('resumed plan: sanitizes a rejected fresh-peer promise and preserves the owner', async () => {
    const primary = backend('codex', {
      reviewPlan: vi.fn().mockRejectedValue(PRIVATE_REJECTION),
    });
    const survivor = {
      verdict: 'approve' as const,
      summary: 'owner plan',
      findings: [],
      session_id: 'gemini-resumed',
      models: [model('gemini')],
    };
    const secondary = backend('gemini', {
      reviewPlan: vi.fn().mockResolvedValue(ok(survivor)),
    });
    const lookup = vi.fn().mockReturnValue({ status: 'found', value: 'gemini' });

    const result = await createDeliberationBackend(primary, secondary, { lookup }).reviewPlan({
      execution: EXEC,
      plan: 'plan',
      session_id: 'gemini-resumed',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.session_id).toBe('gemini-resumed');
    expect(result.data.models).toEqual([model('gemini')]);
    expect(result.data.deliberation?.degraded).toEqual({
      failed: 'codex',
      reason: REJECTED_PROVIDER_ERROR,
    });
    expect(result.data.deliberation?.degraded?.reason).not.toContain('/Users/alice');
    expect(result.data.deliberation?.degraded?.reason).not.toContain('super-secret');
  });

  it('returns a combined error when both providers fail', async () => {
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(err(`${ErrorCode.RATE_LIMITED}: usage`)),
    });
    const secondary = backend('gemini', {
      reviewCode: vi.fn().mockResolvedValue(err(`${ErrorCode.AUTH_ERROR}: not signed in`)),
    });

    const res = await createDeliberationBackend(primary, secondary).reviewCode({
      execution: EXEC,
      diff: DIFF,
    });

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
      execution: EXEC,
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
    const lookup = vi.fn().mockReturnValue({ status: 'found', value: 'gemini' });

    const res = await createDeliberationBackend(primary, secondary, { lookup }).reviewCode({
      execution: EXEC,
      diff: DIFF,
      session_id: 'gemini-sess',
      model: 'Gemini 3.1 Pro (High)',
    });

    expect(lookup).toHaveBeenCalledWith('gemini-sess');
    expect(sReview).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'gemini-sess',
        model: 'Gemini 3.1 Pro (High)',
      }),
    ); // owner resumes with its override
    expect(pReview).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: undefined, model: undefined }),
    ); // primary fresh on its own default
    expect(res.ok && res.data.provider).toBe('codex'); // composite presents as primary
    expect(res.ok && res.data.session_id).toBe('gemini-sess'); // combined = resumed owner session
    expect(res.ok && res.data.deliberation).toBeDefined();
  });

  it('deliberate plan resume applies the model override to a secondary owner, not the fresh primary', async () => {
    const primaryReview = vi.fn().mockResolvedValue(
      ok({
        verdict: 'approve' as const,
        summary: 'fresh',
        findings: [],
        session_id: 'codex-fresh',
      }),
    );
    const secondaryReview = vi.fn().mockResolvedValue(
      ok({
        verdict: 'approve' as const,
        summary: 'owner',
        findings: [],
        session_id: 'gemini-sess',
      }),
    );
    const lookup = vi.fn().mockReturnValue({ status: 'found', value: 'gemini' });

    await createDeliberationBackend(
      backend('codex', { reviewPlan: primaryReview }),
      backend('gemini', { reviewPlan: secondaryReview }),
      { lookup },
    ).reviewPlan({
      execution: EXEC,
      plan: 'plan',
      session_id: 'gemini-sess',
      model: 'Gemini 3.1 Pro (High)',
    });

    expect(secondaryReview).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'gemini-sess',
        model: 'Gemini 3.1 Pro (High)',
      }),
    );
    expect(primaryReview).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: undefined, model: undefined }),
    );
  });

  it('rejects a model override for a resumed Codex owner before either reviewer runs', async () => {
    const primaryReview = vi.fn();
    const secondaryReview = vi.fn();
    const lookup = vi.fn().mockReturnValue({ status: 'found', value: 'codex' });

    const result = await createDeliberationBackend(
      backend('codex', { reviewCode: primaryReview }),
      backend('gemini', { reviewCode: secondaryReview }),
      { lookup },
    ).reviewCode({ execution: EXEC, diff: DIFF, session_id: 'codex-session', model: 'gpt-5.5' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Cannot change model on a resumed session');
    expect(primaryReview).not.toHaveBeenCalled();
    expect(secondaryReview).not.toHaveBeenCalled();
  });

  it('does not call either reviewer when resume ownership is unavailable', async () => {
    const pReview = vi.fn();
    const sReview = vi.fn();
    const lookup = vi.fn().mockReturnValue({ status: 'unavailable' });

    const res = await createDeliberationBackend(
      backend('codex', { reviewCode: pReview }),
      backend('gemini', { reviewCode: sReview }),
      { lookup },
    ).reviewCode({ execution: EXEC, diff: DIFF, session_id: 'unknown-owner' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/^SESSION_ROUTING_UNAVAILABLE:/);
    expect(pReview).not.toHaveBeenCalled();
    expect(sReview).not.toHaveBeenCalled();
  });

  it('deliberate-on-resume: if the owner fails, degrade to the fresh other leaf with its NEW session id', async () => {
    // No lookup → owner is primary (codex). Its resume fails; the fresh secondary
    // survives. The degraded result carries the secondary's NEW session id — the
    // old (owner) session couldn't be served this round.
    const pReview = vi.fn().mockResolvedValue(err(`${ErrorCode.RATE_LIMITED}: out of usage`));
    const sReview = vi.fn().mockResolvedValue(ok(codeResult('approve', [], 'gem-fresh')));
    const primary = backend('codex', { reviewCode: pReview });
    const secondary = backend('gemini', { reviewCode: sReview });

    const res = await createDeliberationBackend(primary, secondary).reviewCode({
      execution: EXEC,
      diff: DIFF,
      session_id: 'codex-sess',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.provider).toBe('gemini'); // survivor
    expect(res.data.session_id).toBe('gem-fresh'); // fresh NEW session, not the dead 'codex-sess'
    expect(res.data.deliberation?.degraded).toEqual({
      failed: 'codex',
      reason: expect.stringContaining('RATE_LIMITED'),
    });
    expect(res.data.deliberation?.agreement).toBe('degraded');
  });

  it('deliberate-on-resume: both legs fail → error leads with the PRIMARY error, names the secondary', async () => {
    // Owner is the secondary (gemini) via lookup; both fail. The combined error
    // must still be primary-led and name gemini as the "also failed" side — not
    // swap them by owner/other order.
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(err(`${ErrorCode.AUTH_ERROR}: codex not signed in`)),
    });
    const secondary = backend('gemini', {
      reviewCode: vi.fn().mockResolvedValue(err(`${ErrorCode.RATE_LIMITED}: gemini out of usage`)),
    });
    const lookup = vi.fn().mockReturnValue({ status: 'found', value: 'gemini' });

    const res = await createDeliberationBackend(primary, secondary, { lookup }).reviewCode({
      execution: EXEC,
      diff: DIFF,
      session_id: 'gemini-sess',
    });

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
    const res = await createDeliberationBackend(
      primary,
      backend('gemini', { reviewPrecommit: sPre }),
    ).reviewPrecommit({ execution: EXEC, diff: DIFF });
    expect(res.ok).toBe(true);
    expect(sPre).not.toHaveBeenCalled(); // primary succeeded → no second call (failover semantics)
  });

  it('reviewPlan deliberates too', async () => {
    const planA = {
      verdict: 'revise',
      summary: 's',
      findings: [f('p.ts', 1, 'feasibility', 'major')],
      session_id: 'a',
    };
    const planB = { verdict: 'approve', summary: 's', findings: [], session_id: 'b' };
    const res = await createDeliberationBackend(
      backend('codex', { reviewPlan: vi.fn().mockResolvedValue(ok(planA)) }),
      backend('gemini', { reviewPlan: vi.fn().mockResolvedValue(ok(planB)) }),
    ).reviewPlan({ execution: EXEC, plan: 'do a thing' });
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
const cross = (verdict: string, reason: string) => ({
  adjudications: [{ index: 0, verdict, reason }],
});
function mixedPair(pMethods: Methods = {}, sMethods: Methods = {}) {
  const primary = backend('codex', {
    reviewCode: vi
      .fn()
      .mockResolvedValue(
        ok(
          codeResult('request_changes', [
            f('a.ts', 1, 'security', 'critical'),
            f('a.ts', 5, 'bugs', 'major'),
          ]),
        ),
      ),
    ...pMethods,
  });
  const secondary = backend('gemini', {
    reviewCode: vi
      .fn()
      .mockResolvedValue(
        ok(
          codeResult('request_changes', [
            f('a.ts', 1, 'security', 'critical'),
            f('b.ts', 2, 'perf', 'minor'),
          ]),
        ),
      ),
    ...sMethods,
  });
  return { primary, secondary };
}

describe('createDeliberationBackend — deliberate-deep (cross-review round)', () => {
  it('appends successful adjudication identities after reviewer identities in provider order', async () => {
    const primaryReview = {
      ...codeResult('request_changes', [f('a.ts', 5, 'bugs', 'major')], 'cdx'),
      models: [model('codex')],
    };
    const secondaryReview = {
      ...codeResult('request_changes', [f('b.ts', 2, 'perf', 'minor')], 'gem'),
      models: [model('gemini')],
    };
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(ok(primaryReview)),
      crossReview: vi
        .fn()
        .mockResolvedValue(
          ok({ ...cross('confirmed', 'real'), models: [model('codex', 'adjudication')] }),
        ),
    });
    const secondary = backend('gemini', {
      reviewCode: vi.fn().mockResolvedValue(ok(secondaryReview)),
      crossReview: vi
        .fn()
        .mockResolvedValue(
          ok({ ...cross('confirmed', 'real'), models: [model('gemini', 'adjudication')] }),
        ),
    });

    const res = await createDeliberationBackend(primary, secondary, {
      crossReview: true,
    }).reviewCode({ execution: EXEC, diff: DIFF });

    expect(res.ok && res.data.models).toEqual([
      model('codex'),
      model('gemini'),
      model('codex', 'adjudication'),
      model('gemini', 'adjudication'),
    ]);
  });

  it("adjudicates each provider's divergent findings with the OTHER provider", async () => {
    const secReview = vi.fn().mockResolvedValue(ok(cross('confirmed', 'yes real'))); // gemini judges codex's finding
    const priReview = vi.fn().mockResolvedValue(ok(cross('disputed', 'false positive'))); // codex judges gemini's finding
    const { primary, secondary } = mixedPair(
      { crossReview: priReview },
      { crossReview: secReview },
    );

    const res = await createDeliberationBackend(primary, secondary, {
      crossReview: true,
    }).reviewCode({ execution: EXEC, diff: DIFF });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const div = res.data.deliberation?.divergent ?? [];
    expect(div).toHaveLength(2);
    // codex's divergent finding, adjudicated by gemini.
    expect(div[0].provider).toBe('codex');
    expect(div[0].adjudication).toEqual({ by: 'gemini', verdict: 'confirmed', reason: 'yes real' });
    // gemini's divergent finding, adjudicated by codex.
    expect(div[1].provider).toBe('gemini');
    expect(div[1].adjudication).toEqual({
      by: 'codex',
      verdict: 'disputed',
      reason: 'false positive',
    });
    // Each judge saw the diff and only the OTHER provider's one finding.
    expect(secReview).toHaveBeenCalledWith(
      expect.objectContaining({
        content: DIFF,
        findings: [expect.objectContaining({ file: 'a.ts', line: 5 })],
      }),
    );
    expect(priReview).toHaveBeenCalledWith(
      expect.objectContaining({
        content: DIFF,
        findings: [expect.objectContaining({ file: 'b.ts', line: 2 })],
      }),
    );
  });

  it('ISS-014: forwards the caller model to the PRIMARY judge only', async () => {
    const secReview = vi.fn().mockResolvedValue(ok(cross('confirmed', 'r'))); // gemini judge
    const priReview = vi.fn().mockResolvedValue(ok(cross('disputed', 'r'))); // codex judge
    const { primary, secondary } = mixedPair(
      { crossReview: priReview },
      { crossReview: secReview },
    );

    await createDeliberationBackend(primary, secondary, { crossReview: true }).reviewCode({
      execution: EXEC,
      diff: DIFF,
      model: 'gpt-5.4',
    });

    // codex is the primary → its adjudication turn gets the override; gemini resolves its own default.
    expect(priReview).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.4' }));
    expect(secReview).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
  });

  it('routes a resumed secondary owner model to that provider review and adjudication turns', async () => {
    const primaryJudge = vi.fn().mockResolvedValue(ok(cross('disputed', 'r')));
    const secondaryJudge = vi.fn().mockResolvedValue(ok(cross('confirmed', 'r')));
    const { primary, secondary } = mixedPair(
      { crossReview: primaryJudge },
      { crossReview: secondaryJudge },
    );
    const lookup = vi.fn().mockReturnValue({ status: 'found', value: 'gemini' });

    await createDeliberationBackend(primary, secondary, {
      crossReview: true,
      lookup,
    }).reviewCode({
      execution: EXEC,
      diff: DIFF,
      session_id: 'sid',
      model: 'Gemini 3.1 Pro (High)',
    });

    expect(secondary.reviewCode).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'Gemini 3.1 Pro (High)' }),
    );
    expect(primary.reviewCode).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
    expect(secondaryJudge).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'Gemini 3.1 Pro (High)' }),
    );
    expect(primaryJudge).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
  });

  it('ISS-012: slices the cross-review subject to the files each finding touches', async () => {
    const twoFile =
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+A\n' +
      'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-b\n+B';
    const secReview = vi.fn().mockResolvedValue(ok(cross('confirmed', 'r'))); // judges codex's a.ts finding
    const priReview = vi.fn().mockResolvedValue(ok(cross('disputed', 'r'))); // judges gemini's b.ts finding
    const { primary, secondary } = mixedPair(
      { crossReview: priReview },
      { crossReview: secReview },
    );

    await createDeliberationBackend(primary, secondary, { crossReview: true }).reviewCode({
      execution: EXEC,
      diff: twoFile,
    });

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
    const { primary, secondary } = mixedPair(
      { crossReview: priReview },
      { crossReview: secReview },
    );

    // maxChunkTokens:1 → any subject blows the budget → both judges skipped.
    const res = await createDeliberationBackend(primary, secondary, {
      crossReview: true,
      maxChunkTokens: 1,
    }).reviewCode({ execution: EXEC, diff: DIFF });

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
    const { primary, secondary } = mixedPair(
      { crossReview: priReview },
      { crossReview: secReview },
    );

    const res = await createDeliberationBackend(primary, secondary).reviewCode({
      execution: EXEC,
      diff: DIFF,
    });

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

    const res = await createDeliberationBackend(primary, secondary, {
      crossReview: true,
    }).reviewCode({ execution: EXEC, diff: DIFF });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const div = res.data.deliberation?.divergent ?? [];
    expect(div[0].adjudication).toBeUndefined(); // gemini couldn't judge
    expect(div[1].adjudication).toEqual({ by: 'codex', verdict: 'confirmed', reason: 'real' });
  });

  it('surfaces a failed crossReview call as cross_review_failures, not silently (ISS-012)', async () => {
    const secReview = vi.fn().mockResolvedValue(err(`${ErrorCode.RATE_LIMITED}: out of usage`));
    const priReview = vi.fn().mockResolvedValue(ok(cross('confirmed', 'real')));
    const { primary, secondary } = mixedPair(
      { crossReview: priReview },
      { crossReview: secReview },
    );

    const res = await createDeliberationBackend(primary, secondary, {
      crossReview: true,
    }).reviewCode({ execution: EXEC, diff: DIFF });

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

  it('preserves the completed main review when a judge promise rejects', async () => {
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(
        ok({
          ...codeResult('request_changes', [f('a.ts', 5, 'bugs', 'major')], 'codex-main'),
          models: [model('codex')],
        }),
      ),
      crossReview: vi.fn().mockResolvedValue(
        ok({
          ...cross('confirmed', 'real'),
          models: [model('codex', 'adjudication')],
        }),
      ),
    });
    const secondary = backend('gemini', {
      reviewCode: vi.fn().mockResolvedValue(
        ok({
          ...codeResult('request_changes', [f('b.ts', 2, 'perf', 'minor')], 'gemini-main'),
          models: [model('gemini')],
        }),
      ),
      crossReview: vi.fn().mockRejectedValue(PRIVATE_REJECTION),
    });

    const result = await createDeliberationBackend(primary, secondary, {
      crossReview: true,
    }).reviewCode({ execution: EXEC, diff: DIFF });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.verdict).toBe('request_changes');
    expect(result.data.session_id).toBe('codex-main');
    expect(result.data.findings).toHaveLength(2);
    expect(result.data.models).toEqual([
      model('codex'),
      model('gemini'),
      model('codex', 'adjudication'),
    ]);
    expect(result.data.deliberation?.cross_review_failures).toEqual([
      { by: 'gemini', reason: REJECTED_PROVIDER_ERROR },
    ]);
    expect(result.data.deliberation?.cross_review_failures?.[0].reason).not.toContain(
      '/Users/alice',
    );
    expect(result.data.deliberation?.cross_review_failures?.[0].reason).not.toContain(
      'super-secret',
    );
  });

  it('skips cross-review entirely when there are no divergent findings', async () => {
    const secReview = vi.fn();
    const priReview = vi.fn();
    const shared = [f('a.ts', 1, 'security', 'major')];
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(ok(codeResult('approve', shared))),
      crossReview: priReview,
    });
    const secondary = backend('gemini', {
      reviewCode: vi
        .fn()
        .mockResolvedValue(ok(codeResult('approve', [f('a.ts', 1, 'security', 'major')]))),
      crossReview: secReview,
    });

    const res = await createDeliberationBackend(primary, secondary, {
      crossReview: true,
    }).reviewCode({ execution: EXEC, diff: DIFF });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.deliberation?.divergent).toHaveLength(0);
    expect(secReview).not.toHaveBeenCalled();
    expect(priReview).not.toHaveBeenCalled();
  });

  it('cross-reviews plan divergent findings against the plan text', async () => {
    const planA = {
      verdict: 'revise',
      summary: 's',
      findings: [f('p.ts', 1, 'feasibility', 'major')],
      session_id: 'a',
    };
    const planB = {
      verdict: 'revise',
      summary: 's',
      findings: [f('q.ts', 9, 'security', 'major')],
      session_id: 'b',
    };
    const secReview = vi.fn().mockResolvedValue(ok(cross('confirmed', 'agreed'))); // gemini judges codex's finding
    const priReview = vi.fn().mockResolvedValue(ok(cross('unsure', 'cannot tell'))); // codex judges gemini's finding
    const primary = backend('codex', {
      reviewPlan: vi.fn().mockResolvedValue(ok(planA)),
      crossReview: priReview,
    });
    const secondary = backend('gemini', {
      reviewPlan: vi.fn().mockResolvedValue(ok(planB)),
      crossReview: secReview,
    });

    const res = await createDeliberationBackend(primary, secondary, {
      crossReview: true,
    }).reviewPlan({ execution: EXEC, plan: 'do a thing' });

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
    const planA = {
      verdict: 'revise',
      summary: 's',
      findings: [f('p.ts', 1, 'feasibility', 'major')],
      session_id: 'a',
    };
    const planB = {
      verdict: 'revise',
      summary: 's',
      findings: [f('q.ts', 9, 'security', 'major')],
      session_id: 'b',
    };
    const secReview = vi.fn().mockResolvedValue(ok(cross('confirmed', 'r'))); // gemini judge
    const priReview = vi.fn().mockResolvedValue(ok(cross('unsure', 'r'))); // codex judge
    const primary = backend('codex', {
      reviewPlan: vi.fn().mockResolvedValue(ok(planA)),
      crossReview: priReview,
    });
    const secondary = backend('gemini', {
      reviewPlan: vi.fn().mockResolvedValue(ok(planB)),
      crossReview: secReview,
    });

    await createDeliberationBackend(primary, secondary, { crossReview: true }).reviewPlan({
      execution: EXEC,
      plan: 'do a thing',
      model: 'gpt-5.4',
    });

    expect(priReview).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.4' })); // primary judge gets it
    expect(secReview).toHaveBeenCalledWith(expect.objectContaining({ model: undefined })); // secondary resolves own
  });
});

// A tier is provider-neutral, so it must reach BOTH reviewers and both
// adjudicators — as it already does across failover. A concrete model id is
// meaningful only to the provider it names and must still be dropped.
describe('createDeliberationBackend — provider-neutral tiers', () => {
  it('carries a tier to the secondary reviewer and to both adjudicators', async () => {
    const priCross = vi.fn().mockResolvedValue(ok(cross('confirmed', 'yes')));
    const secCross = vi.fn().mockResolvedValue(ok(cross('confirmed', 'yes')));
    const { primary, secondary } = mixedPair({ crossReview: priCross }, { crossReview: secCross });

    await createDeliberationBackend(primary, secondary, { crossReview: true }).reviewCode({
      execution: EXEC,
      diff: DIFF,
      model: 'max',
    });

    expect(primary.reviewCode).toHaveBeenCalledWith(expect.objectContaining({ model: 'max' }));
    expect(secondary.reviewCode).toHaveBeenCalledWith(expect.objectContaining({ model: 'max' }));
    expect(priCross).toHaveBeenCalledWith(expect.objectContaining({ model: 'max' }));
    expect(secCross).toHaveBeenCalledWith(expect.objectContaining({ model: 'max' }));
  });

  it('still drops a concrete model id for the secondary reviewer', async () => {
    const { primary, secondary } = mixedPair();

    await createDeliberationBackend(primary, secondary).reviewCode({
      execution: EXEC,
      diff: DIFF,
      model: 'gpt-6-astra',
    });

    expect(primary.reviewCode).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-6-astra' }),
    );
    expect(secondary.reviewCode).toHaveBeenCalledWith(
      expect.objectContaining({ model: undefined }),
    );
  });

  it('carries a tier to the other reviewer on a resumed session too', async () => {
    const { primary, secondary } = mixedPair();

    await createDeliberationBackend(primary, secondary, {
      lookup: () => ({ status: 'found', value: 'gemini' }),
    }).reviewCode({ execution: EXEC, diff: DIFF, session_id: 'gem-owned', model: 'fast' });

    // gemini owns the session and gets the tier as the caller's override;
    // codex reviews fresh and must get the same tier, not undefined.
    expect(secondary.reviewCode).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'gem-owned', model: 'fast' }),
    );
    expect(primary.reviewCode).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: undefined, model: 'fast' }),
    );
  });
});
