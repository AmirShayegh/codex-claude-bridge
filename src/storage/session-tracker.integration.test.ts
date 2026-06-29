import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSessionTracker } from './session-tracker.js';
import { initSessionsDb, getOrCreateSession, getSession } from './sessions.js';
import { initDb } from './reviews.js';

// Real SQLite, no mocks. Reviews table is deliberately omitted so saveReview
// fails — exercising the actual atomicity contract recordSuccess must satisfy.

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
    const tracker = createSessionTracker(db, 'codex');
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

  it('does not mark session completed when saveReview fails (fresh path)', () => {
    const tracker = createSessionTracker(db, 'codex');

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

    expect(row).toBeDefined();
    expect(row?.status).toBe('in_progress');
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

    const codexTracker = createSessionTracker(db, 'codex');
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

    const result = createSessionTracker(db, 'gemini').preflight('sess_same');

    expect(result.ok).toBe(true);
  });

  it('preflight on a session not yet in the DB persists its provider, so the guard holds on the next resume (m1)', () => {
    // Backend session exists (in ~/.gemini) but no bridge row yet — the first
    // touch is a resume under gemini. Pre-fix this persisted provider=NULL.
    const first = createSessionTracker(db, 'gemini').preflight('sess_new_resume');
    expect(first.ok).toBe(true);

    const row = getSession(db, 'sess_new_resume');
    expect(row.ok && row.data?.provider).toBe('gemini');

    // A later resume of the same id under codex is now correctly rejected.
    const second = createSessionTracker(db, 'codex').preflight('sess_new_resume');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain('PROVIDER_MISMATCH');
  });
});
