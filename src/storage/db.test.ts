import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { reviewDbPath, openReviewDb, makeSessionProviderLookup } from './db.js';
import { getOrCreateSession } from './sessions.js';

describe('reviewDbPath', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.REVIEW_BRIDGE_DB; });
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
      try { rmSync(dbPath + suffix); } catch { /* ignore */ }
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
    expect(makeSessionProviderLookup(ro)('s2')).toBe('gemini');
    ro?.close();
  });
});

describe('makeSessionProviderLookup', () => {
  it('returns null when no db is supplied (fail-open)', () => {
    expect(makeSessionProviderLookup(undefined)('anything')).toBeNull();
  });
});
