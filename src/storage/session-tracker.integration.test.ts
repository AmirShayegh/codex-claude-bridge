import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { checkSessionProvider, createSessionTracker } from './session-tracker.js';
import { initSessionsDb, getOrCreateSession, getSession } from './sessions.js';
import { initDb } from './reviews.js';

// Real SQLite, no mocks. Reviews table is deliberately omitted so the outcome
// transaction fails after attempting session work.

describe('createSessionTracker — recordSuccess atomicity (T-002)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initSessionsDb(db);
  });

  afterEach(() => {
    db.close();
  });

  it('does not mark session completed when saveReview fails (preflight path)', () => {
    getOrCreateSession(db, 'sess_atomicity_preflight', 'codex');
    const tracker = createSessionTracker(db, ['codex'], 'codex');
    tracker.preflight('sess_atomicity_preflight');

    tracker.recordSuccess('sess_atomicity_preflight', {
      session_id: 'sess_atomicity_preflight',
      type: 'plan',
      verdict: 'approve',
      summary: 'should not persist',
      findings_json: '[]',
    });

    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('sess_atomicity_preflight') as { status: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.status).toBe('in_progress');
  });

  it('rolls back creation entirely when saveReview fails (fresh path)', () => {
    const tracker = createSessionTracker(db, ['codex'], 'codex');

    tracker.recordSuccess('sess_atomicity_fresh', {
      session_id: 'sess_atomicity_fresh',
      type: 'code',
      verdict: 'approve',
      summary: 'should not persist',
      findings_json: '[]',
    });

    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('sess_atomicity_fresh') as { status: string } | undefined;

    expect(row).toBeUndefined();
  });

  it('rolls back a best-effort failure row when the terminal status update fails', () => {
    db.exec(`
      CREATE TRIGGER fail_failed_status
      BEFORE UPDATE OF status ON sessions
      WHEN NEW.status = 'failed'
      BEGIN
        SELECT RAISE(ABORT, 'injected failure status error');
      END;
    `);
    const tracker = createSessionTracker(db, ['codex'], 'codex');
    tracker.preflight('sess_best_effort_atomic');

    expect(() => tracker.recordFailureBestEffort()).not.toThrow();

    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('sess_best_effort_atomic');
    expect(row).toBeUndefined();
  });
});

describe('createSessionTracker — cross-provider resume guard (T-017)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initSessionsDb(db);
    initDb(db);
  });

  afterEach(() => {
    db.close();
  });

  it('rejects resuming a gemini session under codex and leaves the row untouched', () => {
    // Seed a real gemini-tagged session, then resume it under codex.
    getOrCreateSession(db, 'sess_cross', 'gemini');
    const before = getSession(db, 'sess_cross');
    expect(before.ok && before.data?.status).toBe('in_progress');

    const codexTracker = createSessionTracker(db, ['codex'], 'codex');
    const result = codexTracker.preflight('sess_cross');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('PROVIDER_MISMATCH');

    // The session must remain exactly as it was — not re-activated, provider intact.
    const after = getSession(db, 'sess_cross');
    expect(after.ok && after.data?.provider).toBe('gemini');
    expect(after.ok && after.data?.status).toBe('in_progress');
  });

  it('allows resuming a gemini session under gemini', () => {
    getOrCreateSession(db, 'sess_same', 'gemini');

    const result = createSessionTracker(db, ['gemini'], 'gemini').preflight('sess_same');

    expect(result.ok).toBe(true);
  });

  it('still enforces provider mismatch on an unmigrated database', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'in_progress',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        provider TEXT
      );
      INSERT INTO sessions (session_id, provider) VALUES ('legacy-gemini', 'gemini');
    `);

    const result = checkSessionProvider(legacy, 'legacy-gemini', ['codex']);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('PROVIDER_MISMATCH');
    legacy.close();
  });

  it('preflight is non-durable; successful outcome persists provider for the next guard', () => {
    const tracker = createSessionTracker(db, ['gemini'], 'gemini');
    const first = tracker.preflight('sess_new_resume');
    expect(first.ok).toBe(true);

    const before = getSession(db, 'sess_new_resume');
    expect(before.ok && before.data).toBeNull();

    const persisted = tracker.recordSuccess('sess_new_resume', {
      session_id: 'sess_new_resume',
      type: 'plan',
      verdict: 'approve',
      summary: 'done',
      findings_json: '[]',
      models_json: '[]',
    });
    expect(persisted.ok).toBe(true);
    const after = getSession(db, 'sess_new_resume');
    expect(after.ok && after.data?.provider).toBe('gemini');

    // A later resume of the same id under codex is now correctly rejected.
    const second = createSessionTracker(db, ['codex'], 'codex').preflight('sess_new_resume');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain('PROVIDER_MISMATCH');
  });
});
