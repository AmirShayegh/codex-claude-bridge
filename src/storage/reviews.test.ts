import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import Database from 'better-sqlite3';
import {
  initDb,
  saveReview,
  getReviewsBySession,
  getRecentReviews,
  getReviewsBySessionPage,
  getRecentReviewsPage,
  parseModelsJson,
} from './reviews.js';
import { initSessionsDb, getOrCreateSession } from './sessions.js';
import { ReviewHistoryEntrySchema } from '../review/types.js';

let db: InstanceType<typeof Database>;

const MODEL = {
  provider: 'codex',
  role: 'review',
  requested: 'gpt-5.5',
  resolved: 'gpt-5.5',
  observed: 'gpt-5.5',
  evidence: 'runtime_session_record',
} as const;

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

  it('creates the nullable models snapshot column', () => {
    const columns = db.pragma('table_info(reviews)') as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('models_json');
  });

  it('creates a session/id index that SQLite uses for cursor history pages', () => {
    const indexColumns = db.pragma('index_info(reviews_session_id_id_idx)') as Array<{
      seqno: number;
      name: string;
    }>;
    expect(
      indexColumns.sort((left, right) => left.seqno - right.seqno).map(({ name }) => name),
    ).toEqual(['session_id', 'id']);

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM reviews
         WHERE session_id = ? AND id > ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all('paged', 0, 3) as Array<{ detail: string }>;

    expect(plan.some(({ detail }) => detail.includes('reviews_session_id_id_idx'))).toBe(true);
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

  it('persists the exact models snapshot and surfaces parsed models', () => {
    const modelsJson = JSON.stringify([MODEL]);
    saveReview(db, {
      session_id: 'models-exact',
      type: 'plan',
      verdict: 'approve',
      summary: 'models',
      findings_json: '[]',
      models_json: modelsJson,
    });

    expect(db.prepare('SELECT models_json FROM reviews').get()).toEqual({
      models_json: modelsJson,
    });
    const result = getReviewsBySession(db, 'models-exact');
    expect(result.ok && result.data[0].models).toEqual([MODEL]);
  });
});

describe('model snapshot parsing', () => {
  it('distinguishes recorded, legacy-unrecorded, and invalid snapshots', () => {
    expect(parseModelsJson(JSON.stringify([MODEL]))).toEqual({
      status: 'recorded',
      models: [MODEL],
    });
    expect(parseModelsJson(null)).toEqual({ status: 'legacy_unrecorded' });
    expect(parseModelsJson('{broken')).toEqual({ status: 'invalid' });
    expect(parseModelsJson(JSON.stringify([{ provider: 'codex' }]))).toEqual({ status: 'invalid' });
  });

  it('maps malformed stored JSON to public history null without failing the query', () => {
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    saveReview(db, {
      session_id: 'malformed-models',
      type: 'code',
      verdict: 'approve',
      summary: 'old',
      findings_json: '[]',
    });
    db.prepare('UPDATE reviews SET models_json = ?').run('{broken');

    const result = getRecentReviews(db, 1);
    expect(result.ok && result.data[0].models).toBeNull();
    expect(result.ok && result.data[0].model_metadata_status).toBe('invalid');
    expect(warning).toHaveBeenCalledWith(
      '[codex-bridge] invalid model metadata found in stored review history',
    );
    expect(warning.mock.calls.flat().join(' ')).not.toContain('{broken');
    warning.mockRestore();
  });

  it('keeps an old review snapshot immutable when the session owner identity changes', () => {
    getOrCreateSession(db, 'immutable', 'codex');
    saveReview(db, {
      session_id: 'immutable',
      type: 'plan',
      verdict: 'approve',
      summary: 'old model',
      findings_json: '[]',
      models_json: JSON.stringify([MODEL]),
    });
    db.prepare('UPDATE sessions SET model_identity_json = ? WHERE session_id = ?').run(
      JSON.stringify({ ...MODEL, resolved: 'gpt-5.6-sol', observed: 'gpt-5.6-sol' }),
      'immutable',
    );

    const result = getReviewsBySession(db, 'immutable');
    expect(result.ok && result.data[0].models).toEqual([MODEL]);
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

describe('paginated history queries', () => {
  beforeEach(() => {
    for (let i = 1; i <= 5; i++) {
      saveReview(db, {
        session_id: 'paged',
        type: 'plan',
        verdict: 'approve',
        summary: `Review ${i}`,
        findings_json: '[]',
        models_json: '[]',
      });
    }
  });

  it('paginates one session in stable oldest-first order without duplicates', () => {
    const first = getReviewsBySessionPage(db, 'paged', { limit: 2 });
    expect(first.ok && first.data.items.map((item) => item.summary)).toEqual([
      'Review 1',
      'Review 2',
    ]);
    expect(first.ok && first.data.nextCursor).not.toBeNull();

    if (!first.ok || first.data.nextCursor === null) return;
    const second = getReviewsBySessionPage(db, 'paged', {
      limit: 2,
      cursor: first.data.nextCursor,
    });
    expect(second.ok && second.data.items.map((item) => item.summary)).toEqual([
      'Review 3',
      'Review 4',
    ]);

    if (!second.ok || second.data.nextCursor === null) return;
    const third = getReviewsBySessionPage(db, 'paged', {
      limit: 2,
      cursor: second.data.nextCursor,
    });
    expect(third.ok && third.data.items.map((item) => item.summary)).toEqual(['Review 5']);
    expect(third.ok && third.data.nextCursor).toBeNull();
  });

  it('paginates recent history in stable newest-first order', () => {
    const first = getRecentReviewsPage(db, { limit: 2 });
    expect(first.ok && first.data.items.map((item) => item.summary)).toEqual([
      'Review 5',
      'Review 4',
    ]);
    if (!first.ok || first.data.nextCursor === null) return;

    const second = getRecentReviewsPage(db, { limit: 2, cursor: first.data.nextCursor });
    expect(second.ok && second.data.items.map((item) => item.summary)).toEqual([
      'Review 3',
      'Review 2',
    ]);
  });

  it('rejects invalid limits and cursors instead of silently restarting a page', () => {
    expect(getRecentReviewsPage(db, { limit: 0 }).ok).toBe(false);
    expect(getRecentReviewsPage(db, { limit: 2, cursor: 'not-a-cursor' }).ok).toBe(false);
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
    saveReview(db, {
      session_id: 'thread_tagged',
      type: 'code',
      verdict: 'approve',
      summary: 'tagged',
      findings_json: '[]',
    });
    // No session row → provider joins as NULL (legacy).
    saveReview(db, {
      session_id: 'orphan',
      type: 'plan',
      verdict: 'approve',
      summary: 'legacy',
      findings_json: '[]',
    });

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
    saveReview(db, {
      session_id: 'thread_s',
      type: 'precommit',
      verdict: 'approve',
      summary: 's',
      findings_json: '[]',
    });

    const result = getReviewsBySession(db, 'thread_s');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(z.array(ReviewHistoryEntrySchema).safeParse(result.data).success).toBe(true);
    }
  });
});
