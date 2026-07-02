import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionTracker, checkSessionProvider } from './session-tracker.js';
import { ok, err, ErrorCode } from '../utils/errors.js';

vi.mock('./reviews.js', () => ({
  saveReview: vi.fn(),
}));

vi.mock('./sessions.js', () => ({
  activateSession: vi.fn(),
  getOrCreateSession: vi.fn(),
  getSession: vi.fn(),
  markSessionCompleted: vi.fn(),
  markSessionFailed: vi.fn(),
}));

import { saveReview } from './reviews.js';
import { activateSession, getOrCreateSession, getSession, markSessionCompleted, markSessionFailed } from './sessions.js';

// Minimal db stub: transaction(fn) returns a callable that invokes fn — matches
// better-sqlite3's API surface that recordSuccess relies on for atomicity.
const mockDb = {
  transaction: <T>(fn: () => T) => () => fn(),
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(activateSession).mockReturnValue(ok({ session_id: 'sess_1', status: 'in_progress' as const, created_at: '2026-01-01', completed_at: null, provider: null }));
  vi.mocked(getOrCreateSession).mockReturnValue(ok({ session_id: 'sess_1', status: 'in_progress' as const, created_at: '2026-01-01', completed_at: null, provider: null }));
  vi.mocked(getSession).mockReturnValue(ok(null));
  vi.mocked(markSessionCompleted).mockReturnValue(ok(undefined));
  vi.mocked(markSessionFailed).mockReturnValue(ok(undefined));
  vi.mocked(saveReview).mockReturnValue(ok(undefined));
});

const review = {
  session_id: 'sess_1',
  type: 'plan' as const,
  verdict: 'approve',
  summary: 'Looks good',
  findings_json: '[]',
};

