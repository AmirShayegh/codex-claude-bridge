import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionTracker } from './session-tracker.js';
import { ok, err } from '../utils/errors.js';

vi.mock('./reviews.js', () => ({
  saveReview: vi.fn(),
}));

vi.mock('./sessions.js', () => ({
  activateSession: vi.fn(),
  getOrCreateSession: vi.fn(),
  markSessionCompleted: vi.fn(),
  markSessionFailed: vi.fn(),
}));

import { saveReview } from './reviews.js';
import { activateSession, getOrCreateSession, markSessionCompleted, markSessionFailed } from './sessions.js';

const mockDb = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(activateSession).mockReturnValue(ok({ session_id: 'sess_1', status: 'in_progress' as const, created_at: '2026-01-01', completed_at: null }));
  vi.mocked(getOrCreateSession).mockReturnValue(ok({ session_id: 'sess_1', status: 'in_progress' as const, created_at: '2026-01-01', completed_at: null }));
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

describe('createSessionTracker — null tracker (no db)', () => {
  it('all methods are no-ops', () => {
    const tracker = createSessionTracker(undefined);
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
    const tracker = createSessionTracker(mockDb);
    tracker.preflight('sess_1');

    expect(activateSession).toHaveBeenCalledWith(mockDb, 'sess_1');
  });

  it('preflight skips when sessionId is undefined', () => {
    const tracker = createSessionTracker(mockDb);
    tracker.preflight(undefined);

    expect(activateSession).not.toHaveBeenCalled();
  });

  it('preflight does not set tracking ID when activateSession fails', () => {
    vi.mocked(activateSession).mockReturnValue(err('STORAGE_ERROR: readonly'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const tracker = createSessionTracker(mockDb);
    tracker.preflight('sess_1');
    tracker.recordFailure();

    expect(markSessionFailed).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('recordSuccess without preflight calls getOrCreateSession + saveReview + markSessionCompleted', () => {
    const tracker = createSessionTracker(mockDb);
    tracker.recordSuccess('sess_1', review);

    expect(getOrCreateSession).toHaveBeenCalledWith(mockDb, 'sess_1');
    expect(saveReview).toHaveBeenCalledWith(mockDb, review);
    expect(markSessionCompleted).toHaveBeenCalledWith(mockDb, 'sess_1');
  });

  it('recordSuccess with preflight skips getOrCreateSession and uses preflightId for complete', () => {
    const tracker = createSessionTracker(mockDb);
    tracker.preflight('sess_preflight');
    tracker.recordSuccess('sess_codex', review);

    expect(getOrCreateSession).not.toHaveBeenCalled();
    expect(saveReview).toHaveBeenCalledWith(mockDb, review);
    expect(markSessionCompleted).toHaveBeenCalledWith(mockDb, 'sess_preflight');
  });

  it('recordFailure calls markSessionFailed with preflightId', () => {
    const tracker = createSessionTracker(mockDb);
    tracker.preflight('sess_1');
    tracker.recordFailure();

    expect(markSessionFailed).toHaveBeenCalledWith(mockDb, 'sess_1');
  });

  it('recordFailure is no-op without preflight', () => {
    const tracker = createSessionTracker(mockDb);
    tracker.recordFailure();

    expect(markSessionFailed).not.toHaveBeenCalled();
  });

  it('recordFailureBestEffort swallows errors', () => {
    vi.mocked(markSessionFailed).mockImplementation(() => { throw new Error('db closed'); });

    const tracker = createSessionTracker(mockDb);
    tracker.preflight('sess_1');

    expect(() => tracker.recordFailureBestEffort()).not.toThrow();
  });
});
