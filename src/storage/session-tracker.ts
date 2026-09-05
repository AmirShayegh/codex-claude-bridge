import type Database from 'better-sqlite3';
import type { SaveReviewInput } from './reviews.js';
import { getOrCreateSession, getSessionProvider, markSessionFailed } from './sessions.js';
import { recordReviewOutcome } from './review-outcome.js';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import { escapeTerminalControls } from '../utils/terminal.js';
import type { ReviewProvider } from '../config/types.js';
import { toReviewProvider } from '../config/types.js';

export interface SessionTracker {
  // Returns an error when the resumed session was created by a different
  // provider than the active backend — the tool aborts before reviewing.
  preflight(sessionId: string | undefined): Result<void>;
  // servingProvider, when set, is the provider that actually produced the review
  // (may differ from the tracker's configured provider under failover). It tags
  // a NEW session's provenance so a failed-over session is owned by the provider
  // that served it. Falls back to the configured provider when omitted.
  recordSuccess(
    resultSessionId: string,
    review: SaveReviewInput,
    servingProvider?: ReviewProvider,
    ownerModelIdentity?: unknown,
  ): Result<void>;
  // sessionId surfaces partial-chunk failures where chunk 1 created a
  // Codex thread but a later chunk errored — the tool layer must mark
  // that thread's session failed rather than orphaning it (T-001).
  recordFailure(sessionId?: string): void;
  recordFailureBestEffort(): void;
}

const NULL_TRACKER: SessionTracker = {
  preflight: () => ok(undefined),
  recordSuccess: () => ok(undefined),
  recordFailure() {},
  recordFailureBestEffort() {},
};

// Read-only cross-provider guard. An absent/legacy row may fall back to the
// configured primary, but an unavailable lookup cannot safely guess which
// provider owns the conversation.
function inspectSessionProvider(
  db: Database.Database | undefined,
  sessionId: string | undefined,
  providers: readonly string[],
): Result<ReviewProvider | null> {
  if (typeof sessionId !== 'string') return ok(null);
  // No shared database at all (CLI run without a reviews.db, ISS-018) is not a
  // failed lookup: there is nothing to consult, so the guard fails OPEN and the
  // backend resolves routing itself. A database we HAVE but cannot read is the
  // unsafe case below.
  if (!db) return ok(null);
  let existing: ReturnType<typeof getSessionProvider>;
  try {
    existing = getSessionProvider(db, sessionId);
  } catch {
    return err(
      `${ErrorCode.SESSION_ROUTING_UNAVAILABLE}: session ownership could not be established safely`,
    );
  }
  if (!existing.ok) {
    return err(
      `${ErrorCode.SESSION_ROUTING_UNAVAILABLE}: session ownership could not be established safely`,
    );
  }
  if (!existing.data?.provider) return ok(null);
  const storedOwner = existing.data.provider;
  const owner = toReviewProvider(storedOwner);
  if (!owner) {
    return err(
      `${ErrorCode.SESSION_ROUTING_UNAVAILABLE}: session ownership could not be established safely`,
    );
  }
  if (!providers.includes(owner)) {
    return err(
      `${ErrorCode.PROVIDER_MISMATCH}: session ${sessionId} was created by the '${storedOwner}' provider, ` +
        `which is not active (available: ${providers.join(', ')}). Start a new session, or configure ` +
        `the '${storedOwner}' provider to continue this one.`,
    );
  }
  return ok(owner);
}

export function checkSessionProvider(
  db: Database.Database | undefined,
  sessionId: string | undefined,
  providers: readonly string[],
): Result<void> {
  const inspected = inspectSessionProvider(db, sessionId, providers);
  return inspected.ok ? ok(undefined) : inspected;
}

// providers is the guard set (every provider this backend serves); taggingProvider
// is the provider stamped on NEW sessions (a composite presents as its primary).
export function createSessionTracker(
  db: Database.Database | undefined,
  providers: readonly ReviewProvider[],
  taggingProvider: ReviewProvider,
): SessionTracker {
  if (!db) return NULL_TRACKER;

  let preflightId: string | undefined;
  let preflightProvider: ReviewProvider | undefined;

  return {
    preflight(sessionId) {
      if (typeof sessionId !== 'string') return ok(undefined);
      // Preflight is deliberately read-only. Persisting an in-progress row here
      // would claim durable state before the provider has produced anything and
      // would leave stale rows when the review or storage later fails.
      const guard = inspectSessionProvider(db, sessionId, providers);
      if (!guard.ok) return guard;
      preflightId = sessionId;
      preflightProvider = guard.data ?? taggingProvider;
      return ok(undefined);
    },

    recordSuccess(resultSessionId, review, servingProvider, ownerModelIdentity) {
      return recordReviewOutcome(db, {
        preflightSessionId: preflightId,
        preflightProvider,
        resultSessionId,
        servingProvider: servingProvider ?? taggingProvider,
        ownerModelIdentity,
        review,
      });
    },

    recordFailure(sessionId) {
      const id = preflightId ?? sessionId;
      if (!id) return;
      // No row is created during preflight. Once the provider actually fails,
      // create-if-absent and mark failed atomically so review_status still has a
      // durable terminal state for both resumed and fresh partial sessions.
      try {
        db.transaction(() => {
          const sessionResult = getOrCreateSession(db, id, taggingProvider);
          if (!sessionResult.ok) throw new Error(sessionResult.error);
          const failResult = markSessionFailed(db, id);
          if (!failResult.ok) throw new Error(failResult.error);
        })();
      } catch (e) {
        console.error(
          `recordFailure transaction failed: ${escapeTerminalControls(e instanceof Error ? e.message : String(e))}`,
        );
      }
    },

    recordFailureBestEffort() {
      if (!preflightId) return;
      const id = preflightId;
      try {
        db.transaction(() => {
          const sessionResult = getOrCreateSession(db, id, taggingProvider);
          if (!sessionResult.ok) throw new Error(sessionResult.error);
          const failResult = markSessionFailed(db, id);
          if (!failResult.ok) throw new Error(failResult.error);
        })();
      } catch {
        /* best-effort */
      }
    },
  };
}
