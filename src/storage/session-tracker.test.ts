import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionTracker, checkSessionProvider } from './session-tracker.js';
import { ok, err, ErrorCode } from '../utils/errors.js';

vi.mock('./review-outcome.js', () => ({
  recordReviewOutcome: vi.fn(),
}));

vi.mock('./sessions.js', () => ({
  getOrCreateSession: vi.fn(),
  getSessionProvider: vi.fn(),
  markSessionFailed: vi.fn(),
}));

import { recordReviewOutcome } from './review-outcome.js';
import { getOrCreateSession, getSessionProvider, markSessionFailed } from './sessions.js';

const mockDb = {
  transaction:
    <T>(fn: () => T) =>
    () =>
      fn(),
} as never;

const session = (provider: string | null) => ({
  session_id: 'sess_1',
  status: 'completed' as const,
  created_at: '2026-01-01',
  completed_at: '2026-01-02',
  provider,
  model_identity_json: null,
});

const review = {
  session_id: 'sess_1',
  type: 'plan' as const,
  verdict: 'approve',
  summary: 'Looks good',
  findings_json: '[]',
  models_json: '[]',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionProvider).mockReturnValue(ok(null));
  vi.mocked(getOrCreateSession).mockReturnValue(ok(session(null)));
  vi.mocked(markSessionFailed).mockReturnValue(ok(undefined));
  vi.mocked(recordReviewOutcome).mockReturnValue(ok(undefined));
});

describe('checkSessionProvider — safe resume ownership guard', () => {
  it('distinguishes unavailable lookup from absent or legacy ownership', () => {
    // No database at all fails open (CLI without a reviews.db, ISS-018); only a
    // database that exists but cannot be read is unavailable.
    expect(checkSessionProvider(undefined, 's', ['codex']).ok).toBe(true);
    expect(checkSessionProvider(mockDb, undefined, ['codex']).ok).toBe(true);
    expect(checkSessionProvider(mockDb, 's', ['codex']).ok).toBe(true);
    vi.mocked(getSessionProvider).mockReturnValue(ok({ provider: null }));
    expect(checkSessionProvider(mockDb, 's', ['codex']).ok).toBe(true);
    vi.mocked(getSessionProvider).mockReturnValue(err(`${ErrorCode.STORAGE_ERROR}: boom`));
    const readFailure = checkSessionProvider(mockDb, 's', ['codex']);
    expect(readFailure.ok).toBe(false);
    if (!readFailure.ok) {
      expect(readFailure.error).toContain(ErrorCode.SESSION_ROUTING_UNAVAILABLE);
    }
  });

  it('rejects a known foreign owner and allows an active owner', () => {
    vi.mocked(getSessionProvider).mockReturnValue(ok({ provider: 'gemini' }));
    const rejected = checkSessionProvider(mockDb, 's', ['codex']);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain(ErrorCode.PROVIDER_MISMATCH);

    expect(checkSessionProvider(mockDb, 's', ['codex', 'gemini']).ok).toBe(true);
  });

  it('treats an unrecognized stored owner as unavailable instead of guessing', () => {
    vi.mocked(getSessionProvider).mockReturnValue(ok({ provider: 'future-provider' }));

    const result = checkSessionProvider(mockDb, 's', ['codex', 'gemini']);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(ErrorCode.SESSION_ROUTING_UNAVAILABLE);
  });
});

describe('createSessionTracker', () => {
  it('uses a no-op Result-returning tracker without a database', () => {
    const tracker = createSessionTracker(undefined, ['codex'], 'codex');
    expect(tracker.preflight('sess_1')).toEqual(ok(undefined));
    expect(tracker.recordSuccess('sess_1', review)).toEqual(ok(undefined));
    tracker.recordFailure();
    tracker.recordFailureBestEffort();
    expect(recordReviewOutcome).not.toHaveBeenCalled();
    expect(markSessionFailed).not.toHaveBeenCalled();
  });

  it('preflight is read-only and does not durably activate or create the session', () => {
    const tracker = createSessionTracker(mockDb, ['codex'], 'codex');

    expect(tracker.preflight('sess_1')).toEqual(ok(undefined));

    expect(getSessionProvider).toHaveBeenCalledWith(mockDb, 'sess_1');
    expect(getOrCreateSession).not.toHaveBeenCalled();
    expect(markSessionFailed).not.toHaveBeenCalled();
  });

  it('passes preflight and returned ids to the atomic outcome operation', () => {
    vi.mocked(getSessionProvider).mockReturnValue(ok({ provider: 'codex' }));
    const tracker = createSessionTracker(mockDb, ['codex'], 'codex');
    tracker.preflight('owner');

    const result = tracker.recordSuccess('survivor', review, 'gemini', { provider: 'gemini' });

    expect(result).toEqual(ok(undefined));
    expect(recordReviewOutcome).toHaveBeenCalledWith(mockDb, {
      preflightSessionId: 'owner',
      preflightProvider: 'codex',
      resultSessionId: 'survivor',
      servingProvider: 'gemini',
      ownerModelIdentity: { provider: 'gemini' },
      review,
    });
  });

  it('returns a persistence error from recordSuccess to the caller', () => {
    vi.mocked(recordReviewOutcome).mockReturnValue(err('STORAGE_ERROR: readonly'));
    const tracker = createSessionTracker(mockDb, ['codex'], 'codex');

    expect(tracker.recordSuccess('sess_1', review)).toEqual(err('STORAGE_ERROR: readonly'));
  });

  it('rejects a foreign resume without remembering it for later mutation', () => {
    vi.mocked(getSessionProvider).mockReturnValue(ok({ provider: 'gemini' }));
    const tracker = createSessionTracker(mockDb, ['codex'], 'codex');

    expect(tracker.preflight('foreign').ok).toBe(false);
    tracker.recordFailure();

    expect(markSessionFailed).not.toHaveBeenCalled();
  });

  it('marks the preflight owner failed after a provider error without pre-activation', () => {
    vi.mocked(getSessionProvider).mockReturnValue(ok({ provider: 'codex' }));
    const tracker = createSessionTracker(mockDb, ['codex'], 'codex');
    tracker.preflight('owner');

    tracker.recordFailure();

    expect(getOrCreateSession).toHaveBeenCalledWith(mockDb, 'owner', 'codex');
    expect(markSessionFailed).toHaveBeenCalledWith(mockDb, 'owner');
  });

  it('atomically creates and fails a fresh partial provider session', () => {
    const transaction = vi.fn((fn: () => void) => fn);
    const dbWithTransaction = { transaction } as never;
    const tracker = createSessionTracker(dbWithTransaction, ['codex'], 'codex');

    tracker.recordFailure('partial-thread');

    expect(getOrCreateSession).toHaveBeenCalledWith(dbWithTransaction, 'partial-thread', 'codex');
    expect(markSessionFailed).toHaveBeenCalledWith(dbWithTransaction, 'partial-thread');
  });

  it('recordFailureBestEffort swallows a closed-db throw', () => {
    vi.mocked(getSessionProvider).mockReturnValue(ok({ provider: 'codex' }));
    vi.mocked(markSessionFailed).mockImplementation(() => {
      throw new Error('closed');
    });
    const tracker = createSessionTracker(mockDb, ['codex'], 'codex');
    tracker.preflight('owner');

    expect(() => tracker.recordFailureBestEffort()).not.toThrow();
    expect(getOrCreateSession).toHaveBeenCalledWith(mockDb, 'owner', 'codex');
  });
});
