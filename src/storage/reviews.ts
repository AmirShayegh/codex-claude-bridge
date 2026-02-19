import type Database from 'better-sqlite3';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import type { ReviewHistoryEntry } from '../codex/types.js';

export interface SaveReviewInput {
  session_id: string;
  type: 'plan' | 'code' | 'precommit';
  verdict: string;
  summary: string;
  findings_json: string;
}

export function initDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      verdict TEXT NOT NULL,
      summary TEXT NOT NULL,
      findings_json TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export function saveReview(db: Database.Database, input: SaveReviewInput): Result<void> {
  try {
    db.prepare(
      'INSERT INTO reviews (session_id, type, verdict, summary, findings_json) VALUES (?, ?, ?, ?, ?)',
    ).run(input.session_id, input.type, input.verdict, input.summary, input.findings_json);
    return ok(undefined);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`${ErrorCode.STORAGE_ERROR}: ${msg}`);
  }
}

export function getReviewsBySession(
  db: Database.Database,
  sessionId: string,
): Result<ReviewHistoryEntry[]> {
  try {
    const rows = db
      .prepare('SELECT session_id, type, verdict, summary, timestamp FROM reviews WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId) as ReviewHistoryEntry[];
    return ok(rows);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`${ErrorCode.STORAGE_ERROR}: ${msg}`);
  }
}

export function getRecentReviews(
  db: Database.Database,
  limit: number,
): Result<ReviewHistoryEntry[]> {
  try {
    const rows = db
      .prepare('SELECT session_id, type, verdict, summary, timestamp FROM reviews ORDER BY id DESC LIMIT ?')
      .all(limit) as ReviewHistoryEntry[];
    return ok(rows);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`${ErrorCode.STORAGE_ERROR}: ${msg}`);
  }
}
