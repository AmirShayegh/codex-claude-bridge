import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { SessionInfo } from '../storage/sessions.js';
import type { SessionRegistry } from '../storage/session-registry.js';
import { SessionIdSchema } from '../utils/input-validation.js';

export function registerReviewStatusTool(
  server: McpServer,
  db: Database.Database,
  registry?: SessionRegistry,
): void {
  server.registerTool(
    'review_status',
    {
      description:
        'Check whether a review session is still running, completed, or failed. ' +
        'Use this if a review call timed out or you need to verify session state.',
      inputSchema: {
        session_id: SessionIdSchema.describe('Session ID to check status of'),
      },
    },
    async (args) => {
      try {
        const live = registry?.getStatus(args.session_id);
        if (live) {
          const end = live.completedAt ?? Date.now();
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: live.status,
                  session_id: live.sessionId,
                  elapsed_seconds: Math.max(0, Math.round((end - live.startedAt) / 1000)),
                  // Where the clock comes from (ISS-046): wall time since this
                  // process admitted the review, not provider progress.
                  elapsed_source: 'live_registry',
                  elapsed_basis: 'wall_clock',
                  started_at: new Date(live.startedAt).toISOString(),
                  completed_at:
                    live.completedAt === null ? null : new Date(live.completedAt).toISOString(),
                }),
              },
            ],
          };
        }
        const row = db
          .prepare(
            'SELECT session_id, status, created_at, completed_at FROM sessions WHERE session_id = ?',
          )
          .get(args.session_id) as SessionInfo | undefined;

        if (!row) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ status: 'not_found', session_id: args.session_id }),
              },
            ],
          };
        }

        const createdAt = new Date(row.created_at + 'Z');
        const completedAt = row.completed_at ? new Date(row.completed_at + 'Z') : null;
        const end = completedAt ?? new Date();
        const elapsedSeconds = Math.round((end.getTime() - createdAt.getTime()) / 1000);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: row.status,
                session_id: row.session_id,
                elapsed_seconds: elapsedSeconds,
                // Wall time since the stored session row was created (ISS-046).
                elapsed_source: 'history_db',
                elapsed_basis: 'wall_clock',
                started_at: createdAt.toISOString(),
                completed_at: completedAt === null ? null : completedAt.toISOString(),
              }),
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
