import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveMode, createCompositeBackend, withSingleMode } from './composite.js';
import { ok } from '../utils/errors.js';
import { ErrorCode } from '../utils/errors.js';
import { DEFAULT_CONFIG } from '../config/types.js';
import { canOverrideModelOnResume, type ReviewBackend } from './backend.js';
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
    reviewPlan: methods.reviewPlan ?? vi.fn().mockResolvedValue(ok(PLAN_OK)),
    reviewCode: methods.reviewCode ?? vi.fn().mockResolvedValue(ok(CODE_OK)),
    reviewPrecommit: methods.reviewPrecommit ?? vi.fn().mockResolvedValue(ok(PRE_OK)),
    ...(methods.crossReview ? { crossReview: methods.crossReview } : {}),
  };
}
const CODE_OK = { verdict: 'approve' as const, summary: 's', findings: [], session_id: 'sid' };
const PLAN_OK = { verdict: 'approve' as const, summary: 's', findings: [], session_id: 'sid' };
const PRE_OK = { ready_to_commit: true, blockers: [], warnings: [], session_id: 'sid' };
const DIFF = 'diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b';
const cfg = (over: Partial<typeof DEFAULT_CONFIG>) => ({ ...DEFAULT_CONFIG, ...over });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveMode', () => {
  it('single config: only deliberate:true is a conflict; else single', () => {
    expect(resolveMode('single', undefined)).toBe('single');
    expect(resolveMode('single', false)).toBe('single');
    expect(resolveMode('single', true)).toBe('single-deliberate-conflict');
  });

  it('failover config: toggle overrides, undefined keeps failover', () => {
    expect(resolveMode('failover', undefined)).toBe('failover');
    expect(resolveMode('failover', false)).toBe('failover');
    expect(resolveMode('failover', true)).toBe('deliberate');
  });

  it('deliberate config: false forces failover, true/undefined deliberate', () => {
    expect(resolveMode('deliberate', undefined)).toBe('deliberate');
    expect(resolveMode('deliberate', true)).toBe('deliberate');
    expect(resolveMode('deliberate', false)).toBe('failover');
  });

  it('deliberate-deep config: true/undefined keep deep, false forces failover', () => {
    expect(resolveMode('deliberate-deep', undefined)).toBe('deliberate-deep');
    expect(resolveMode('deliberate-deep', true)).toBe('deliberate-deep');
    expect(resolveMode('deliberate-deep', false)).toBe('failover');
  });
});

