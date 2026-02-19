import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSessionsDb, getOrCreateSession, markSessionCompleted } from './sessions.js';

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

  it('returns ok for non-existent session (no-op)', () => {
    const result = markSessionCompleted(db, 'nonexistent');
    expect(result.ok).toBe(true);
  });
});
