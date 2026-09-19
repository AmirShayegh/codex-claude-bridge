import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { getRecentReviewsPage, getReviewsBySessionPage } from '../storage/reviews.js';
import { getSession } from '../storage/sessions.js';
import { SessionIdSchema } from '../utils/input-validation.js';
import { storageUnavailable } from '../utils/errors.js';
import {
  classifyToolArguments,
  invalidInputResponse,
  toolInputSchema,
  withArgumentReport,
} from './tool-input.js';

// The session's own state, so a review that failed or timed out — which never
// produces a review row — still leaves evidence under its id (ISS-046). Null
// when the session has never been seen; a read failure also reads as null
// rather than failing the history query.
function sessionState(db: Database.Database, sessionId: string) {
  const found = getSession(db, sessionId);
  if (!found.ok || found.data === null) return null;
  const row = found.data;
  return {
    status: row.status,
    provider: row.provider,
    created_at: new Date(row.created_at + 'Z').toISOString(),
    completed_at: row.completed_at ? new Date(row.completed_at + 'Z').toISOString() : null,
  };
}

const ReviewCursorSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'cursor must be a positive decimal review-row ID')
  .refine((value) => Number.isSafeInteger(Number(value)), 'cursor is outside the safe range');

// The accepted parameters, kept as a plain shape so the handler can classify
// whatever else the call carried (ISS-054).
const HISTORY_INPUT = {
  session_id: SessionIdSchema.optional().describe('Specific session to query'),
  last_n: z.number().int().min(1).max(100).optional().describe('Return 1–100 reviews'),
  cursor: ReviewCursorSchema.optional().describe(
    'Decimal review-row cursor returned as next_cursor by the preceding page',
  ),
};

// `db` is undefined when storage never opened (ISS-042); `unavailableReason` is
// the startup diagnosis, repeated on every call so the caller can act on it.
export function registerReviewHistoryTool(
  server: McpServer,
  db: Database.Database | undefined,
  unavailableReason?: string,
): void {
  server.registerTool(
    'review_history',
    {
      description:
        'Look up past review results. Query by session_id to see all reviews in a session, ' +
        'or use last_n to get recent reviews. Results include immutable responding-model snapshots ' +
        "and a next_cursor for bounded pagination. A session_id query also returns the session's " +
        'own state (in_progress / completed / failed with timestamps), so a review that failed or ' +
        'timed out is visible even though it produced no review row.',
      inputSchema: toolInputSchema(HISTORY_INPUT),
    },
    async (rawArgs) => {
      // Fold or echo unknown keys (ISS-054). A lookup never refuses: nothing
      // here can be the wrong review, so a stray selector word is only echoed.
      const classified = classifyToolArguments(HISTORY_INPUT, rawArgs, {
        refuseSelectorIntent: false,
      });
      if (!classified.ok) return invalidInputResponse(classified.error);
      const { args, report } = classified.data;
      if (!db) {
        return {
          content: [{ type: 'text' as const, text: storageUnavailable(unavailableReason) }],
          isError: true,
        };
      }
      try {
        if (args.session_id) {
          const result = getReviewsBySessionPage(db, args.session_id, {
            limit: args.last_n ?? 100,
            cursor: args.cursor,
          });
          if (!result.ok) {
            return { content: [{ type: 'text' as const, text: result.error }], isError: true };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  withArgumentReport(
                    {
                      reviews: result.data.items,
                      next_cursor: result.data.nextCursor,
                      session: sessionState(db, args.session_id),
                    },
                    report,
                  ),
                ),
              },
            ],
          };
        }

        const limit = args.last_n ?? 10;
        const result = getRecentReviewsPage(db, { limit, cursor: args.cursor });
        if (!result.ok) {
          return { content: [{ type: 'text' as const, text: result.error }], isError: true };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                withArgumentReport(
                  {
                    reviews: result.data.items,
                    next_cursor: result.data.nextCursor,
                  },
                  report,
                ),
              ),
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Unexpected error: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
