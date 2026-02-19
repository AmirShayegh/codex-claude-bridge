import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initSessionsDb,
  getOrCreateSession,
  markSessionCompleted,
  markSessionFailed,
  activateSession,
} from './sessions.js';

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  initSessionsDb(db);
});

describe('initSessionsDb', () => {
  it('creates sessions table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('is idempotent', () => {
    expect(() => initSessionsDb(db)).not.toThrow();
  });

  it('migrates old schema by adding completed_at column', () => {
    const oldDb = new Database(':memory:');
    oldDb.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'in_progress',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Should not throw — migration adds the missing column
    expect(() => initSessionsDb(oldDb)).not.toThrow();

    // Verify completed_at column exists
    oldDb.prepare('INSERT INTO sessions (session_id) VALUES (?)').run('test');
    const row = oldDb
      .prepare('SELECT completed_at FROM sessions WHERE session_id = ?')
      .get('test') as { completed_at: string | null };
    expect(row.completed_at).toBeNull();
  });
});

describe('getOrCreateSession', () => {
  it('new session_id creates entry with in_progress status', () => {
    const result = getOrCreateSession(db, 'thread_new');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.session_id).toBe('thread_new');
      expect(result.data.status).toBe('in_progress');
    }
  });

  it('new session has completed_at null', () => {
    const result = getOrCreateSession(db, 'thread_fresh');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.completed_at).toBeNull();
    }
  });

  it('existing session_id returns same entry', () => {
    const first = getOrCreateSession(db, 'thread_reuse');
    const second = getOrCreateSession(db, 'thread_reuse');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.data.session_id).toBe(second.data.session_id);
      expect(first.data.created_at).toBe(second.data.created_at);
    }
  });

  it('different session_ids are independent', () => {
    const a = getOrCreateSession(db, 'thread_a');
    const b = getOrCreateSession(db, 'thread_b');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.data.session_id).not.toBe(b.data.session_id);
    }
  });
});

describe('markSessionCompleted', () => {
  it('changes status from in_progress to completed', () => {
    getOrCreateSession(db, 'thread_done');
    const result = markSessionCompleted(db, 'thread_done');
    expect(result.ok).toBe(true);

    const session = getOrCreateSession(db, 'thread_done');
    if (session.ok) {
      expect(session.data.status).toBe('completed');
    }
  });

  it('sets completed_at timestamp', () => {
    getOrCreateSession(db, 'thread_timed');
    markSessionCompleted(db, 'thread_timed');

    const session = getOrCreateSession(db, 'thread_timed');
    if (session.ok) {
      expect(session.data.completed_at).not.toBeNull();
      expect(typeof session.data.completed_at).toBe('string');
    }
  });

  it('returns ok for non-existent session (no-op)', () => {
    const result = markSessionCompleted(db, 'nonexistent');
    expect(result.ok).toBe(true);
  });
});

describe('markSessionFailed', () => {
  it('sets status to failed', () => {
    getOrCreateSession(db, 'thread_fail');
    const result = markSessionFailed(db, 'thread_fail');
    expect(result.ok).toBe(true);

    const session = getOrCreateSession(db, 'thread_fail');
    if (session.ok) {
      expect(session.data.status).toBe('failed');
    }
  });

  it('sets completed_at timestamp', () => {
    getOrCreateSession(db, 'thread_fail_time');
    markSessionFailed(db, 'thread_fail_time');

    const session = getOrCreateSession(db, 'thread_fail_time');
    if (session.ok) {
      expect(session.data.completed_at).not.toBeNull();
      expect(typeof session.data.completed_at).toBe('string');
    }
  });

  it('returns ok for non-existent session (no-op)', () => {
    const result = markSessionFailed(db, 'nonexistent');
    expect(result.ok).toBe(true);
  });
});

describe('activateSession', () => {
  it('creates new session with in_progress and completed_at null', () => {
    const result = activateSession(db, 'thread_activate_new');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.session_id).toBe('thread_activate_new');
      expect(result.data.status).toBe('in_progress');
      expect(result.data.completed_at).toBeNull();
    }
  });

  it('resets completed session back to in_progress', () => {
    getOrCreateSession(db, 'thread_resume');
    markSessionCompleted(db, 'thread_resume');

    // Verify it's completed first
    const before = getOrCreateSession(db, 'thread_resume');
    if (before.ok) {
      expect(before.data.status).toBe('completed');
      expect(before.data.completed_at).not.toBeNull();
    }

    // Activate should reset to in_progress
    const result = activateSession(db, 'thread_resume');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('in_progress');
      expect(result.data.completed_at).toBeNull();
    }
  });

  it('resets failed session back to in_progress', () => {
    getOrCreateSession(db, 'thread_retry');
    markSessionFailed(db, 'thread_retry');

    const result = activateSession(db, 'thread_retry');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('in_progress');
      expect(result.data.completed_at).toBeNull();
    }
  });

  it('preserves created_at when reactivating', () => {
    getOrCreateSession(db, 'thread_preserve');
    const before = getOrCreateSession(db, 'thread_preserve');
    markSessionCompleted(db, 'thread_preserve');

    activateSession(db, 'thread_preserve');
    const after = getOrCreateSession(db, 'thread_preserve');

    if (before.ok && after.ok) {
      expect(after.data.created_at).toBe(before.data.created_at);
    }
  });
});
