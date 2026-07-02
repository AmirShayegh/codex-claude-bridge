import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFailoverBackend, isFailoverEligible } from './failover.js';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { ReviewBackend } from './backend.js';
import type { ReviewProvider } from '../config/types.js';

type Methods = Partial<Pick<ReviewBackend, 'reviewPlan' | 'reviewCode' | 'reviewPrecommit'>>;

function backend(provider: ReviewProvider, methods: Methods = {}): ReviewBackend {
  return {
    provider,
    providers: [provider],
    allowsModelOverrideOnResume: provider === 'gemini',
    reviewPlan: methods.reviewPlan ?? vi.fn(),
    reviewCode: methods.reviewCode ?? vi.fn(),
    reviewPrecommit: methods.reviewPrecommit ?? vi.fn(),
  };
}

const CODE_OK = { verdict: 'approve' as const, summary: 's', findings: [], session_id: 'sec-session' };
const DIFF = 'diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('isFailoverEligible', () => {
  it('matches the out-of-usage / unavailable codes', () => {
    expect(isFailoverEligible(`${ErrorCode.RATE_LIMITED}: x`)).toBe(true);
    expect(isFailoverEligible(`${ErrorCode.MODEL_ERROR}: x`)).toBe(true);
    expect(isFailoverEligible(`${ErrorCode.AUTH_ERROR}: x`)).toBe(true);
    // A dead/missing/quarantined provider binary is the clearest failover case.
    expect(isFailoverEligible(`${ErrorCode.PROVIDER_UNAVAILABLE}: x`)).toBe(true);
  });

  it('does not match codes where the model worked or the input was bad', () => {
    expect(isFailoverEligible(`${ErrorCode.INVALID_INPUT}: x`)).toBe(false);
    expect(isFailoverEligible(`${ErrorCode.RESPONSE_PARSE_ERROR}: x`)).toBe(false);
    expect(isFailoverEligible(`${ErrorCode.REVIEW_TIMEOUT}: x`)).toBe(false);
  });
});

describe('createFailoverBackend', () => {
  it('on an eligible primary error, the secondary serves and the result is tagged with it', async () => {
    const secReview = vi.fn().mockResolvedValue(ok(CODE_OK));
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(err(`${ErrorCode.RATE_LIMITED}: out of usage`)),
    });
    const secondary = backend('gemini', { reviewCode: secReview });

    const res = await createFailoverBackend(primary, secondary).reviewCode({ diff: DIFF });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.provider).toBe('gemini');
    expect(secReview).toHaveBeenCalledOnce();
  });

  it('fails over to the secondary when the primary binary is unavailable (killed/quarantined)', async () => {
    const secReview = vi.fn().mockResolvedValue(ok(CODE_OK));
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(err(`${ErrorCode.PROVIDER_UNAVAILABLE}: codex binary was killed`)),
    });
    const res = await createFailoverBackend(primary, backend('gemini', { reviewCode: secReview })).reviewCode({
      diff: DIFF,
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.provider).toBe('gemini'); // degraded to the working provider
    expect(secReview).toHaveBeenCalledOnce();
  });

  it('does NOT fail over on an ineligible error and returns the primary failure', async () => {
    const secReview = vi.fn();
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(err(`${ErrorCode.INVALID_INPUT}: bad diff`)),
    });
    const res = await createFailoverBackend(primary, backend('gemini', { reviewCode: secReview })).reviewCode({
      diff: DIFF,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(ErrorCode.INVALID_INPUT);
    expect(secReview).not.toHaveBeenCalled();
  });

  it('on primary success, never calls the secondary and tags the primary', async () => {
    const secReview = vi.fn();
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(ok({ ...CODE_OK, session_id: 'pri' })),
    });
    const res = await createFailoverBackend(primary, backend('gemini', { reviewCode: secReview })).reviewCode({
      diff: DIFF,
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.provider).toBe('codex');
    expect(secReview).not.toHaveBeenCalled();
  });

  it('when both fail, returns a combined error led by the primary failure', async () => {
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(err(`${ErrorCode.RATE_LIMITED}: usage`)),
    });
    const secondary = backend('gemini', {
      reviewCode: vi.fn().mockResolvedValue(err(`${ErrorCode.AUTH_ERROR}: not signed in`)),
    });

    const res = await createFailoverBackend(primary, secondary).reviewCode({ diff: DIFF });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.startsWith(`${ErrorCode.RATE_LIMITED}:`)).toBe(true); // primary led
      expect(res.error).toContain('gemini also failed');
      expect(res.error).toContain(ErrorCode.AUTH_ERROR);
    }
  });

  it('does NOT fail over a resumed session (delegates to primary only)', async () => {
    const secReview = vi.fn();
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(err(`${ErrorCode.RATE_LIMITED}: usage`)),
    });
    const res = await createFailoverBackend(primary, backend('gemini', { reviewCode: secReview })).reviewCode({
      diff: DIFF,
      session_id: 'codex-sess',
    });

    expect(res.ok).toBe(false);
    expect(secReview).not.toHaveBeenCalled();
  });

  it('drops a per-call model pin when failing over (a primary model is meaningless for the secondary)', async () => {
    const secReview = vi.fn().mockResolvedValue(ok(CODE_OK));
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(err(`${ErrorCode.MODEL_ERROR}: not supported`)),
    });
    await createFailoverBackend(primary, backend('gemini', { reviewCode: secReview })).reviewCode({
      diff: DIFF,
      model: 'gpt-5.4',
    });

    expect(secReview).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
  });

  it('narrates the switch on stderr', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const primary = backend('codex', {
      reviewCode: vi.fn().mockResolvedValue(err(`${ErrorCode.RATE_LIMITED}: usage`)),
    });
    const secondary = backend('gemini', { reviewCode: vi.fn().mockResolvedValue(ok(CODE_OK)) });

    await createFailoverBackend(primary, secondary).reviewCode({ diff: DIFF });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back to gemini'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('RATE_LIMITED'));
  });

  it('presents the primary provider and its capability flag', () => {
    const fb = createFailoverBackend(backend('gemini'), backend('codex'));
    expect(fb.provider).toBe('gemini');
    expect(fb.allowsModelOverrideOnResume).toBe(true); // gemini primary
  });

  it('reviewPlan and reviewPrecommit fail over too (symmetry)', async () => {
    const planOk = { verdict: 'approve' as const, summary: 's', findings: [], session_id: 'g' };
    const preOk = { ready_to_commit: true, blockers: [], warnings: [], session_id: 'g' };
    const primary = backend('codex', {
      reviewPlan: vi.fn().mockResolvedValue(err(`${ErrorCode.RATE_LIMITED}: usage`)),
      reviewPrecommit: vi.fn().mockResolvedValue(err(`${ErrorCode.RATE_LIMITED}: usage`)),
    });
    const secondary = backend('gemini', {
      reviewPlan: vi.fn().mockResolvedValue(ok(planOk)),
      reviewPrecommit: vi.fn().mockResolvedValue(ok(preOk)),
    });
    const fb = createFailoverBackend(primary, secondary);

    const p = await fb.reviewPlan({ plan: 'x' });
    const c = await fb.reviewPrecommit({ diff: DIFF });

    expect(p.ok && p.data.provider).toBe('gemini');
    expect(c.ok && c.data.provider).toBe('gemini');
  });
});

