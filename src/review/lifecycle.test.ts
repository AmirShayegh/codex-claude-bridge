import { describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { ReviewBackend } from '../backends/backend.js';
import type { ModelIdentity, PlanReviewResult } from './types.js';
import { createReviewLifecycle } from './lifecycle.js';
import { createSessionRegistry } from '../storage/session-registry.js';
import { createSessionRouting } from '../storage/session-routing.js';
import { err, ErrorCode, ok } from '../utils/errors.js';

const MODEL: ModelIdentity = {
  provider: 'codex',
  role: 'review',
  requested: null,
  resolved: 'gpt-5.6-sol',
  observed: 'gpt-5.6-sol',
  evidence: 'runtime_session_record',
};

const GEMINI_MODEL: ModelIdentity = {
  provider: 'gemini',
  role: 'review',
  requested: 'Gemini 3.1 Pro (High)',
  resolved: 'Gemini 3.1 Pro (High)',
  observed: null,
  evidence: 'bridge_selection',
};

const PLAN_RESULT: PlanReviewResult = {
  verdict: 'approve',
  summary: 'Looks good',
  findings: [],
  session_id: 'result-session',
  provider: 'codex',
  models: [MODEL],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function backend(overrides: Partial<ReviewBackend> = {}): ReviewBackend {
  return {
    provider: 'codex',
    providers: ['codex'],
    allowsModelOverrideOnResume: false,
    reviewPlan: vi.fn().mockResolvedValue(ok(PLAN_RESULT)),
    reviewCode: vi.fn().mockResolvedValue(
      ok({
        verdict: 'approve',
        summary: 'good',
        findings: [],
        session_id: 'code-session',
        provider: 'codex',
        models: [MODEL],
      }),
    ),
    reviewPrecommit: vi.fn().mockResolvedValue(
      ok({
        ready_to_commit: true,
        blockers: [],
        warnings: [],
        session_id: 'pre-session',
        provider: 'codex',
        models: [MODEL],
      }),
    ),
    ...overrides,
  };
}

describe('review lifecycle coordinator', () => {
  it('records an immutable model snapshot and returns durable provenance', async () => {
    const recordOutcome = vi.fn().mockResolvedValue(ok(undefined));
    const registry = createSessionRegistry();
    const lifecycle = createReviewLifecycle({
      backend: backend(),
      registry,
      lookupSessionProvider: () => ({ status: 'absent' }),
      storage: { db: {} as Database.Database, durability: 'durable', warning: null },
      recordOutcome,
    });

    const result = await lifecycle.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.provenance).toEqual({ persistence: 'durable', warning: null });
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resultSessionId: 'result-session',
        servingProvider: 'codex',
        ownerModelIdentity: MODEL,
        review: expect.objectContaining({ models: [MODEL] }),
      }),
    );
    expect(registry.getStatus('result-session')).toMatchObject({
      status: 'completed',
      provider: 'codex',
      model: MODEL,
    });
  });

  it('preserves a successful review with memory-only provenance after a permanent write failure', async () => {
    const registry = createSessionRegistry();
    const onOutcomePersistenceFailure = vi.fn();
    const lifecycle = createReviewLifecycle({
      backend: backend(),
      registry,
      lookupSessionProvider: () => ({ status: 'absent' }),
      storage: { db: {} as Database.Database, durability: 'durable', warning: null },
      recordOutcome: vi.fn().mockResolvedValue(err('STORAGE_ERROR: /secret/path is readonly')),
      onOutcomePersistenceFailure,
    });

    const result = await lifecycle.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.provenance?.persistence).toBe('memory_only');
    expect(result.data.provenance?.warning).toBe(
      'Review succeeded, but its history could not be saved durably; session routing is memory-only.',
    );
    expect(result.data.provenance?.warning).not.toContain('/secret/path');
    expect(registry.getStatus('result-session')?.status).toBe('completed');
    expect(onOutcomePersistenceFailure).toHaveBeenCalledOnce();
    expect(onOutcomePersistenceFailure).toHaveBeenCalledWith('result-session');
  });

  it('preserves a successful review when the outcome writer throws', async () => {
    const registry = createSessionRegistry();
    const lifecycle = createReviewLifecycle({
      backend: backend(),
      registry,
      lookupSessionProvider: () => ({ status: 'absent' }),
      storage: { db: {} as Database.Database, durability: 'durable', warning: null },
      recordOutcome: vi.fn().mockRejectedValue(new Error('/secret/path failed')),
    });

    const result = await lifecycle.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.provenance).toEqual({
      persistence: 'memory_only',
      warning:
        'Review succeeded, but its history could not be saved durably; session routing is memory-only.',
    });
    expect(result.data.provenance?.warning).not.toContain('/secret/path');
    expect(registry.getStatus('result-session')).toMatchObject({
      status: 'completed',
      provider: 'codex',
    });
  });

  it('fails closed when a fresh Gemini result reuses an existing Codex registry id', async () => {
    const registry = createSessionRegistry();
    registry.complete(undefined, 'result-session', 'codex', MODEL);
    const before = registry.getStatus('result-session');
    const recordOutcome = vi.fn();
    const client = backend({
      provider: 'gemini',
      providers: ['gemini'],
      allowsModelOverrideOnResume: true,
      reviewPlan: vi.fn().mockResolvedValue(
        ok({
          ...PLAN_RESULT,
          provider: 'gemini' as const,
          models: [GEMINI_MODEL],
        }),
      ),
    });
    const lifecycle = createReviewLifecycle({
      backend: client,
      registry,
      lookupSessionProvider: () => ({ status: 'absent' }),
      storage: { db: {} as Database.Database, durability: 'durable', warning: null },
      recordOutcome,
    });

    const result = await lifecycle.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^SESSION_ROUTING_UNAVAILABLE:/);
    expect(registry.getStatus('result-session')).toEqual(before);
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it('fails closed when a fresh result collides with a same-provider durable session', async () => {
    const registry = createSessionRegistry();
    const lookupSessionProvider = vi.fn((sessionId: string) =>
      sessionId === 'result-session'
        ? ({ status: 'found', value: 'codex' } as const)
        : ({ status: 'absent' } as const),
    );
    const recordOutcome = vi.fn();
    const lifecycle = createReviewLifecycle({
      backend: backend(),
      registry,
      lookupSessionProvider,
      storage: { db: {} as Database.Database, durability: 'durable', warning: null },
      recordOutcome,
    });

    const result = await lifecycle.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^SESSION_ROUTING_UNAVAILABLE:/);
    expect(registry.getStatus('result-session')).toBeNull();
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it('uses registry absence as sufficient collision evidence for memory-only storage', async () => {
    const recordOutcome = vi.fn().mockResolvedValue(ok(undefined));
    const lifecycle = createReviewLifecycle({
      backend: backend(),
      registry: createSessionRegistry(),
      lookupSessionProvider: () => ({ status: 'unavailable' }),
      storage: { db: {} as Database.Database, durability: 'memory_only', warning: null },
      recordOutcome,
    });

    const result = await lifecycle.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(true);
    expect(recordOutcome).toHaveBeenCalledOnce();
  });

  it('seeds an absent preflight route with the attempted owner through a survivor transition', async () => {
    const registry = createSessionRegistry();
    const recordOutcome = vi.fn().mockResolvedValue(ok(undefined));
    const lifecycle = createReviewLifecycle({
      backend: backend(),
      registry,
      lookupSessionProvider: () => ({ status: 'absent' }),
      storage: { db: {} as Database.Database, durability: 'durable', warning: null },
      recordOutcome,
    });

    const result = await lifecycle.reviewPlan({ plan: 'plan', session_id: 'old-owner' });

    expect(result.ok).toBe(true);
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        preflightSessionId: 'old-owner',
        preflightProvider: 'codex',
        resultSessionId: 'result-session',
      }),
    );
    expect(registry.getStatus('old-owner')).toMatchObject({
      status: 'failed',
      provider: 'codex',
    });
  });

  it('does not downgrade a transactional result-id collision to memory-only success', async () => {
    const registry = createSessionRegistry();
    const onOutcomePersistenceFailure = vi.fn();
    const lifecycle = createReviewLifecycle({
      backend: backend(),
      registry,
      lookupSessionProvider: (sessionId) =>
        sessionId === 'old-owner' ? { status: 'found', value: 'codex' } : { status: 'absent' },
      storage: { db: {} as Database.Database, durability: 'durable', warning: null },
      recordOutcome: vi
        .fn()
        .mockResolvedValue(
          err('SESSION_ROUTING_UNAVAILABLE: returned session id is already recorded'),
        ),
      onOutcomePersistenceFailure,
    });

    const result = await lifecycle.reviewPlan({ plan: 'plan', session_id: 'old-owner' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^SESSION_ROUTING_UNAVAILABLE:/);
    expect(registry.getStatus('result-session')).toBeNull();
    expect(registry.getStatus('old-owner')).toBeNull();
    expect(onOutcomePersistenceFailure).not.toHaveBeenCalled();
  });

  it('accepts a later fresh result after storage recovers while an evicted survivor stays unroutable', async () => {
    let now = 0;
    const registry = createSessionRegistry({ ttlMs: 10, now: () => now });
    const durableOwners = new Map<string, 'codex' | 'gemini'>();
    const routing = createSessionRouting({
      registry,
      durability: 'durable',
      providerLookup: (sessionId) => {
        const provider = durableOwners.get(sessionId);
        return provider ? { status: 'found', value: provider } : { status: 'absent' };
      },
      modelLookup: () => ({ status: 'absent' }),
    });
    const reviewPlan = vi
      .fn()
      .mockResolvedValueOnce(ok({ ...PLAN_RESULT, session_id: 'volatile-survivor' }))
      .mockResolvedValueOnce(ok({ ...PLAN_RESULT, session_id: 'recovered-result' }));
    const recordOutcome = vi
      .fn()
      .mockResolvedValueOnce(err('STORAGE_ERROR: injected write failure'))
      .mockImplementationOnce(async (_db, outcome) => {
        durableOwners.set(outcome.resultSessionId, outcome.servingProvider);
        return ok(undefined);
      });
    const lifecycle = createReviewLifecycle({
      backend: backend({ reviewPlan }),
      registry,
      lookupSessionProvider: routing.lookupProvider,
      lookupResultSession: routing.lookupResultSession,
      storage: { db: {} as Database.Database, durability: 'durable', warning: null },
      recordOutcome,
      onOutcomePersistenceFailure: routing.markOutcomePersistenceFailure,
      onOutcomePersisted: routing.markOutcomePersisted,
    });

    const first = await lifecycle.reviewPlan({ plan: 'first' });
    expect(first.ok && first.data.provenance?.persistence).toBe('memory_only');

    now = 11;
    expect(routing.lookupProvider('volatile-survivor')).toEqual({ status: 'unavailable' });

    const second = await lifecycle.reviewPlan({ plan: 'second' });
    expect(second.ok && second.data.provenance?.persistence).toBe('durable');
    expect(routing.lookupProvider('recovered-result')).toEqual({
      status: 'found',
      value: 'codex',
    });
    expect(recordOutcome).toHaveBeenCalledTimes(2);
  });

  it('clears tombstones for both ids after a durable survivor transition', async () => {
    let now = 0;
    const registry = createSessionRegistry();
    registry.complete(undefined, 'old-owner', 'codex', MODEL);
    const routing = createSessionRouting({
      registry,
      durability: 'durable',
      providerLookup: () => ({ status: 'absent' }),
      modelLookup: () => ({ status: 'absent' }),
      tombstoneTtlMs: 10,
      now: () => now,
    });
    routing.markOutcomePersistenceFailure('old-owner');
    const lifecycle = createReviewLifecycle({
      backend: backend(),
      registry,
      lookupSessionProvider: routing.lookupProvider,
      lookupResultSession: routing.lookupResultSession,
      storage: { db: {} as Database.Database, durability: 'durable', warning: null },
      recordOutcome: vi.fn().mockResolvedValue(ok(undefined)),
      onOutcomePersistenceFailure: routing.markOutcomePersistenceFailure,
      onOutcomePersisted: routing.markOutcomePersisted,
    });

    const result = await lifecycle.reviewPlan({ plan: 'transition', session_id: 'old-owner' });
    expect(result.ok).toBe(true);

    now = 11;
    expect(routing.lookupProvider('unrelated')).toEqual({ status: 'absent' });
  });

  it('drops a provisional same-id registry owner after a transactional routing conflict', async () => {
    const registry = createSessionRegistry();
    registry.complete(undefined, 'shared', 'codex', MODEL);
    const routing = createSessionRouting({
      registry,
      durability: 'durable',
      providerLookup: () => ({ status: 'found', value: 'gemini' }),
      modelLookup: () => ({ status: 'absent' }),
    });
    const lifecycle = createReviewLifecycle({
      backend: backend({
        providers: ['codex', 'gemini'],
        reviewPlan: vi.fn().mockResolvedValue(ok({ ...PLAN_RESULT, session_id: 'shared' })),
      }),
      registry,
      lookupSessionProvider: routing.lookupProvider,
      lookupResultSession: routing.lookupResultSession,
      storage: { db: {} as Database.Database, durability: 'durable', warning: null },
      recordOutcome: vi
        .fn()
        .mockResolvedValue(
          err('SESSION_ROUTING_UNAVAILABLE: result session owner changed during persistence'),
        ),
    });

    const result = await lifecycle.reviewPlan({ plan: 'resume', session_id: 'shared' });

    expect(result.ok).toBe(false);
    expect(registry.getStatus('shared')).toBeNull();
    expect(routing.lookupProvider('shared')).toEqual({ status: 'found', value: 'gemini' });
  });

  it('rejects fresh reuse of an evicted unpersisted id while allowing another fresh id', async () => {
    let now = 0;
    const registry = createSessionRegistry({ ttlMs: 10, now: () => now });
    const routing = createSessionRouting({
      registry,
      durability: 'durable',
      providerLookup: () => ({ status: 'absent' }),
      modelLookup: () => ({ status: 'absent' }),
      tombstoneTtlMs: 100,
      now: () => now,
    });
    const reviewPlan = vi
      .fn()
      .mockResolvedValueOnce(ok({ ...PLAN_RESULT, session_id: 'reused' }))
      .mockResolvedValueOnce(ok({ ...PLAN_RESULT, session_id: 'reused' }))
      .mockResolvedValueOnce(ok({ ...PLAN_RESULT, session_id: 'unrelated' }));
    const recordOutcome = vi
      .fn()
      .mockResolvedValueOnce(err('STORAGE_ERROR: injected write failure'))
      .mockResolvedValueOnce(ok(undefined));
    const lifecycle = createReviewLifecycle({
      backend: backend({ reviewPlan }),
      registry,
      lookupSessionProvider: routing.lookupProvider,
      lookupResultSession: routing.lookupResultSession,
      storage: { db: {} as Database.Database, durability: 'durable', warning: null },
      recordOutcome,
      onOutcomePersistenceFailure: routing.markOutcomePersistenceFailure,
      onOutcomePersisted: routing.markOutcomePersisted,
    });

    const first = await lifecycle.reviewPlan({ plan: 'first' });
    expect(first.ok && first.data.provenance?.persistence).toBe('memory_only');
    now = 11;

    const reused = await lifecycle.reviewPlan({ plan: 'reuse' });
    expect(reused.ok).toBe(false);
    if (!reused.ok) expect(reused.error).toMatch(/^SESSION_ROUTING_UNAVAILABLE:/);

    const unrelated = await lifecycle.reviewPlan({ plan: 'unrelated' });
    expect(unrelated.ok && unrelated.data.provenance?.persistence).toBe('durable');
    expect(recordOutcome).toHaveBeenCalledTimes(2);
  });

  it('marks configured in-memory storage honestly even when its transaction succeeds', async () => {
    const lifecycle = createReviewLifecycle({
      backend: backend(),
      registry: createSessionRegistry(),
      lookupSessionProvider: () => ({ status: 'absent' }),
      storage: {
        db: {} as Database.Database,
        durability: 'memory_only',
        warning: 'raw initialization details',
      },
      recordOutcome: vi.fn().mockResolvedValue(ok(undefined)),
    });

    const result = await lifecycle.reviewPlan({ plan: 'plan' });
    expect(result.ok && result.data.provenance).toEqual({
      persistence: 'memory_only',
      warning: 'Durable review history is unavailable; session state is being kept in memory only.',
    });
  });

  it('resolves synthetic empty results before admission and does not persist them', async () => {
    const registry = createSessionRegistry({ maxActive: 1 });
    const syntheticBackend = backend({
      reviewCode: vi.fn().mockResolvedValue(
        ok({
          verdict: 'approve',
          summary: 'No changes to review.',
          findings: [],
          session_id: 'synthetic',
          models: [],
        }),
      ),
    });
    const recordOutcome = vi.fn();
    const lifecycle = createReviewLifecycle({
      backend: syntheticBackend,
      registry,
      lookupSessionProvider: () => ({ status: 'unavailable' }),
      storage: { db: {} as Database.Database, durability: 'durable', warning: null },
      recordOutcome,
    });

    const result = await lifecycle.reviewCode({ diff: '', session_id: 'unroutable' });

    expect(result.ok && result.data.models).toEqual([]);
    expect(result.ok && result.data.provenance).toEqual({
      persistence: 'not_recorded',
      warning: null,
    });
    expect(registry.activeCount()).toBe(0);
    expect(registry.getStatus('unroutable')).toBeNull();
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it('rejects same-session overlap across different review tools', async () => {
    const pending = deferred<ReturnType<typeof ok<PlanReviewResult>>>();
    const client = backend({ reviewPlan: vi.fn(() => pending.promise) });
    const lifecycle = createReviewLifecycle({
      backend: client,
      registry: createSessionRegistry(),
      lookupSessionProvider: () => ({ status: 'absent' }),
    });

    const first = lifecycle.reviewPlan({ plan: 'plan', session_id: 'shared' });
    const overlap = await lifecycle.reviewCode({ diff: 'short', session_id: 'shared' });

    expect(overlap.ok).toBe(false);
    if (!overlap.ok) expect(overlap.error).toMatch(/^REVIEW_BUSY:/);
    pending.resolve(ok({ ...PLAN_RESULT, session_id: 'shared' }));
    await first;
  });

  it('allows four different reviews, rejects the fifth, and releases admission after completion', async () => {
    const pending = Array.from({ length: 4 }, () =>
      deferred<ReturnType<typeof ok<PlanReviewResult>>>(),
    );
    let call = 0;
    const client = backend({
      reviewPlan: vi.fn(() => pending[call++]?.promise ?? Promise.resolve(ok(PLAN_RESULT))),
    });
    const registry = createSessionRegistry();
    const lifecycle = createReviewLifecycle({
      backend: client,
      registry,
      lookupSessionProvider: () => ({ status: 'absent' }),
    });
    const running = ['a', 'b', 'c', 'd'].map((session_id) =>
      lifecycle.reviewPlan({ plan: 'plan', session_id }),
    );

    const fifth = await lifecycle.reviewPlan({ plan: 'plan', session_id: 'e' });
    expect(fifth.ok).toBe(false);
    if (!fifth.ok) expect(fifth.error).toMatch(/^REVIEW_BUSY:/);

    pending.forEach((entry, index) =>
      entry.resolve(ok({ ...PLAN_RESULT, session_id: ['a', 'b', 'c', 'd'][index] })),
    );
    await Promise.all(running);
    expect(registry.activeCount()).toBe(0);
    expect((await lifecycle.reviewPlan({ plan: 'next', session_id: 'e' })).ok).toBe(true);
  });

  it('returns a sanitized error and releases admission when a provider throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const registry = createSessionRegistry();
    const lifecycle = createReviewLifecycle({
      backend: backend({
        reviewPlan: vi
          .fn()
          .mockRejectedValue(new Error('boom at /Users/alice/private.ts\nsecret=do-not-leak')),
      }),
      registry,
      lookupSessionProvider: () => ({ status: 'absent' }),
    });

    const result = await lifecycle.reviewPlan({ plan: 'plan', session_id: 's1' });

    expect(result).toEqual({
      ok: false,
      error: `${ErrorCode.UNKNOWN_ERROR}: review failed unexpectedly`,
    });
    expect(!result.ok && result.error).not.toContain('/Users/alice');
    expect(!result.ok && result.error).not.toContain('do-not-leak');
    expect(log).toHaveBeenCalledWith('[codex-bridge] review failed unexpectedly');
    expect(log.mock.calls.flat().join(' ')).not.toContain('do-not-leak');
    expect(registry.activeCount()).toBe(0);
    expect(registry.getStatus('s1')?.status).toBe('failed');
    log.mockRestore();
  });

  it('rejects unavailable ownership before calling any provider', async () => {
    const client = backend();
    const lifecycle = createReviewLifecycle({
      backend: client,
      registry: createSessionRegistry(),
      lookupSessionProvider: () => ({ status: 'unavailable' }),
    });

    const result = await lifecycle.reviewPlan({ plan: 'plan', session_id: 's1' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^SESSION_ROUTING_UNAVAILABLE:/);
    expect(client.reviewPlan).not.toHaveBeenCalled();
  });

  it('allows a Gemini-owned failed-over session to change model under a Codex-primary composite', async () => {
    const reviewPlan = vi.fn().mockResolvedValue(
      ok({
        ...PLAN_RESULT,
        session_id: 'failed-over',
        provider: 'gemini' as const,
        models: [GEMINI_MODEL],
      }),
    );
    const client = backend({
      provider: 'codex',
      providers: ['codex', 'gemini'],
      allowsModelOverrideOnResume: false,
      allowsModelOverrideOnResumeFor: (provider) => provider === 'gemini',
      reviewPlan,
    });
    const lifecycle = createReviewLifecycle({
      backend: client,
      registry: createSessionRegistry(),
      lookupSessionProvider: () => ({ status: 'found', value: 'gemini' }),
    });

    const result = await lifecycle.reviewPlan({
      plan: 'plan',
      session_id: 'failed-over',
      model: 'Gemini 3.1 Pro (High)',
    });

    expect(result.ok).toBe(true);
    expect(reviewPlan).toHaveBeenCalledOnce();
  });

  it('rejects a Codex-owned model override under a Gemini-primary composite without mutating registry state', async () => {
    const registry = createSessionRegistry();
    registry.complete(undefined, 'codex-owned', 'codex', MODEL);
    const before = registry.getStatus('codex-owned');
    const reviewPlan = vi.fn();
    const client = backend({
      provider: 'gemini',
      providers: ['gemini', 'codex'],
      allowsModelOverrideOnResume: true,
      allowsModelOverrideOnResumeFor: (provider) => provider === 'gemini',
      reviewPlan,
    });
    const lifecycle = createReviewLifecycle({
      backend: client,
      registry,
      lookupSessionProvider: () => ({ status: 'found', value: 'codex' }),
    });

    const result = await lifecycle.reviewPlan({
      plan: 'plan',
      session_id: 'codex-owned',
      model: 'gpt-5.5',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^INVALID_INPUT:/);
    expect(reviewPlan).not.toHaveBeenCalled();
    expect(registry.getStatus('codex-owned')).toEqual(before);
    expect(registry.activeCount()).toBe(0);
  });
});

// Failure must reach SQLite, not only the in-memory registry. A resumed review
// that fails on a session the database still records as `completed` would
// otherwise report success from review_status after a restart or eviction.
describe('failure persistence', () => {
  async function completedSessionDb(): Promise<Database.Database> {
    const { default: Sqlite } = await import('better-sqlite3');
    const { initSessionsDb, getOrCreateSession, markSessionCompleted } =
      await import('../storage/sessions.js');
    const db = new Sqlite(':memory:');
    initSessionsDb(db);
    getOrCreateSession(db, 'old-owner', 'codex');
    markSessionCompleted(db, 'old-owner');
    return db;
  }

  async function statusOf(db: Database.Database, id: string): Promise<string | undefined> {
    const { getSession } = await import('../storage/sessions.js');
    const row = getSession(db, id);
    return row.ok && row.data ? row.data.status : undefined;
  }

  it('marks a completed session failed in SQLite when its resumed review fails', async () => {
    const db = await completedSessionDb();
    const registry = createSessionRegistry();
    const lifecycle = createReviewLifecycle({
      backend: backend({
        reviewPlan: vi.fn().mockResolvedValue(err('MODEL_ERROR: boom', 'old-owner')),
      }),
      registry,
      lookupSessionProvider: () => ({ status: 'found', value: 'codex' }),
      storage: { db, durability: 'durable', warning: null },
      recordOutcome: vi.fn(),
    });

    const result = await lifecycle.reviewPlan({ plan: 'plan', session_id: 'old-owner' });

    expect(result.ok).toBe(false);
    expect(await statusOf(db, 'old-owner')).toBe('failed');
  });

  it('also persists the failure when the provider throws', async () => {
    const db = await completedSessionDb();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lifecycle = createReviewLifecycle({
      backend: backend({ reviewPlan: vi.fn().mockRejectedValue(new Error('crash')) }),
      registry: createSessionRegistry(),
      lookupSessionProvider: () => ({ status: 'found', value: 'codex' }),
      storage: { db, durability: 'durable', warning: null },
      recordOutcome: vi.fn(),
    });

    const result = await lifecycle.reviewPlan({ plan: 'plan', session_id: 'old-owner' });

    expect(result.ok).toBe(false);
    expect(await statusOf(db, 'old-owner')).toBe('failed');
    consoleSpy.mockRestore();
  });

  it('records a failed FRESH review under the session id the provider returned', async () => {
    const db = await completedSessionDb();
    const lifecycle = createReviewLifecycle({
      backend: backend({
        reviewPlan: vi.fn().mockResolvedValue(err('MODEL_ERROR: boom', 'fresh-partial')),
      }),
      registry: createSessionRegistry(),
      lookupSessionProvider: () => ({ status: 'absent' }),
      storage: { db, durability: 'durable', warning: null },
      recordOutcome: vi.fn(),
    });

    await lifecycle.reviewPlan({ plan: 'plan' });

    expect(await statusOf(db, 'fresh-partial')).toBe('failed');
  });

  it('writes nothing when storage is memory-only', async () => {
    const db = await completedSessionDb();
    const lifecycle = createReviewLifecycle({
      backend: backend({
        reviewPlan: vi.fn().mockResolvedValue(err('MODEL_ERROR: boom', 'old-owner')),
      }),
      registry: createSessionRegistry(),
      lookupSessionProvider: () => ({ status: 'found', value: 'codex' }),
      storage: { db, durability: 'memory_only', warning: null },
      recordOutcome: vi.fn(),
    });

    await lifecycle.reviewPlan({ plan: 'plan', session_id: 'old-owner' });

    expect(await statusOf(db, 'old-owner')).toBe('completed');
  });
});
