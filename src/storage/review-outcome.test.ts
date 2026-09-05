import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { initializeStorageSchema } from './db.js';
import { getReviewsBySession } from './reviews.js';
import { getOrCreateSession, getSession, markSessionCompleted } from './sessions.js';
import { recordReviewOutcome, recordReviewOutcomeWithRetry } from './review-outcome.js';
import type { RecordReviewOutcomeInput } from './review-outcome.js';

const OLD_MODEL = {
  provider: 'codex',
  role: 'review',
  requested: 'gpt-5.5',
  resolved: 'gpt-5.5',
  observed: 'gpt-5.5',
  evidence: 'runtime_session_record',
} as const;

const NEW_MODEL = {
  provider: 'codex',
  role: 'review',
  requested: null,
  resolved: 'gpt-5.6-sol',
  observed: 'gpt-5.6-sol',
  evidence: 'runtime_session_record',
} as const;

function input(overrides: Partial<RecordReviewOutcomeInput> = {}): RecordReviewOutcomeInput {
  return {
    resultSessionId: 'result-session',
    servingProvider: 'codex',
    ownerModelIdentity: NEW_MODEL,
    review: {
      session_id: 'result-session',
      type: 'plan' as const,
      verdict: 'approve',
      summary: 'complete',
      findings_json: '[]',
      models: [NEW_MODEL],
    },
    ...overrides,
  };
}

