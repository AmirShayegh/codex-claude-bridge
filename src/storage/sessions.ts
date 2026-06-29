import type Database from 'better-sqlite3';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';

export interface SessionInfo {
  session_id: string;
  status: 'in_progress' | 'completed' | 'failed';
  created_at: string;
  completed_at: string | null;
  // Which review provider created this session ('codex' | 'gemini'). A plain
  // TEXT tag — storage stays backend-agnostic. Null for legacy rows.
  provider: string | null;
}

export function initSessionsDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'in_progress',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      provider TEXT
    )
  `);
  // Migrations for databases created before these columns existed. Each ALTER
  // throws if the column is already present — expected for new databases.
  for (const ddl of [
    'ALTER TABLE sessions ADD COLUMN completed_at TEXT',
    'ALTER TABLE sessions ADD COLUMN provider TEXT',
  ]) {
    try {
      db.exec(ddl);
    } catch {
      // Column already exists.
    }
  }
}

const SELECT_SESSION =
  'SELECT session_id, status, created_at, completed_at, provider FROM sessions WHERE session_id = ?';

export function getOrCreateSession(
  db: Database.Database,
  sessionId: string,
  provider?: string,
): Result<SessionInfo> {
  try {
    const existing = db
      .prepare(SELECT_SESSION)
      .get(sessionId) as SessionInfo | undefined;

    if (existing) {
      // Never overwrite an existing session's provider — provenance is fixed
      // at creation.
      return ok(existing);
    }

    db.prepare('INSERT INTO sessions (session_id, provider) VALUES (?, ?)').run(sessionId, provider ?? null);

    const created = db
      .prepare(SELECT_SESSION)
      .get(sessionId) as SessionInfo;

    return ok(created);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`${ErrorCode.STORAGE_ERROR}: ${msg}`);
  }
}

// Read a session without creating one. Returns null when it doesn't exist —
// used by the resume preflight to check provider provenance.
export function getSession(db: Database.Database, sessionId: string): Result<SessionInfo | null> {
  try {
    const row = db.prepare(SELECT_SESSION).get(sessionId) as SessionInfo | undefined;
    return ok(row ?? null);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`${ErrorCode.STORAGE_ERROR}: ${msg}`);
  }
}

export function activateSession(
  db: Database.Database,
  sessionId: string,
  provider?: string,
): Result<SessionInfo> {
  try {
    // Tag the provider on insert and backfill it on a NULL row, but never
    // overwrite an existing provider — provenance is fixed at creation. Without
    // this, a session first materialized via the resume/preflight path stays
    // provider=NULL forever, silently defeating the cross-provider guard (m1).
    db.prepare(`
      INSERT INTO sessions (session_id, status, completed_at, provider)
      VALUES (?, 'in_progress', NULL, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        status = 'in_progress',
        completed_at = NULL,
        provider = COALESCE(sessions.provider, excluded.provider)
    `).run(sessionId, provider ?? null);

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
