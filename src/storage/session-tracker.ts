import type Database from 'better-sqlite3';
import type { SaveReviewInput } from './reviews.js';
import { saveReview } from './reviews.js';
import { activateSession, getOrCreateSession, markSessionCompleted, markSessionFailed } from './sessions.js';

export interface SessionTracker {
  preflight(sessionId: string | undefined): void;
  recordSuccess(resultSessionId: string, review: SaveReviewInput): void;
  recordFailure(): void;
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

    recordFailure() {
      if (!preflightId) return;
      const failResult = markSessionFailed(db, preflightId);
      if (!failResult.ok) {
        console.error(`Failed to mark session failed: ${failResult.error}`);
      }
    },

    recordFailureBestEffort() {
      if (!preflightId) return;
      try { markSessionFailed(db, preflightId); } catch { /* best-effort */ }
    },
  };
}
