import type Database from 'better-sqlite3';
import { ModelIdentitySchema } from '../review/types.js';
import type { ModelIdentity, ReviewHistoryEntry } from '../review/types.js';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';

export interface SaveReviewInput {
  session_id: string;
  type: 'plan' | 'code' | 'precommit';
  verdict: string;
  summary: string;
  findings_json: string;
  // Older callers omit this and intentionally produce a legacy-unrecorded row.
  // New callers may pass an already-serialized snapshot or structural models.
  models_json?: string | null;
  models?: unknown;
}

export type ModelsMetadata =
  | { status: 'recorded'; models: ModelIdentity[] }
  | { status: 'legacy_unrecorded' }
  | { status: 'invalid' };

export interface ReviewPage {
  items: ReviewHistoryEntry[];
  nextCursor: string | null;
}

export interface ReviewPageOptions {
  limit: number;
  cursor?: string;
}

interface ReviewRow {
  id: number;
  session_id: string;
  type: 'plan' | 'code' | 'precommit';
  verdict: 'approve' | 'revise' | 'reject' | 'request_changes';
  summary: string;
  timestamp: string;
  provider: string | null;
  models_json: string | null;
}

export function parseModelsJson(value: string | null): ModelsMetadata {
  if (value === null) return { status: 'legacy_unrecorded' };
  try {
    const parsed = ModelIdentitySchema.array().safeParse(JSON.parse(value));
    return parsed.success ? { status: 'recorded', models: parsed.data } : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

function reviewColumns(db: Database.Database): Set<string> {
  const rows = db.pragma('table_info(reviews)') as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

const REVIEW_SESSION_CURSOR_INDEX = 'reviews_session_id_id_idx';

function verifySessionCursorIndex(db: Database.Database): void {
  const rows = db.pragma(`index_info(${REVIEW_SESSION_CURSOR_INDEX})`) as Array<{
    seqno: number;
    name: string;
  }>;
  const actual = rows.sort((left, right) => left.seqno - right.seqno).map((row) => row.name);
  if (actual.length !== 2 || actual[0] !== 'session_id' || actual[1] !== 'id') {
    throw new Error('reviews migration verification failed: invalid session cursor index');
  }
}

function initializeReviewsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      verdict TEXT NOT NULL,
      summary TEXT NOT NULL,
      findings_json TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      models_json TEXT
    )
  `);

  let columns = reviewColumns(db);
  if (!columns.has('models_json')) {
    db.exec('ALTER TABLE reviews ADD COLUMN models_json TEXT');
    columns = reviewColumns(db);
  }
  if (!columns.has('models_json')) {
    throw new Error('reviews migration verification failed: missing models_json');
  }

  db.exec(`CREATE INDEX IF NOT EXISTS ${REVIEW_SESSION_CURSOR_INDEX} ON reviews(session_id, id)`);
  verifySessionCursorIndex(db);
}

export function initDb(db: Database.Database): void {
  if (db.inTransaction) {
    initializeReviewsTable(db);
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    initializeReviewsTable(db);
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function modelsJsonFromInput(input: SaveReviewInput): Result<string | null> {
  if (input.models_json !== undefined) {
    if (input.models_json === null) return ok(null);
    return parseModelsJson(input.models_json).status === 'recorded'
      ? ok(input.models_json)
      : err(`${ErrorCode.STORAGE_ERROR}: invalid models_json snapshot`);
  }
  if (input.models !== undefined) {
    const parsed = ModelIdentitySchema.array().safeParse(input.models);
    return parsed.success
      ? ok(JSON.stringify(parsed.data))
      : err(`${ErrorCode.STORAGE_ERROR}: invalid models snapshot`);
  }
  return ok(null);
}

export function saveReview(db: Database.Database, input: SaveReviewInput): Result<void> {
  try {
    const modelsJson = modelsJsonFromInput(input);
    if (!modelsJson.ok) return modelsJson;
    db.prepare(
      `INSERT INTO reviews
       (session_id, type, verdict, summary, findings_json, models_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.session_id,
      input.type,
      input.verdict,
      input.summary,
      input.findings_json,
      modelsJson.data,
    );
    return ok(undefined);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`${ErrorCode.STORAGE_ERROR}: ${msg}`);
  }
}

