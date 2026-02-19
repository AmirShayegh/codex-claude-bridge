import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDb, saveReview, getReviewsBySession, getRecentReviews } from './reviews.js';

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  initDb(db);
});

describe('initDb', () => {
  it('creates reviews table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reviews'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('is idempotent (safe to call twice)', () => {
    expect(() => initDb(db)).not.toThrow();
  });
});

describe('saveReview', () => {
  it('saves and returns ok', () => {
    const result = saveReview(db, {
      session_id: 'thread_1',
      type: 'plan',
      verdict: 'approve',
      summary: 'Looks good',
      findings_json: '[]',
    });
    expect(result.ok).toBe(true);
  });

  it('saved review is retrievable', () => {
    saveReview(db, {
      session_id: 'thread_1',
      type: 'code',
      verdict: 'request_changes',
      summary: 'Issues found',
      findings_json: '[{"severity":"critical"}]',
    });

    const result = getReviewsBySession(db, 'thread_1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].session_id).toBe('thread_1');
      expect(result.data[0].type).toBe('code');
      expect(result.data[0].verdict).toBe('request_changes');
      expect(result.data[0].summary).toBe('Issues found');
    }
  });
});

describe('getReviewsBySession', () => {
  it('returns empty array for unknown session', () => {
    const result = getReviewsBySession(db, 'nonexistent');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([]);
    }
  });

  it('returns only reviews for the given session', () => {
    saveReview(db, {
      session_id: 'thread_a',
      type: 'plan',
      verdict: 'approve',
      summary: 'Plan A',
      findings_json: '[]',
    });
    saveReview(db, {
      session_id: 'thread_b',
      type: 'code',
      verdict: 'reject',
      summary: 'Code B',
      findings_json: '[]',
    });

    const result = getReviewsBySession(db, 'thread_a');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].summary).toBe('Plan A');
    }
  });
});

describe('getRecentReviews', () => {
  it('returns empty array when db is empty', () => {
    const result = getRecentReviews(db, 5);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([]);
    }
  });

  it('returns reviews in reverse chronological order', () => {
    saveReview(db, {
      session_id: 'thread_1',
      type: 'plan',
      verdict: 'approve',
      summary: 'First',
      findings_json: '[]',
    });
    saveReview(db, {
      session_id: 'thread_2',
      type: 'code',
      verdict: 'reject',
      summary: 'Second',
      findings_json: '[]',
    });

    const result = getRecentReviews(db, 10);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(2);
      expect(result.data[0].summary).toBe('Second');
      expect(result.data[1].summary).toBe('First');
    }
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      saveReview(db, {
        session_id: `thread_${i}`,
        type: 'plan',
        verdict: 'approve',
        summary: `Review ${i}`,
        findings_json: '[]',
      });
    }

    const result = getRecentReviews(db, 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(3);
    }
  });

  it('review entries have timestamp field', () => {
    saveReview(db, {
      session_id: 'thread_1',
      type: 'precommit',
      verdict: 'approve',
      summary: 'Clean',
      findings_json: '[]',
    });

    const result = getRecentReviews(db, 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0].timestamp).toBeDefined();
      expect(typeof result.data[0].timestamp).toBe('string');
    }
  });
});