describe('createCompositeBackend — per-call dispatch + review_mode stamping', () => {
  it('deliberate:true on a failover config runs deliberation and stamps review_mode:deliberate', async () => {
    const p = backend('codex');
    const s = backend('gemini');
    const res = await createCompositeBackend(p, s, cfg({ mode: 'failover' })).reviewCode({
      execution: EXEC,
      diff: DIFF,
      deliberate: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.review_mode).toBe('deliberate');
    expect(res.data.deliberation).toBeDefined();
    expect(s.reviewCode).toHaveBeenCalledOnce(); // both providers reviewed
  });

  it('deliberate:false on a deliberate config runs failover and stamps review_mode:failover', async () => {
    const p = backend('codex');
    const s = backend('gemini');
    const res = await createCompositeBackend(p, s, cfg({ mode: 'deliberate' })).reviewCode({
      execution: EXEC,
      diff: DIFF,
      deliberate: false,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.review_mode).toBe('failover');
    expect(res.data.deliberation).toBeUndefined();
    expect(s.reviewCode).not.toHaveBeenCalled(); // primary succeeded → no second provider
  });

  it('no toggle uses the config mode (deliberate-deep stamps deliberate-deep)', async () => {
    const res = await createCompositeBackend(
      backend('codex'),
      backend('gemini'),
      cfg({ mode: 'deliberate-deep' }),
    ).reviewCode({ execution: EXEC, diff: DIFF });
    expect(res.ok && res.data.review_mode).toBe('deliberate-deep');
  });

  it('reviewPlan stamps the mode too', async () => {
    const res = await createCompositeBackend(
      backend('codex'),
      backend('gemini'),
      cfg({ mode: 'failover' }),
    ).reviewPlan({ execution: EXEC, plan: 'p' });
    expect(res.ok && res.data.review_mode).toBe('failover');
  });

  it('reviewPrecommit always runs failover and stamps failover', async () => {
    const res = await createCompositeBackend(
      backend('codex'),
      backend('gemini'),
      cfg({ mode: 'deliberate' }),
    ).reviewPrecommit({ execution: EXEC, diff: DIFF });
    expect(res.ok && res.data.review_mode).toBe('failover');
  });

  it('exposes both providers on the composite', () => {
    const c = createCompositeBackend(
      backend('codex'),
      backend('gemini'),
      cfg({ mode: 'failover' }),
    );
    expect(c.providers).toEqual(['codex', 'gemini']);
    expect(c.provider).toBe('codex');
  });

  it('exposes each owning leaf model-override capability independent of primary order', () => {
    const codexPrimary = createCompositeBackend(
      backend('codex'),
      backend('gemini'),
      cfg({ mode: 'failover' }),
    );
    const geminiPrimary = createCompositeBackend(
      backend('gemini'),
      backend('codex'),
      cfg({ mode: 'failover' }),
    );

    expect(canOverrideModelOnResume(codexPrimary, 'codex')).toBe(false);
    expect(canOverrideModelOnResume(codexPrimary, 'gemini')).toBe(true);
    expect(canOverrideModelOnResume(geminiPrimary, 'codex')).toBe(false);
    expect(canOverrideModelOnResume(geminiPrimary, 'gemini')).toBe(true);
  });
});

describe('withSingleMode', () => {
  it('stamps review_mode:single on success', async () => {
    const res = await withSingleMode(backend('codex')).reviewCode({ execution: EXEC, diff: DIFF });
    expect(res.ok && res.data.review_mode).toBe('single');
  });

  it('stamps single on precommit', async () => {
    const res = await withSingleMode(backend('codex')).reviewPrecommit({
      execution: EXEC,
      diff: DIFF,
    });
    expect(res.ok && res.data.review_mode).toBe('single');
  });

  it('rejects a per-call deliberate:true with INVALID_INPUT (no second provider)', async () => {
    const leaf = backend('codex');
    const res = await withSingleMode(leaf).reviewCode({
      execution: EXEC,
      diff: DIFF,
      deliberate: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(ErrorCode.INVALID_INPUT);
    expect(leaf.reviewCode).not.toHaveBeenCalled(); // rejected before touching the leaf
  });

  it('allows deliberate:false / undefined (runs the leaf, single)', async () => {
    const res = await withSingleMode(backend('codex')).reviewPlan({
      execution: EXEC,
      plan: 'p',
      deliberate: false,
    });
    expect(res.ok && res.data.review_mode).toBe('single');
  });

  it('stamps the serving provider on plan, code, and precommit results (ISS-023)', async () => {
    const single = withSingleMode(backend('codex'));
    const plan = await single.reviewPlan({ execution: EXEC, plan: 'p' });
    const code = await single.reviewCode({ execution: EXEC, diff: DIFF });
    const precommit = await single.reviewPrecommit({ execution: EXEC, diff: DIFF });
    expect(plan.ok && plan.data.provider).toBe('codex');
    expect(code.ok && code.data.provider).toBe('codex');
    expect(precommit.ok && precommit.data.provider).toBe('codex');
  });
});

// Defensive: the exported composite is correct even if called with a single-mode
// config (createBackend never does this, but the factory shouldn't misbehave).
describe('createCompositeBackend — defensive single-mode handling', () => {
  it('runs the primary and stamps single when the config is single', async () => {
    const s = backend('gemini');
    const res = await createCompositeBackend(
      backend('codex'),
      s,
      cfg({ mode: 'single' }),
    ).reviewCode({ execution: EXEC, diff: DIFF });
    expect(res.ok && res.data.review_mode).toBe('single');
    expect(res.ok && res.data.provider).toBe('codex'); // ISS-023
    expect(s.reviewCode).not.toHaveBeenCalled(); // no second provider
  });

  it('rejects deliberate:true under a single config with INVALID_INPUT', async () => {
    const res = await createCompositeBackend(
      backend('codex'),
      backend('gemini'),
      cfg({ mode: 'single' }),
    ).reviewPlan({ execution: EXEC, plan: 'p', deliberate: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(ErrorCode.INVALID_INPUT);
  });
});
