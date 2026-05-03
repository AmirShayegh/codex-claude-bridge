import type Database from 'better-sqlite3';
import type { SaveReviewInput } from './reviews.js';
import { saveReview } from './reviews.js';
import { activateSession, getOrCreateSession, markSessionCompleted, markSessionFailed } from './sessions.js';

export interface SessionTracker {
  preflight(sessionId: string | undefined): void;
  recordSuccess(resultSessionId: string, review: SaveReviewInput): void;
  // sessionId surfaces partial-chunk failures where chunk 1 created a
  // Codex thread but a later chunk errored — the tool layer must mark
  // that thread's session failed rather than orphaning it (T-001).
  recordFailure(sessionId?: string): void;
  recordFailureBestEffort(): void;
}

const NULL_TRACKER: SessionTracker = {
  preflight() {},
  recordSuccess() {},
  recordFailure() {},
  recordFailureBestEffort() {},
};

export function createSessionTracker(db: Database.Database | undefined): SessionTracker {
  if (!db) return NULL_TRACKER;

  let preflightId: string | undefined;

  return {
    preflight(sessionId) {
      if (typeof sessionId !== 'string') return;
      const result = activateSession(db, sessionId);
      if (result.ok) {
        preflightId = sessionId;
      } else {
        console.error(`Failed to activate session: ${result.error}`);
      }
    },

    recordSuccess(resultSessionId, review) {
      if (!preflightId) {
        const sessionResult = getOrCreateSession(db, resultSessionId);
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
          const sessionResult = getOrCreateSession(db, id);
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