// ISS-011: a resumed session must route to the leaf that OWNS it, not always the
// primary. A session degraded to the secondary belongs to the secondary.
describe('createFailoverBackend — resume ownership routing', () => {
  const RESUME = { diff: DIFF, session_id: 'sess-1' };

  it('routes a secondary-owned resume to the secondary (not the primary)', async () => {
    const priReview = vi.fn().mockResolvedValue(ok({ ...CODE_OK, session_id: 'pri' }));
    const secReview = vi.fn().mockResolvedValue(ok({ ...CODE_OK, session_id: 'sess-1' }));
    const primary = backend('codex', { reviewCode: priReview });
    const secondary = backend('gemini', { reviewCode: secReview });
    const lookup = vi.fn().mockReturnValue('gemini');

    const res = await createFailoverBackend(primary, secondary, lookup).reviewCode(RESUME);

    expect(lookup).toHaveBeenCalledWith('sess-1');
    expect(secReview).toHaveBeenCalledOnce();
    expect(priReview).not.toHaveBeenCalled();
    expect(res.ok && res.data.provider).toBe('gemini');
  });

  it('routes a primary-owned resume to the primary', async () => {
    const priReview = vi.fn().mockResolvedValue(ok({ ...CODE_OK, session_id: 'sess-1' }));
    const secReview = vi.fn();
    const fb = createFailoverBackend(backend('codex', { reviewCode: priReview }), backend('gemini', { reviewCode: secReview }), vi.fn().mockReturnValue('codex'));

    const res = await fb.reviewCode(RESUME);

    expect(priReview).toHaveBeenCalledOnce();
    expect(secReview).not.toHaveBeenCalled();
    expect(res.ok && res.data.provider).toBe('codex');
  });

  it('routes to the primary when the owner is unknown (lookup returns null)', async () => {
    const priReview = vi.fn().mockResolvedValue(ok({ ...CODE_OK, session_id: 'sess-1' }));
    const secReview = vi.fn();
    const fb = createFailoverBackend(backend('codex', { reviewCode: priReview }), backend('gemini', { reviewCode: secReview }), vi.fn().mockReturnValue(null));

    const res = await fb.reviewCode(RESUME);

    expect(priReview).toHaveBeenCalledOnce();
    expect(secReview).not.toHaveBeenCalled();
    expect(res.ok && res.data.provider).toBe('codex');
  });

  it('routes to the primary when no lookup is supplied (back-compat)', async () => {
    const priReview = vi.fn().mockResolvedValue(ok({ ...CODE_OK, session_id: 'sess-1' }));
    const secReview = vi.fn();
    const fb = createFailoverBackend(backend('codex', { reviewCode: priReview }), backend('gemini', { reviewCode: secReview }));

    const res = await fb.reviewCode(RESUME);

    expect(priReview).toHaveBeenCalledOnce();
    expect(secReview).not.toHaveBeenCalled();
    expect(res.ok && res.data.provider).toBe('codex');
  });
});