function toHistoryEntry(row: ReviewRow): ReviewHistoryEntry {
  const metadata = parseModelsJson(row.models_json);
  const base = {
    session_id: row.session_id,
    type: row.type,
    verdict: row.verdict,
    summary: row.summary,
    timestamp: row.timestamp,
    provider: row.provider,
  };
  if (metadata.status === 'recorded') {
    return { ...base, models: metadata.models, model_metadata_status: 'recorded' };
  }
  if (metadata.status === 'invalid') {
    console.error('[codex-bridge] invalid model metadata found in stored review history');
  }
  return { ...base, models: null, model_metadata_status: metadata.status };
}

const HISTORY_SELECT = `
  SELECT r.id, r.session_id, r.type, r.verdict, r.summary, r.timestamp,
         r.models_json, s.provider
  FROM reviews r
  LEFT JOIN sessions s ON s.session_id = r.session_id`;

function validatePageOptions(options: ReviewPageOptions): Result<number | null> {
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    return err(`${ErrorCode.INVALID_INPUT}: limit must be a positive integer`);
  }
  if (options.cursor === undefined) return ok(null);
  if (!/^[1-9]\d*$/.test(options.cursor)) {
    return err(`${ErrorCode.INVALID_INPUT}: invalid review cursor`);
  }
  const cursor = Number(options.cursor);
  return Number.isSafeInteger(cursor)
    ? ok(cursor)
    : err(`${ErrorCode.INVALID_INPUT}: invalid review cursor`);
}

function pageFromRows(rows: ReviewRow[], limit: number): ReviewPage {
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: visible.map(toHistoryEntry),
    nextCursor: hasMore ? String(visible[visible.length - 1].id) : null,
  };
}

export function getReviewsBySessionPage(
  db: Database.Database,
  sessionId: string,
  options: ReviewPageOptions,
): Result<ReviewPage> {
  try {
    const cursor = validatePageOptions(options);
    if (!cursor.ok) return cursor;
    const rows =
      cursor.data === null
        ? db
            .prepare(`${HISTORY_SELECT} WHERE r.session_id = ? ORDER BY r.id ASC LIMIT ?`)
            .all(sessionId, options.limit + 1)
        : db
            .prepare(
              `${HISTORY_SELECT} WHERE r.session_id = ? AND r.id > ? ORDER BY r.id ASC LIMIT ?`,
            )
            .all(sessionId, cursor.data, options.limit + 1);
    return ok(pageFromRows(rows as ReviewRow[], options.limit));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`${ErrorCode.STORAGE_ERROR}: ${msg}`);
  }
}

export function getRecentReviewsPage(
  db: Database.Database,
  options: ReviewPageOptions,
): Result<ReviewPage> {
  try {
    const cursor = validatePageOptions(options);
    if (!cursor.ok) return cursor;
    const rows =
      cursor.data === null
        ? db.prepare(`${HISTORY_SELECT} ORDER BY r.id DESC LIMIT ?`).all(options.limit + 1)
        : db
            .prepare(`${HISTORY_SELECT} WHERE r.id < ? ORDER BY r.id DESC LIMIT ?`)
            .all(cursor.data, options.limit + 1);
    return ok(pageFromRows(rows as ReviewRow[], options.limit));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`${ErrorCode.STORAGE_ERROR}: ${msg}`);
  }
}

// Compatibility queries retained for existing tool callers. New pagination
// surfaces should use the keyset variants above.
export function getReviewsBySession(
  db: Database.Database,
  sessionId: string,
): Result<ReviewHistoryEntry[]> {
  try {
    const rows = db
      .prepare(`${HISTORY_SELECT} WHERE r.session_id = ? ORDER BY r.id ASC`)
      .all(sessionId) as ReviewRow[];
    return ok(rows.map(toHistoryEntry));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`${ErrorCode.STORAGE_ERROR}: ${msg}`);
  }
}

export function getRecentReviews(
  db: Database.Database,
  limit: number,
): Result<ReviewHistoryEntry[]> {
  const page = getRecentReviewsPage(db, { limit });
  return page.ok ? ok(page.data.items) : page;
}