describe('recordReviewOutcome', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeStorageSchema(db);
  });

  afterEach(() => db.close());

  it('atomically creates, tags, snapshots, and completes a fresh session', () => {
    const result = recordReviewOutcome(db, input());

    expect(result.ok).toBe(true);
    const session = getSession(db, 'result-session');
    expect(session.ok && session.data).toMatchObject({
      status: 'completed',
      provider: 'codex',
      model_identity_json: JSON.stringify(NEW_MODEL),
    });
    const reviews = getReviewsBySession(db, 'result-session');
    expect(reviews.ok && reviews.data[0].models).toEqual([NEW_MODEL]);
  });

  it('merges known fields over unknown refresh fields', () => {
    getOrCreateSession(db, 'result-session', 'codex', JSON.stringify(OLD_MODEL));

    const result = recordReviewOutcome(
      db,
      input({
        preflightSessionId: 'result-session',
        ownerModelIdentity: {
          ...OLD_MODEL,
          requested: null,
          resolved: null,
          observed: null,
          evidence: 'unavailable',
        },
      }),
    );

    expect(result.ok).toBe(true);
    const stored = db
      .prepare('SELECT model_identity_json FROM sessions WHERE session_id = ?')
      .get('result-session') as { model_identity_json: string };
    expect(JSON.parse(stored.model_identity_json)).toMatchObject({
      requested: 'gpt-5.5',
      resolved: 'gpt-5.5',
      observed: 'gpt-5.5',
      evidence: 'runtime_session_record',
    });
  });

  it('never merges fields from a stored identity owned by another provider', () => {
    getOrCreateSession(
      db,
      'result-session',
      'codex',
      JSON.stringify({ ...OLD_MODEL, provider: 'gemini', resolved: 'Gemini foreign model' }),
    );
    const unknownCodex = {
      ...NEW_MODEL,
      requested: null,
      resolved: null,
      observed: null,
      evidence: 'unavailable',
    } as const;

    const result = recordReviewOutcome(
      db,
      input({
        preflightSessionId: 'result-session',
        ownerModelIdentity: unknownCodex,
      }),
    );

    expect(result.ok).toBe(true);
    const stored = db
      .prepare('SELECT model_identity_json FROM sessions WHERE session_id = ?')
      .get('result-session') as { model_identity_json: string };
    expect(JSON.parse(stored.model_identity_json)).toEqual(unknownCodex);
    expect(stored.model_identity_json).not.toContain('Gemini foreign model');
  });

  it('allows a successful provider resume to replace known model fields', () => {
    getOrCreateSession(
      db,
      'result-session',
      'gemini',
      JSON.stringify({ ...OLD_MODEL, provider: 'gemini' }),
    );

    const geminiNew = {
      ...NEW_MODEL,
      provider: 'gemini',
      observed: null,
      evidence: 'bridge_selection',
    } as const;
    const result = recordReviewOutcome(
      db,
      input({
        preflightSessionId: 'result-session',
        servingProvider: 'gemini',
        ownerModelIdentity: geminiNew,
      }),
    );

    expect(result.ok).toBe(true);
    const stored = db
      .prepare('SELECT model_identity_json FROM sessions WHERE session_id = ?')
      .get('result-session') as { model_identity_json: string };
    expect(JSON.parse(stored.model_identity_json).resolved).toBe('gpt-5.6-sol');
  });

  it('rejects and rolls back when a survivor session is already owned by another provider', () => {
    getOrCreateSession(db, 'result-session', 'codex', JSON.stringify(OLD_MODEL));
    markSessionCompleted(db, 'result-session');
    const before = getSession(db, 'result-session');
    const geminiModel = {
      ...NEW_MODEL,
      provider: 'gemini',
      observed: null,
      evidence: 'bridge_selection',
    } as const;

    const result = recordReviewOutcome(
      db,
      input({ servingProvider: 'gemini', ownerModelIdentity: geminiModel }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^SESSION_ROUTING_UNAVAILABLE:/);
    expect(getSession(db, 'result-session')).toEqual(before);
    expect(getReviewsBySession(db, 'result-session')).toMatchObject({ ok: true, data: [] });
  });

  it('rejects invalid serving providers and contradictory owner identities at the transaction boundary', () => {
    const invalidProvider = recordReviewOutcome(
      db,
      input({ servingProvider: 'future-provider' as never }),
    );
    const wrongProviderIdentity = recordReviewOutcome(
      db,
      input({ ownerModelIdentity: { ...NEW_MODEL, provider: 'gemini' } }),
    );
    const wrongRoleIdentity = recordReviewOutcome(
      db,
      input({ ownerModelIdentity: { ...NEW_MODEL, role: 'adjudication' } }),
    );

    for (const result of [invalidProvider, wrongProviderIdentity, wrongRoleIdentity]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/^STORAGE_ERROR:/);
    }
    expect(getSession(db, 'result-session')).toEqual({ ok: true, data: null });
    expect(getReviewsBySession(db, 'result-session')).toMatchObject({ ok: true, data: [] });
  });

  it('fails the old owner and completes/attaches history to a different survivor session', () => {
    getOrCreateSession(db, 'old-owner', 'codex', JSON.stringify(OLD_MODEL));
    markSessionCompleted(db, 'old-owner');

    const result = recordReviewOutcome(
      db,
      input({
        preflightSessionId: 'old-owner',
        preflightProvider: 'codex',
        resultSessionId: 'survivor',
      }),
    );

    expect(result.ok).toBe(true);
    expect(getSession(db, 'old-owner')).toMatchObject({ ok: true, data: { status: 'failed' } });
    expect(getSession(db, 'survivor')).toMatchObject({
      ok: true,
      data: { status: 'completed', provider: 'codex' },
    });
    const survivorReviews = getReviewsBySession(db, 'survivor');
    expect(survivorReviews.ok && survivorReviews.data).toHaveLength(1);
    const oldReviews = getReviewsBySession(db, 'old-owner');
    expect(oldReviews.ok && oldReviews.data).toEqual([]);
  });

  it('creates an absent preflight owner as failed with the attempted provider', () => {
    const result = recordReviewOutcome(
      db,
      input({
        preflightSessionId: 'absent-owner',
        preflightProvider: 'gemini',
        resultSessionId: 'survivor',
      }),
    );

    expect(result.ok).toBe(true);
    expect(getSession(db, 'absent-owner')).toMatchObject({
      ok: true,
      data: { status: 'failed', provider: 'gemini' },
    });
  });

  it('rejects a conflicting preflight owner transactionally', () => {
    getOrCreateSession(db, 'old-owner', 'gemini');
    const before = getSession(db, 'old-owner');

    const result = recordReviewOutcome(
      db,
      input({
        preflightSessionId: 'old-owner',
        preflightProvider: 'codex',
        resultSessionId: 'survivor',
      }),
    );

    expect(result.ok).toBe(false);
    expect(getSession(db, 'old-owner')).toEqual(before);
    expect(getSession(db, 'survivor')).toEqual({ ok: true, data: null });
    expect(getReviewsBySession(db, 'survivor')).toMatchObject({ ok: true, data: [] });
  });

  it('rejects a fresh result id that already exists even under the same provider', () => {
    getOrCreateSession(db, 'survivor', 'codex', JSON.stringify(OLD_MODEL));
    markSessionCompleted(db, 'survivor');
    const before = getSession(db, 'survivor');

    const result = recordReviewOutcome(
      db,
      input({
        preflightSessionId: 'old-owner',
        preflightProvider: 'codex',
        resultSessionId: 'survivor',
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^SESSION_ROUTING_UNAVAILABLE:/);
    expect(getSession(db, 'survivor')).toEqual(before);
    expect(getSession(db, 'old-owner')).toEqual({ ok: true, data: null });
    expect(getReviewsBySession(db, 'survivor')).toMatchObject({ ok: true, data: [] });
  });

  it('rolls back an identity update when the review insert fails', () => {
    getOrCreateSession(db, 'result-session', 'codex', JSON.stringify(OLD_MODEL));
    db.exec(`
      CREATE TRIGGER fail_review_insert
      BEFORE INSERT ON reviews
      BEGIN
        SELECT RAISE(ABORT, 'injected review failure');
      END;
    `);

    const result = recordReviewOutcome(db, input({ preflightSessionId: 'result-session' }));

    expect(result.ok).toBe(false);
    const stored = db
      .prepare('SELECT model_identity_json FROM sessions WHERE session_id = ?')
      .get('result-session') as { model_identity_json: string };
    expect(stored.model_identity_json).toBe(JSON.stringify(OLD_MODEL));
    expect(db.prepare('SELECT COUNT(*) AS count FROM reviews').get()).toEqual({ count: 0 });
  });

  it('rolls back when the result-session upsert fails', () => {
    getOrCreateSession(db, 'old-owner', 'codex', JSON.stringify(OLD_MODEL));
    const before = getSession(db, 'old-owner');
    db.exec(`
      CREATE TRIGGER fail_result_session_upsert
      BEFORE INSERT ON sessions
      WHEN NEW.session_id = 'survivor'
      BEGIN
        SELECT RAISE(ABORT, 'injected result-session failure');
      END;
    `);

    const result = recordReviewOutcome(
      db,
      input({
        preflightSessionId: 'old-owner',
        preflightProvider: 'codex',
        resultSessionId: 'survivor',
      }),
    );

    expect(result.ok).toBe(false);
    expect(getSession(db, 'old-owner')).toEqual(before);
    expect(getSession(db, 'survivor')).toEqual({ ok: true, data: null });
    expect(db.prepare('SELECT COUNT(*) AS count FROM reviews').get()).toEqual({ count: 0 });
  });

  it('rolls back the new survivor when marking the prior owner failed errors', () => {
    getOrCreateSession(db, 'old-owner', 'codex', JSON.stringify(OLD_MODEL));
    const before = getSession(db, 'old-owner');
    db.exec(`
      CREATE TRIGGER fail_prior_owner_update
      BEFORE UPDATE OF status ON sessions
      WHEN OLD.session_id = 'old-owner' AND NEW.status = 'failed'
      BEGIN
        SELECT RAISE(ABORT, 'injected prior-owner failure');
      END;
    `);

    const result = recordReviewOutcome(
      db,
      input({
        preflightSessionId: 'old-owner',
        preflightProvider: 'codex',
        resultSessionId: 'survivor',
      }),
    );

    expect(result.ok).toBe(false);
    expect(getSession(db, 'old-owner')).toEqual(before);
    expect(getSession(db, 'survivor')).toEqual({ ok: true, data: null });
    expect(db.prepare('SELECT COUNT(*) AS count FROM reviews').get()).toEqual({ count: 0 });
  });

  it('rolls back the identity and review insert when final completion fails', () => {
    db.exec(`
      CREATE TRIGGER fail_completion
      BEFORE UPDATE OF status ON sessions
      WHEN NEW.status = 'completed'
      BEGIN
        SELECT RAISE(ABORT, 'injected completion failure');
      END;
    `);

    const result = recordReviewOutcome(db, input());

    expect(result.ok).toBe(false);
    expect(getSession(db, 'result-session')).toEqual({ ok: true, data: null });
    expect(db.prepare('SELECT COUNT(*) AS count FROM reviews').get()).toEqual({ count: 0 });
  });

  it('rolls back every mutation when COMMIT itself fails', () => {
    const exec = db.exec.bind(db);
    vi.spyOn(db, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT') throw new Error('injected commit failure');
      return exec(sql);
    });
    const result = recordReviewOutcome(db, input());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^STORAGE_ERROR:/);
    expect(db.inTransaction).toBe(false);
    expect(getSession(db, 'result-session')).toEqual({ ok: true, data: null });
    expect(db.prepare('SELECT COUNT(*) AS count FROM reviews').get()).toEqual({ count: 0 });
  });
});

