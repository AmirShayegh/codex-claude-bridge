import type Database from 'better-sqlite3';
import type { SaveReviewInput } from './reviews.js';
import { saveReview } from './reviews.js';
import { activateSession, getOrCreateSession, getSession, markSessionCompleted, markSessionFailed } from './sessions.js';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';

export interface SessionTracker {
  // Returns an error when the resumed session was created by a different
  // provider than the active backend — the tool aborts before reviewing.
  preflight(sessionId: string | undefined): Result<void>;
  // servingProvider, when set, is the provider that actually produced the review
  // (may differ from the tracker's configured provider under failover). It tags
  // a NEW session's provenance so a failed-over session is owned by the provider
  // that served it. Falls back to the configured provider when omitted.
  recordSuccess(resultSessionId: string, review: SaveReviewInput, servingProvider?: string): void;
  // sessionId surfaces partial-chunk failures where chunk 1 created a
  // Codex thread but a later chunk errored — the tool layer must mark
  // that thread's session failed rather than orphaning it (T-001).
  recordFailure(sessionId?: string): void;
  recordFailureBestEffort(): void;
}

const NULL_TRACKER: SessionTracker = {
  preflight: () => ok(undefined),
  recordSuccess() {},
  recordFailure() {},
  recordFailureBestEffort() {},
};

// Read-only cross-provider guard: a session created by one provider cannot be
// resumed under a backend that doesn't serve that provider (their thread/
// conversation ids are not interchangeable). Fails OPEN — returns ok when there
// is no db, no session id, a read error, or an unknown/legacy-null owner — so a
// guard we can't evaluate never blocks a review. Shared by the MCP tracker
// (below) and the CLI, which has no tracker/recording of its own.
export function checkSessionProvider(
  db: Database.Database | undefined,
  sessionId: string | undefined,
  providers: readonly string[],
): Result<void> {
  if (!db || typeof sessionId !== 'string') return ok(undefined);
  // getSession is already Result-safe, but guard against any future throw so the
  // fail-open contract holds no matter what the read does.
  let existing: ReturnType<typeof getSession>;
  try {
    existing = getSession(db, sessionId);
  } catch {
    return ok(undefined);
  }
  if (!existing.ok || !existing.data || !existing.data.provider) return ok(undefined);
  const owner = existing.data.provider;
  if (!providers.includes(owner)) {
    return err(
      `${ErrorCode.PROVIDER_MISMATCH}: session ${sessionId} was created by the '${owner}' provider, ` +
        `which is not active (available: ${providers.join(', ')}). Start a new session, or configure ` +
        `the '${owner}' provider to continue this one.`,
    );
  }
  return ok(undefined);
}

// providers is the guard set (every provider this backend serves); taggingProvider
// is the provider stamped on NEW sessions (a composite presents as its primary).
export function createSessionTracker(
  db: Database.Database | undefined,
  providers: readonly string[],
  taggingProvider: string,
): SessionTracker {
  if (!db) return NULL_TRACKER;

  let preflightId: string | undefined;

  return {
    preflight(sessionId) {
      if (typeof sessionId !== 'string') return ok(undefined);
      // Cross-provider guard runs before activateSession so a rejected resume
      // never mutates the session's state.
      const guard = checkSessionProvider(db, sessionId, providers);
      if (!guard.ok) return guard;
      const result = activateSession(db, sessionId, taggingProvider);
      if (result.ok) {
        preflightId = sessionId;
      } else {
        console.error(`Failed to activate session: ${result.error}`);
      }
      return ok(undefined);
    },

    recordSuccess(resultSessionId, review, servingProvider) {
      if (!preflightId) {
        // Fresh review: tag provenance with the provider that actually served
        // (failover may have switched it), defaulting to the configured one.
        const sessionResult = getOrCreateSession(db, resultSessionId, servingProvider ?? taggingProvider);
        if (!sessionResult.ok) {
          console.error(`Failed to track session: ${sessionResult.error}`);
        }
      }
      const completeId = preflightId ?? resultSessionId;
      // saveReview and markSessionCompleted must succeed or fail together —
      // otherwise a save failure would leave the session marked complete with
      // no review row, producing inconsistent state across review_history /
      // review_status.
      try {
        db.transaction(() => {
          const saveResult = saveReview(db, review);
          if (!saveResult.ok) throw new Error(saveResult.error);
          const completeResult = markSessionCompleted(db, completeId);
          if (!completeResult.ok) throw new Error(completeResult.error);
        })();
      } catch (e) {
        console.error(`recordSuccess transaction failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    recordFailure(sessionId) {
      const id = preflightId ?? sessionId;
      if (!id) return;
      // Preflight path: row already exists from activateSession — single UPDATE.
      if (preflightId) {
        const failResult = markSessionFailed(db, preflightId);
        if (!failResult.ok) {
          console.error(`Failed to mark session failed: ${failResult.error}`);
        }
        return;
      }
      // Fresh-session path (T-001): chunk 1 created a Codex thread but no DB
      // row exists. Create-then-fail must be atomic so we never persist a row
      // that's missing the failed status.
      try {
        db.transaction(() => {
          const sessionResult = getOrCreateSession(db, id, taggingProvider);
          if (!sessionResult.ok) throw new Error(sessionResult.error);
          const failResult = markSessionFailed(db, id);
          if (!failResult.ok) throw new Error(failResult.error);
        })();
      } catch (e) {
        console.error(`recordFailure transaction failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    recordFailureBestEffort() {
      if (!preflightId) return;
      try { markSessionFailed(db, preflightId); } catch { /* best-effort */ }
    },
  };
}
