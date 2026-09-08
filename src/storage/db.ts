import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { initDb } from './reviews.js';
import { initSessionsDb, parseSessionModelIdentityJson } from './sessions.js';
import type { SessionModelMetadata } from './sessions.js';
import { toReviewProvider } from '../config/types.js';
import type { ReviewProvider } from '../config/types.js';
import { escapeTerminalControls } from '../utils/terminal.js';

// Keep lock waits short: the outcome writer performs one explicit retry after
// yielding, rather than blocking the synchronous server for seconds.
export const BUSY_TIMEOUT_MS = 100;
export const STARTUP_BUSY_TIMEOUT_MS = 2_000;

export type StorageDurability = 'durable' | 'memory_only';

export interface OpenReviewDbMetadata {
  db: Database.Database;
  durability: StorageDurability;
  warning: string | null;
}

export interface OpenReviewDbDependencies {
  openPersistentDatabase?: (path: string, timeoutMs: number) => Database.Database;
  configureStartup?: (db: Database.Database) => void;
}

export type LookupResult<T> =
  | { status: 'found'; value: T }
  | { status: 'absent' }
  | { status: 'unavailable' };

export function reviewDbPath(): string {
  const path = process.env.REVIEW_BRIDGE_DB ?? 'reviews.db';
  return path === ':memory:' ? path : resolve(path);
}

function columns(db: Database.Database, table: 'sessions' | 'reviews'): Set<string> {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

// The two model-metadata columns migrate in one BEGIN IMMEDIATE transaction.
// initDb/initSessionsDb detect the enclosing transaction and do not create
// nested commits, so a failure in either table rolls the whole upgrade back.
export function initializeStorageSchema(db: Database.Database): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Reviews first is intentional: a later sessions migration failure must
    // prove reviews.models_json rolls back with it.
    initDb(db);
    initSessionsDb(db);

    if (!columns(db, 'reviews').has('models_json')) {
      throw new Error('storage migration verification failed: reviews.models_json missing');
    }
    if (!columns(db, 'sessions').has('model_identity_json')) {
      throw new Error(
        'storage migration verification failed: sessions.model_identity_json missing',
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function configureConnection(db: Database.Database): void {
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
}

function configureStartupConnection(db: Database.Database): void {
  db.pragma(`busy_timeout = ${STARTUP_BUSY_TIMEOUT_MS}`);
}

function closeBestEffort(db: Database.Database): void {
  try {
    db.close();
  } catch {
    // The original open/configuration error is the useful failure. A close
    // error must not prevent the fully initialized memory fallback.
  }
}

function openConfiguredPersistentDatabase(
  path: string,
  dependencies: OpenReviewDbDependencies,
): Database.Database {
  const openPersistentDatabase =
    dependencies.openPersistentDatabase ??
    ((databasePath: string, timeoutMs: number) =>
      new Database(databasePath, { timeout: timeoutMs }));
  const db = openPersistentDatabase(path, STARTUP_BUSY_TIMEOUT_MS);
  try {
    (dependencies.configureStartup ?? configureStartupConnection)(db);
    return db;
  } catch (error) {
    closeBestEffort(db);
    throw error;
  }
}

function openInitializedMemory(warning: string | null): OpenReviewDbMetadata {
  const db = new Database(':memory:', { timeout: BUSY_TIMEOUT_MS });
  configureConnection(db);
  initializeStorageSchema(db);
  return { db, durability: 'memory_only', warning };
}

export function openReviewDbWithMetadata(
  dependencies: OpenReviewDbDependencies = {},
): OpenReviewDbMetadata {
  const path = reviewDbPath();
  if (path === ':memory:') return openInitializedMemory(null);

  let db: Database.Database;
  try {
    db = openConfiguredPersistentDatabase(path, dependencies);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const warning = `Database open failed (${path}); using in-memory storage: ${message}`;
    console.error(escapeTerminalControls(warning));
    return openInitializedMemory(warning);
  }

  try {
    initializeStorageSchema(db);
    db.pragma('journal_mode = WAL');
    configureConnection(db);
    return { db, durability: 'durable', warning: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    closeBestEffort(db);
    const warning = `Database initialization failed (${path}); using in-memory storage: ${message}`;
    console.error(escapeTerminalControls(warning));
    return openInitializedMemory(warning);
  }
}

export function openReviewDb(opts?: { readonly?: false }): Database.Database;
export function openReviewDb(opts: { readonly: true }): Database.Database | undefined;
export function openReviewDb(opts?: { readonly?: boolean }): Database.Database | undefined;
export function openReviewDb(opts?: { readonly?: boolean }): Database.Database | undefined {
  if (opts?.readonly) {
    try {
      const db = new Database(reviewDbPath(), {
        readonly: true,
        fileMustExist: true,
        timeout: BUSY_TIMEOUT_MS,
      });
      configureConnection(db);
      return db;
    } catch {
      return undefined;
    }
  }
  return openReviewDbWithMetadata().db;
}

// Provider lookup intentionally selects only the legacy provider column. It
// remains usable on a readonly database whose model migration has not run.
export function makeSessionProviderLookup(
  db: Database.Database | undefined,
): (sessionId: string) => LookupResult<ReviewProvider | null> {
  return (sessionId) => {
    if (!db) return { status: 'unavailable' };
    try {
      const row = db
        .prepare('SELECT provider FROM sessions WHERE session_id = ?')
        .get(sessionId) as { provider: string | null } | undefined;
      if (!row) return { status: 'absent' };
      const provider = toReviewProvider(row.provider);
      // SQL NULL is the only legacy/untagged state. A non-null value that this
      // binary does not recognize may be corruption or a future provider; never
      // route it through the configured primary by pretending it is legacy.
      if (row.provider !== null && provider === null) return { status: 'unavailable' };
      return { status: 'found', value: provider };
    } catch {
      return { status: 'unavailable' };
    }
  };
}

// Model lookup is separate so an unmigrated/locked model column reports
// unavailable without weakening the legacy provider mismatch guard.
export function makeSessionModelLookup(
  db: Database.Database | undefined,
): (sessionId: string) => LookupResult<SessionModelMetadata> {
  return (sessionId) => {
    if (!db) return { status: 'unavailable' };
    try {
      const row = db
        .prepare('SELECT provider, model_identity_json FROM sessions WHERE session_id = ?')
        .get(sessionId) as
        | { provider: string | null; model_identity_json: string | null }
        | undefined;
      return row
        ? {
            status: 'found',
            value: parseSessionModelIdentityJson(row.model_identity_json, row.provider),
          }
        : { status: 'absent' };
    } catch {
      return { status: 'unavailable' };
    }
  };
}
