import type Database from 'better-sqlite3';
import { ok, err } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';

export interface SessionInfo {
  session_id: string;
  status: 'active' | 'completed';
  created_at: string;
}

export function initSessionsDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export function getOrCreateSession(
  db: Database.Database,
  sessionId: string,
): Result<SessionInfo> {
  try {
    const existing = db
      .prepare('SELECT session_id, status, created_at FROM sessions WHERE session_id = ?')
      .get(sessionId) as SessionInfo | undefined;

    if (existing) {
      return ok(existing);
    }

    db.prepare('INSERT INTO sessions (session_id) VALUES (?)').run(sessionId);

    const created = db
      .prepare('SELECT session_id, status, created_at FROM sessions WHERE session_id = ?')
      .get(sessionId) as SessionInfo;

    return ok(created);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`STORAGE_ERROR: ${msg}`);
  }
}
