import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { initDb, saveReview, getReviewsBySession, getRecentReviews } from './reviews.js';
import { initSessionsDb, getOrCreateSession } from './sessions.js';
import { ReviewHistoryEntrySchema } from '../review/types.js';

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  initDb(db);
  initSessionsDb(db);
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

describe('provider provenance in history', () => {
  it('getReviewsBySession surfaces the session provider', () => {
    getOrCreateSession(db, 'thread_g', 'gemini');
    saveReview(db, {
      session_id: 'thread_g',
      type: 'code',
      verdict: 'approve',
      summary: 'From gemini',
      findings_json: '[]',
    });

    const result = getReviewsBySession(db, 'thread_g');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0].provider).toBe('gemini');
    }
  });

  it('getRecentReviews surfaces the session provider', () => {
    getOrCreateSession(db, 'thread_c', 'codex');
    saveReview(db, {
      session_id: 'thread_c',
      type: 'plan',
      verdict: 'approve',
      summary: 'From codex',
      findings_json: '[]',
    });

    const result = getRecentReviews(db, 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0].provider).toBe('codex');
    }
  });

  it('provider is null when no session row exists (legacy reviews)', () => {
    saveReview(db, {
      session_id: 'orphan_thread',
      type: 'plan',
      verdict: 'approve',
      summary: 'No session',
      findings_json: '[]',
    });

    const result = getReviewsBySession(db, 'orphan_thread');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].provider).toBeNull();
    }
  });
});

// The history getters cast raw DB rows to ReviewHistoryEntry[] with no runtime
// check. These tests assert the rows the queries actually return DO satisfy the
// schema — a guard against the SELECT columns drifting from the type — across
// both a provider-tagged row and a legacy NULL-provider row.
describe('history rows satisfy ReviewHistoryEntrySchema', () => {
  it('getRecentReviews returns rows that parse (tagged + legacy)', () => {
    getOrCreateSession(db, 'thread_tagged', 'gemini');
    saveReview(db, { session_id: 'thread_tagged', type: 'code', verdict: 'approve', summary: 'tagged', findings_json: '[]' });
    // No session row → provider joins as NULL (legacy).
    saveReview(db, { session_id: 'orphan', type: 'plan', verdict: 'approve', summary: 'legacy', findings_json: '[]' });

    const result = getRecentReviews(db, 10);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const parsed = z.array(ReviewHistoryEntrySchema).safeParse(result.data);
      expect(parsed.success).toBe(true);
      const providers = result.data.map((r) => r.provider);
      expect(providers).toContain('gemini'); // tagged row
      expect(providers).toContain(null); // legacy row
    }
  });

  it('getReviewsBySession returns rows that parse', () => {
    getOrCreateSession(db, 'thread_s', 'codex');
    saveReview(db, { session_id: 'thread_s', type: 'precommit', verdict: 'approve', summary: 's', findings_json: '[]' });

    const result = getReviewsBySession(db, 'thread_s');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(z.array(ReviewHistoryEntrySchema).safeParse(result.data).success).toBe(true);
    }
  });
});
