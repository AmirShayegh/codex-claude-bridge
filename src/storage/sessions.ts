import type Database from 'better-sqlite3';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';

export interface SessionInfo {
  session_id: string;
  status: 'in_progress' | 'completed' | 'failed';
  created_at: string;
  completed_at: string | null;
}

export function initSessionsDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'in_progress',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    )
  `);
  // Migration for existing databases without completed_at column
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN completed_at TEXT');
  } catch {
    // Column already exists — expected for new databases
  }
}

const SELECT_SESSION = 'SELECT session_id, status, created_at, completed_at FROM sessions WHERE session_id = ?';

export function getOrCreateSession(
  db: Database.Database,
  sessionId: string,
): Result<SessionInfo> {
  try {
    const existing = db
      .prepare(SELECT_SESSION)
      .get(sessionId) as SessionInfo | undefined;

    if (existing) {
      return ok(existing);
    }

    db.prepare('INSERT INTO sessions (session_id) VALUES (?)').run(sessionId);

    const created = db
      .prepare(SELECT_SESSION)
      .get(sessionId) as SessionInfo;

    return ok(created);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`${ErrorCode.STORAGE_ERROR}: ${msg}`);
  }
}

export function activateSession(
  db: Database.Database,
  sessionId: string,
): Result<SessionInfo> {
  try {
    db.prepare(`
      INSERT INTO sessions (session_id, status, completed_at)
      VALUES (?, 'in_progress', NULL)
      ON CONFLICT(session_id) DO UPDATE SET status = 'in_progress', completed_at = NULL
    `).run(sessionId);

    const row = db
      .prepare(SELECT_SESSION)
      .get(sessionId) as SessionInfo;

    return ok(row);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`${ErrorCode.STORAGE_ERROR}: ${msg}`);
  }
}

export function markSessionCompleted(
  db: Database.Database,
  sessionId: string,
): Result<void> {
  try {
    db.prepare(
      "UPDATE sessions SET status = 'completed', completed_at = datetime('now') WHERE session_id = ?",
    ).run(sessionId);
    return ok(undefined);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`${ErrorCode.STORAGE_ERROR}: ${msg}`);
  }
}

export function markSessionFailed(
  db: Database.Database,
  sessionId: string,
): Result<void> {
  try {
    db.prepare(
      "UPDATE sessions SET status = 'failed', completed_at = datetime('now') WHERE session_id = ?",
    ).run(sessionId);
    return ok(undefined);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`${ErrorCode.STORAGE_ERROR}: ${msg}`);
  }
}