describe('checkSessionProvider — cross-provider guard (read-only, fail-open)', () => {
  const row = (provider: string | null) =>
    ok({ session_id: 's', status: 'completed' as const, created_at: 'x', completed_at: 'y', provider });

  it('fails open when db is undefined', () => {
    expect(checkSessionProvider(undefined, 's', ['codex']).ok).toBe(true);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('fails open when sessionId is undefined', () => {
    expect(checkSessionProvider(mockDb, undefined, ['codex']).ok).toBe(true);
  });

  it('fails open when the session is unknown (no row)', () => {
    vi.mocked(getSession).mockReturnValue(ok(null));
    expect(checkSessionProvider(mockDb, 's', ['codex']).ok).toBe(true);
  });

  it('fails open on a legacy row with a null provider', () => {
    vi.mocked(getSession).mockReturnValue(row(null));
    expect(checkSessionProvider(mockDb, 's', ['codex']).ok).toBe(true);
  });

  it('fails open on a storage read error', () => {
    vi.mocked(getSession).mockReturnValue(err(`${ErrorCode.STORAGE_ERROR}: boom`));
    expect(checkSessionProvider(mockDb, 's', ['codex']).ok).toBe(true);
  });

  it('rejects when the owner is not among the active providers', () => {
    vi.mocked(getSession).mockReturnValue(row('gemini'));
    const res = checkSessionProvider(mockDb, 's', ['codex']);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain(ErrorCode.PROVIDER_MISMATCH);
      expect(res.error).toContain('gemini');
    }
  });

  it('allows when the owner is a member of the active providers (composite)', () => {
    vi.mocked(getSession).mockReturnValue(row('gemini'));
    expect(checkSessionProvider(mockDb, 's', ['codex', 'gemini']).ok).toBe(true);
  });

  it('allows when the owner matches a single active provider', () => {
    vi.mocked(getSession).mockReturnValue(row('codex'));
    expect(checkSessionProvider(mockDb, 's', ['codex']).ok).toBe(true);
  });
});

describe('createSessionTracker — null tracker (no db)', () => {
  it('all methods are no-ops', () => {
    const tracker = createSessionTracker(undefined, ['codex'], 'codex');
    tracker.preflight('sess_1');
    tracker.recordSuccess('sess_1', review);
    tracker.recordFailure();
    tracker.recordFailureBestEffort();

    expect(activateSession).not.toHaveBeenCalled();
    expect(getOrCreateSession).not.toHaveBeenCalled();
    expect(saveReview).not.toHaveBeenCalled();
    expect(markSessionCompleted).not.toHaveBeenCalled();
    expect(markSessionFailed).not.toHaveBeenCalled();
  });
});

describe('createSessionTracker — with db', () => {
  it('preflight calls activateSession', () => {
    const tracker = createSessionTracker(mockDb, ['codex'], 'codex');
    tracker.preflight('sess_1');

    expect(activateSession).toHaveBeenCalledWith(mockDb, 'sess_1', 'codex');
  });

  it('preflight skips when sessionId is undefined', () => {
    const tracker = createSessionTracker(mockDb, ['codex'], 'codex');
    tracker.preflight(undefined);

    expect(activateSession).not.toHaveBeenCalled();
  });

  it('preflight does not set tracking ID when activateSession fails', () => {
    vi.mocked(activateSession).mockReturnValue(err('STORAGE_ERROR: readonly'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const tracker = createSessionTracker(mockDb, ['codex'], 'codex');
    tracker.preflight('sess_1');
    tracker.recordFailure();

    expect(markSessionFailed).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('recordSuccess without preflight calls getOrCreateSession + saveReview + markSessionCompleted', () => {
    const tracker = createSessionTracker(mockDb, ['codex'], 'codex');
    tracker.recordSuccess('sess_1', review);

    expect(getOrCreateSession).toHaveBeenCalledWith(mockDb, 'sess_1', 'codex');
    expect(saveReview).toHaveBeenCalledWith(mockDb, review);
    expect(markSessionCompleted).toHaveBeenCalledWith(mockDb, 'sess_1');
  });

  it('recordSuccess with preflight skips getOrCreateSession and uses preflightId for complete', () => {
    const tracker = createSessionTracker(mockDb, ['codex'], 'codex');
    tracker.preflight('sess_preflight');
    tracker.recordSuccess('sess_codex', review);

    expect(getOrCreateSession).not.toHaveBeenCalled();
    expect(saveReview).toHaveBeenCalledWith(mockDb, review);
    expect(markSessionCompleted).toHaveBeenCalledWith(mockDb, 'sess_preflight');
  });

  it('recordFailure calls markSessionFailed with preflightId', () => {
    const tracker = createSessionTracker(mockDb, ['codex'], 'codex');
    tracker.preflight('sess_1');
    tracker.recordFailure();

    expect(markSessionFailed).toHaveBeenCalledWith(mockDb, 'sess_1');
  });

  it('recordFailure is no-op without preflight', () => {
    const tracker = createSessionTracker(mockDb, ['codex'], 'codex');
    tracker.recordFailure();

    expect(markSessionFailed).not.toHaveBeenCalled();
  });

  it('recordFailureBestEffort swallows errors', () => {
    vi.mocked(markSessionFailed).mockImplementation(() => { throw new Error('db closed'); });

    const tracker = createSessionTracker(mockDb, ['codex'], 'codex');
    tracker.preflight('sess_1');

    expect(() => tracker.recordFailureBestEffort()).not.toThrow();
  });
});

describe('cross-provider resume guard', () => {
  const sessionRow = (provider: string | null) =>
    ok({
      session_id: 'sess_x',
      status: 'completed' as const,
      created_at: '2026-01-01',
      completed_at: '2026-01-02',
      provider,
    });

  it('rejects resuming a session created by a different provider', () => {
    vi.mocked(getSession).mockReturnValue(sessionRow('gemini'));
    const tracker = createSessionTracker(mockDb, ['codex'], 'codex');

    const result = tracker.preflight('sess_x');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('PROVIDER_MISMATCH');
      expect(result.error).toContain('gemini');
      expect(result.error).toContain('codex');
    }
    // A rejected resume must not mutate session state.
    expect(activateSession).not.toHaveBeenCalled();
  });

  it('allows resuming a session created by the same provider', () => {
    vi.mocked(getSession).mockReturnValue(sessionRow('codex'));
    const tracker = createSessionTracker(mockDb, ['codex'], 'codex');

    const result = tracker.preflight('sess_x');

    expect(result.ok).toBe(true);
    expect(activateSession).toHaveBeenCalledWith(mockDb, 'sess_x', 'codex');
  });

  it('allows resuming a legacy session with a null provider', () => {
    vi.mocked(getSession).mockReturnValue(sessionRow(null));
    const tracker = createSessionTracker(mockDb, ['gemini'], 'gemini');

    const result = tracker.preflight('sess_x');

    expect(result.ok).toBe(true);
    expect(activateSession).toHaveBeenCalledWith(mockDb, 'sess_x', 'gemini');
  });

  it('tags a freshly created session with the active provider', () => {
    const tracker = createSessionTracker(mockDb, ['gemini'], 'gemini');
    tracker.recordSuccess('sess_new', review);

    expect(getOrCreateSession).toHaveBeenCalledWith(mockDb, 'sess_new', 'gemini');
  });
});
