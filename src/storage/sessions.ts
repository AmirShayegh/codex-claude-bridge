import type Database from 'better-sqlite3';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import { ModelIdentitySchema } from '../review/types.js';
import type { ModelIdentity } from '../review/types.js';

export interface SessionInfo {
  session_id: string;
  status: 'in_progress' | 'completed' | 'failed';
  created_at: string;
  completed_at: string | null;
  // Which review provider created this session ('codex' | 'gemini'). A plain
  // TEXT tag — storage stays backend-agnostic. Null for legacy rows.
  provider: string | null;
  // Owner-conversation identity. Null for legacy/unrecorded sessions. Kept as
  // JSON in the row so storage remains an immutable persistence boundary.
  model_identity_json?: string | null;
}

export type SessionModelMetadata =
  | { status: 'recorded'; model: ModelIdentity }
  | { status: 'legacy_unrecorded' }
  | { status: 'invalid' };

export function parseSessionModelIdentityJson(
  value: string | null,
  expectedProvider?: string | null,
): SessionModelMetadata {
  if (value === null) return { status: 'legacy_unrecorded' };
  try {
    const parsed = ModelIdentitySchema.safeParse(JSON.parse(value));
    if (!parsed.success || parsed.data.role !== 'review') return { status: 'invalid' };
    if (expectedProvider !== undefined && parsed.data.provider !== expectedProvider) {
      return { status: 'invalid' };
    }
    return { status: 'recorded', model: parsed.data };
  } catch {
    return { status: 'invalid' };
  }
}

function sessionColumns(db: Database.Database): Set<string> {
  const rows = db.pragma('table_info(sessions)') as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function initializeSessionsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'in_progress',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      provider TEXT,
      model_identity_json TEXT
    )
  `);

  const migrations = [
    ['completed_at', 'ALTER TABLE sessions ADD COLUMN completed_at TEXT'],
    ['provider', 'ALTER TABLE sessions ADD COLUMN provider TEXT'],
    ['model_identity_json', 'ALTER TABLE sessions ADD COLUMN model_identity_json TEXT'],
  ] as const;
  let columns = sessionColumns(db);
  for (const [name, ddl] of migrations) {
    if (!columns.has(name)) {
      db.exec(ddl);
      columns = sessionColumns(db);
    }
  }
  for (const [name] of migrations) {
    if (!columns.has(name))
      throw new Error(`sessions migration verification failed: missing ${name}`);
  }
}

export function initSessionsDb(db: Database.Database): void {
  if (db.inTransaction) {
    initializeSessionsTable(db);
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    initializeSessionsTable(db);
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

const SELECT_SESSION =
  'SELECT session_id, status, created_at, completed_at, provider, model_identity_json FROM sessions WHERE session_id = ?';

export function getOrCreateSession(
  db: Database.Database,
  sessionId: string,
  provider?: string,
  modelIdentityJson?: string | null,
): Result<SessionInfo> {
  try {
    const existing = db.prepare(SELECT_SESSION).get(sessionId) as SessionInfo | undefined;

    if (existing) {
      // Never overwrite an existing session's provider — provenance is fixed
      // at creation.
      return ok(existing);
    }

    db.prepare(
      'INSERT INTO sessions (session_id, provider, model_identity_json) VALUES (?, ?, ?)',
    ).run(sessionId, provider ?? null, modelIdentityJson ?? null);

    const created = db.prepare(SELECT_SESSION).get(sessionId) as SessionInfo;

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

export interface SessionProviderInfo {
  provider: string | null;
}

// Deliberately excludes model_identity_json so provider guards keep working on
// readonly databases created by an older binary that has not run the model
// metadata migration yet.
export function getSessionProvider(
  db: Database.Database,
  sessionId: string,
): Result<SessionProviderInfo | null> {
  try {
    const row = db.prepare('SELECT provider FROM sessions WHERE session_id = ?').get(sessionId) as
      | SessionProviderInfo
      | undefined;
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
  modelIdentityJson?: string | null,
): Result<SessionInfo> {
  try {
    // Tag the provider on insert and backfill it on a NULL row, but never
    // overwrite an existing provider — provenance is fixed at creation. Without
    // this, a session first materialized via the resume/preflight path stays
    // provider=NULL forever, silently defeating the cross-provider guard (m1).
    db.prepare(
      `
      INSERT INTO sessions (session_id, status, completed_at, provider, model_identity_json)
      VALUES (?, 'in_progress', NULL, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        status = 'in_progress',
        completed_at = NULL,
        provider = COALESCE(sessions.provider, excluded.provider),
        model_identity_json = COALESCE(excluded.model_identity_json, sessions.model_identity_json)
    `,
    ).run(sessionId, provider ?? null, modelIdentityJson ?? null);

    const row = db.prepare(SELECT_SESSION).get(sessionId) as SessionInfo;

    return ok(row);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`${ErrorCode.STORAGE_ERROR}: ${msg}`);
  }
}

export function markSessionCompleted(db: Database.Database, sessionId: string): Result<void> {
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

export function markSessionFailed(db: Database.Database, sessionId: string): Result<void> {
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