describe('recordReviewOutcomeWithRetry', () => {
  let dbPath: string;
  let writer: Database.Database;
  let locker: Database.Database;

  beforeEach(() => {
    dbPath = join(tmpdir(), `review-outcome-${process.pid}-${Date.now()}.db`);
    writer = new Database(dbPath, { timeout: 100 });
    locker = new Database(dbPath, { timeout: 100 });
    writer.pragma('busy_timeout = 100');
    locker.pragma('busy_timeout = 100');
    initializeStorageSchema(writer);
  });

  afterEach(() => {
    if (locker.inTransaction) locker.exec('ROLLBACK');
    writer.close();
    locker.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(dbPath + suffix);
      } catch {
        /* ignore */
      }
    }
  });

  it('retries SQLITE_BUSY exactly once after yielding, then succeeds', async () => {
    locker.exec('BEGIN IMMEDIATE');
    const sleep = vi.fn(async () => {
      locker.exec('COMMIT');
    });

    const result = await recordReviewOutcomeWithRetry(writer, input(), { sleep });

    expect(result.ok).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it('does not retry a non-busy storage error', async () => {
    writer.exec(`
      CREATE TRIGGER fail_review_insert
      BEFORE INSERT ON reviews
      BEGIN
        SELECT RAISE(ABORT, 'permanent');
      END;
    `);
    const sleep = vi.fn(async () => {});

    const result = await recordReviewOutcomeWithRetry(writer, input(), { sleep });

    expect(result.ok).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
  });
});
