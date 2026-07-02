import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { initDb } from './reviews.js';
import { initSessionsDb, getSession } from './sessions.js';
import { toReviewProvider } from '../config/types.js';
import type { ReviewProvider } from '../config/types.js';

// Milliseconds better-sqlite3 waits on a locked db before throwing SQLITE_BUSY.
// Lets a CLI reader coexist with the MCP server writer during brief contention.
const BUSY_TIMEOUT_MS = 5000;

// The review database path, resolved to ABSOLUTE so the server and the CLI open
// the SAME file regardless of how each interprets a relative cwd. REVIEW_BRIDGE_DB
// wins (tests pass an absolute path); otherwise a cwd-relative 'reviews.db'.
//
// NOTE (ISS-018): the default is still cwd-anchored, so the CLI's cross-provider
// guard is only effective when the CLI runs from the same cwd as the MCP server
// (the project root — the documented workflow) or when REVIEW_BRIDGE_DB is set to
// an absolute path. Otherwise the readonly open below finds no file and the guard
// fails open. A stable global/app-data location is deferred to ISS-018.
export function reviewDbPath(): string {
  const p = process.env.REVIEW_BRIDGE_DB ?? 'reviews.db';
  return p === ':memory:' ? p : resolve(p);
}

// Open the review database.
//
// Default (server): read-write. Falls back to an in-memory db if the file can't
// be opened, then initializes the schema and enables WAL so a concurrent CLI
// reader doesn't block the writer. Always returns a usable db.
//
// { readonly: true } (CLI): opens the existing file read-only and never creates
// one (fileMustExist). Returns undefined on any failure — no file, no schema, a
// lock, etc. — so callers fail open rather than crash. Never writes, so a CLI run
// records nothing.
export function openReviewDb(opts?: { readonly?: false }): Database.Database;
export function openReviewDb(opts: { readonly: true }): Database.Database | undefined;
// General overload so a dynamically-computed `readonly` still type-checks (it
// widens the return to include undefined, matching the readonly branch).
export function openReviewDb(opts?: { readonly?: boolean }): Database.Database | undefined;
export function openReviewDb(opts?: { readonly?: boolean }): Database.Database | undefined {
  const path = reviewDbPath();

  if (opts?.readonly) {
    try {
      return new Database(path, { readonly: true, fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
    } catch {
      return undefined;
    }
  }

  let db: Database.Database;
  try {
    db = new Database(path, { timeout: BUSY_TIMEOUT_MS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Database open failed (${path}), falling back to in-memory: ${msg}`);
    db = new Database(':memory:', { timeout: BUSY_TIMEOUT_MS });
  }
  try {
    initDb(db);
    initSessionsDb(db);
    // WAL lets a readonly CLI connection read while the server writes. Harmless
    // (and ignored) for :memory:.
    if (path !== ':memory:') db.pragma('journal_mode = WAL');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Database table initialization failed: ${msg}`);
  }
  return db;
}

// Build a session→owning-provider lookup for resume routing. Returns null for an
// absent db, an unknown session, a read error, or a legacy/unknown provider —
// every branch fails open so routing falls back to the primary rather than
// throwing. Shared by the MCP server and the CLI.
export function makeSessionProviderLookup(
  db: Database.Database | undefined,
): (sessionId: string) => ReviewProvider | null {
  return (sessionId) => {
    if (!db) return null;
    try {
      const r = getSession(db, sessionId);
      return r.ok && r.data ? toReviewProvider(r.data.provider) : null;
    } catch {
      return null;
    }
  };
}
