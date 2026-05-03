import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSessionTracker } from './session-tracker.js';
import { initSessionsDb } from './sessions.js';

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
    const tracker = createSessionTracker(db);
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
    const tracker = createSessionTracker(db);

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
