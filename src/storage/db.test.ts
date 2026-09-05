import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  reviewDbPath,
  openReviewDb,
  openReviewDbWithMetadata,
  initializeStorageSchema,
  makeSessionModelLookup,
  makeSessionProviderLookup,
} from './db.js';
import { getOrCreateSession } from './sessions.js';

describe('reviewDbPath', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.REVIEW_BRIDGE_DB;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.REVIEW_BRIDGE_DB;
    else process.env.REVIEW_BRIDGE_DB = saved;
  });

  it('resolves the default relative path to absolute', () => {
    delete process.env.REVIEW_BRIDGE_DB;
    expect(isAbsolute(reviewDbPath())).toBe(true);
  });

  it('passes :memory: through untouched', () => {
    process.env.REVIEW_BRIDGE_DB = ':memory:';
    expect(reviewDbPath()).toBe(':memory:');
  });

  it('resolves an explicit relative REVIEW_BRIDGE_DB to absolute', () => {
    process.env.REVIEW_BRIDGE_DB = 'sub/dir/reviews.db';
    expect(isAbsolute(reviewDbPath())).toBe(true);
  });
});

describe('openReviewDb', () => {
  let saved: string | undefined;
  let dbPath: string;
  beforeEach(() => {
    saved = process.env.REVIEW_BRIDGE_DB;
    dbPath = join(tmpdir(), `db-test-${process.pid}-${Date.now()}.db`);
    process.env.REVIEW_BRIDGE_DB = dbPath;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.REVIEW_BRIDGE_DB;
    else process.env.REVIEW_BRIDGE_DB = saved;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(dbPath + suffix, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('read-write open creates the db and its tables', () => {
    const db = openReviewDb();
    expect(db).toBeDefined();
    // sessions table exists → getOrCreateSession succeeds
    const r = getOrCreateSession(db, 's1', 'codex');
    expect(r.ok).toBe(true);
    db.close();
  });

  it('readonly open returns undefined when the file does not exist', () => {
    // dbPath not yet created
    expect(openReviewDb({ readonly: true })).toBeUndefined();
  });

  it('readonly open reads an existing db', () => {
    const rw = openReviewDb();
    getOrCreateSession(rw, 's2', 'gemini');
    rw.close();

    const ro = openReviewDb({ readonly: true });
    expect(ro).toBeDefined();
    expect(makeSessionProviderLookup(ro)('s2')).toEqual({ status: 'found', value: 'gemini' });
    ro?.close();
  });

  it('returns durable metadata for a successfully initialized persistent db', () => {
    const opened = openReviewDbWithMetadata();
    expect(opened.durability).toBe('durable');
    expect(opened.warning).toBeNull();
    expect(opened.db.pragma('busy_timeout', { simple: true })).toBe(100);
    opened.db.close();
  });

  it('marks an intentional in-memory db as memory_only and fully initializes it', () => {
    process.env.REVIEW_BRIDGE_DB = ':memory:';
    const opened = openReviewDbWithMetadata();

    expect(opened.durability).toBe('memory_only');
    expect(opened.db.pragma('busy_timeout', { simple: true })).toBe(100);
    expect(
      opened.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'reviews')",
        )
        .all(),
    ).toHaveLength(2);
    opened.db.close();
  });

  it('closes a persistent db whose schema init fails and returns a fully initialized memory db', () => {
    const broken = new Database(dbPath);
    broken.exec('CREATE VIEW sessions AS SELECT 1 AS session_id');
    broken.close();

    const opened = openReviewDbWithMetadata();

    expect(opened.durability).toBe('memory_only');
    expect(opened.warning).toContain('initialization failed');
    const sessionsColumns = opened.db.pragma('table_info(sessions)') as Array<{ name: string }>;
    const reviewsColumns = opened.db.pragma('table_info(reviews)') as Array<{ name: string }>;
    expect(sessionsColumns.map((column) => column.name)).toContain('model_identity_json');
    expect(reviewsColumns.map((column) => column.name)).toContain('models_json');
    opened.db.close();

    // The failed persistent handle was closed, so another connection can take
    // an exclusive transaction immediately.
    const reopened = new Database(dbPath, { timeout: 100 });
    expect(() => reopened.exec('BEGIN EXCLUSIVE; ROLLBACK')).not.toThrow();
    reopened.close();
  });

  it('falls back to initialized memory with metadata when the persistent file cannot open', () => {
    mkdirSync(dbPath);

    const opened = openReviewDbWithMetadata();

    expect(opened.durability).toBe('memory_only');
    expect(opened.warning).toContain('open failed');
    expect(opened.db.pragma('table_info(sessions)')).not.toEqual([]);
    expect(opened.db.pragma('table_info(reviews)')).not.toEqual([]);
    opened.db.close();
  });

  it('best-effort closes a persistent handle when startup configuration throws', () => {
    const close = vi.fn(() => {
      throw new Error('injected close failure');
    });
    const opened = openReviewDbWithMetadata({
      openPersistentDatabase: () => ({ close }) as unknown as Database.Database,
      configureStartup: () => {
        throw new Error('injected startup configuration failure');
      },
    });

    expect(close).toHaveBeenCalledOnce();
    expect(opened.durability).toBe('memory_only');
    expect(opened.warning).toContain('open failed');
    opened.db.close();
  });
});

describe('makeSessionProviderLookup', () => {
  it('distinguishes an unavailable db from an absent session', () => {
    expect(makeSessionProviderLookup(undefined)('anything')).toEqual({ status: 'unavailable' });

    const db = new Database(':memory:');
    initializeStorageSchema(db);
    expect(makeSessionProviderLookup(db)('anything')).toEqual({ status: 'absent' });
    db.close();
  });

  it('keeps provider and model lookups separate on an unmigrated readonly db', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'in_progress',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        provider TEXT
      );
      INSERT INTO sessions (session_id, provider) VALUES ('legacy', 'gemini');
    `);

    expect(makeSessionProviderLookup(db)('legacy')).toEqual({ status: 'found', value: 'gemini' });
    expect(makeSessionModelLookup(db)('legacy')).toEqual({ status: 'unavailable' });
    db.close();
  });

  it('treats only SQL NULL as legacy and fails closed on an unrecognized owner', () => {
    const db = new Database(':memory:');
    initializeStorageSchema(db);
    db.prepare('INSERT INTO sessions (session_id, provider) VALUES (?, ?)').run(
      'future-owner',
      'unknown',
    );
    db.prepare('INSERT INTO sessions (session_id, provider) VALUES (?, NULL)').run('legacy');
    const lookup = makeSessionProviderLookup(db);

    expect(lookup('future-owner')).toEqual({ status: 'unavailable' });
    expect(lookup('legacy')).toEqual({ status: 'found', value: null });
    db.close();
  });

  it('returns parsed legacy, recorded, and invalid model states for existing sessions', () => {
    const db = new Database(':memory:');
    initializeStorageSchema(db);
    getOrCreateSession(db, 'model-state', 'codex');
    const lookup = makeSessionModelLookup(db);

    expect(lookup('model-state')).toEqual({
      status: 'found',
      value: { status: 'legacy_unrecorded' },
    });
    const identity = {
      provider: 'codex',
      role: 'review',
      requested: null,
      resolved: 'gpt-5.6-sol',
      observed: 'gpt-5.6-sol',
      evidence: 'runtime_session_record',
    };
    db.prepare('UPDATE sessions SET model_identity_json = ? WHERE session_id = ?').run(
      JSON.stringify(identity),
      'model-state',
    );
    expect(lookup('model-state')).toEqual({
      status: 'found',
      value: { status: 'recorded', model: identity },
    });
    db.prepare('UPDATE sessions SET model_identity_json = ? WHERE session_id = ?').run(
      '{broken',
      'model-state',
    );
    expect(lookup('model-state')).toEqual({
      status: 'found',
      value: { status: 'invalid' },
    });
    db.close();
  });

  it('rejects owner model metadata with an adjudication role or a different row provider', () => {
    const db = new Database(':memory:');
    initializeStorageSchema(db);
    getOrCreateSession(db, 'model-state', 'codex');
    const lookup = makeSessionModelLookup(db);
    const identity = {
      provider: 'codex',
      role: 'review',
      requested: null,
      resolved: 'gpt-5.6-sol',
      observed: 'gpt-5.6-sol',
      evidence: 'runtime_session_record',
    } as const;

    for (const invalidIdentity of [
      { ...identity, role: 'adjudication' as const },
      { ...identity, provider: 'gemini' as const },
    ]) {
      db.prepare('UPDATE sessions SET model_identity_json = ? WHERE session_id = ?').run(
        JSON.stringify(invalidIdentity),
        'model-state',
      );
      expect(lookup('model-state')).toEqual({
        status: 'found',
        value: { status: 'invalid' },
      });
    }
    db.close();
  });
});

describe('initializeStorageSchema', () => {
  it('atomically migrates both populated legacy tables and is idempotent', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'in_progress',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        provider TEXT
      );
      CREATE TABLE reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        verdict TEXT NOT NULL,
        summary TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO sessions (session_id, provider) VALUES ('legacy', 'codex');
      INSERT INTO reviews (session_id, type, verdict, summary, findings_json)
      VALUES ('legacy', 'plan', 'approve', 'old', '[]');
    `);

    expect(() => initializeStorageSchema(db)).not.toThrow();
    expect(() => initializeStorageSchema(db)).not.toThrow();
    expect(
      db.prepare('SELECT model_identity_json FROM sessions WHERE session_id = ?').get('legacy'),
    ).toEqual({ model_identity_json: null });
    expect(db.prepare('SELECT models_json FROM reviews').get()).toEqual({ models_json: null });
    db.close();
  });

  it.each([
    {
      name: 'reviews metadata present and sessions metadata absent',
      sessionHasMetadata: false,
      reviewHasMetadata: true,
      expectedSessionMetadata: null,
      expectedReviewMetadata: '[]',
    },
    {
      name: 'sessions metadata present and reviews metadata absent',
      sessionHasMetadata: true,
      reviewHasMetadata: false,
      expectedSessionMetadata: '{"provider":"codex"}',
      expectedReviewMetadata: null,
    },
  ])(
    'migrates a populated partial schema with $name without disturbing future columns',
    ({
      sessionHasMetadata,
      reviewHasMetadata,
      expectedSessionMetadata,
      expectedReviewMetadata,
    }) => {
      const db = new Database(':memory:');
      db.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'in_progress',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          provider TEXT,
          ${sessionHasMetadata ? 'model_identity_json TEXT,' : ''}
          future_session_marker TEXT
        );
        CREATE TABLE reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          verdict TEXT NOT NULL,
          summary TEXT NOT NULL,
          findings_json TEXT NOT NULL,
          timestamp TEXT NOT NULL DEFAULT (datetime('now')),
          ${reviewHasMetadata ? 'models_json TEXT,' : ''}
          future_review_marker TEXT
        );
      `);
      if (sessionHasMetadata) {
        db.prepare(
          `INSERT INTO sessions
           (session_id, provider, model_identity_json, future_session_marker)
           VALUES (?, ?, ?, ?)`,
        ).run('partial', 'codex', '{"provider":"codex"}', 'keep-session');
      } else {
        db.prepare(
          `INSERT INTO sessions (session_id, provider, future_session_marker)
           VALUES (?, ?, ?)`,
        ).run('partial', 'codex', 'keep-session');
      }
      if (reviewHasMetadata) {
        db.prepare(
          `INSERT INTO reviews
           (session_id, type, verdict, summary, findings_json, models_json, future_review_marker)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run('partial', 'plan', 'approve', 'old', '[]', '[]', 'keep-review');
      } else {
        db.prepare(
          `INSERT INTO reviews
           (session_id, type, verdict, summary, findings_json, future_review_marker)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run('partial', 'plan', 'approve', 'old', '[]', 'keep-review');
      }

      expect(() => initializeStorageSchema(db)).not.toThrow();

      expect(
        db
          .prepare(
            `SELECT model_identity_json, future_session_marker
             FROM sessions WHERE session_id = ?`,
          )
          .get('partial'),
      ).toEqual({
        model_identity_json: expectedSessionMetadata,
        future_session_marker: 'keep-session',
      });
      expect(
        db
          .prepare(
            `SELECT models_json, future_review_marker
             FROM reviews WHERE session_id = ?`,
          )
          .get('partial'),
      ).toEqual({
        models_json: expectedReviewMetadata,
        future_review_marker: 'keep-review',
      });
      db.close();
    },
  );

  it('rolls back the first metadata column when the second ALTER fails', () => {
    const db = new Database(':memory:');
    const core = [
      'session_id TEXT PRIMARY KEY',
      "status TEXT NOT NULL DEFAULT 'in_progress'",
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))",
      'completed_at TEXT',
      'provider TEXT',
    ];
    // Fill sessions to this SQLite build's MAX_COLUMN limit so the second
    // metadata ALTER fails after reviews.models_json was added.
    const compileOptions = db.pragma('compile_options') as Array<{ compile_options: string }>;
    const maxColumnOption = compileOptions.find((option) =>
      option.compile_options.startsWith('MAX_COLUMN='),
    );
    const maxColumns = Number(maxColumnOption?.compile_options.split('=')[1] ?? 2000);
    const padding = Array.from(
      { length: maxColumns - core.length },
      (_, index) => `pad_${index} TEXT`,
    );
    db.exec(`
      CREATE TABLE sessions (${[...core, ...padding].join(',')});
      CREATE TABLE reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        verdict TEXT NOT NULL,
        summary TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    expect(() => initializeStorageSchema(db)).toThrow();
    const reviewColumns = db.pragma('table_info(reviews)') as Array<{ name: string }>;
    expect(reviewColumns.map((column) => column.name)).not.toContain('models_json');
    db.close();
  });

  it('fails cleanly under a concurrent startup lock and succeeds after release', () => {
    const lockedPath = join(tmpdir(), `db-lock-${process.pid}-${Date.now()}.db`);
    const first = new Database(lockedPath, { timeout: 100 });
    const second = new Database(lockedPath, { timeout: 100 });
    first.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'in_progress',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        provider TEXT
      );
      CREATE TABLE reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        verdict TEXT NOT NULL,
        summary TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );
      BEGIN IMMEDIATE;
    `);

    expect(() => initializeStorageSchema(second)).toThrow(/locked|busy/i);
    first.exec('ROLLBACK');
    const before = second.pragma('table_info(reviews)') as Array<{ name: string }>;
    expect(before.map((column) => column.name)).not.toContain('models_json');
    expect(() => initializeStorageSchema(second)).not.toThrow();
    first.close();
    second.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(lockedPath + suffix);
      } catch {
        /* ignore */
      }
    }
  });
});
