import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { getReviewsBySession, getRecentReviews } from '../storage/reviews.js';

export function registerReviewHistoryTool(server: McpServer, db: Database.Database): void {
  server.registerTool(
    'review_history',
    {
      description: 'Query past reviews by session or count',
      inputSchema: {
        session_id: z.string().optional().describe('Specific session to query'),
        last_n: z.number().int().positive().optional().describe('Return last N reviews'),
      },
    },
    async (args) => {
      try {
        if (args.session_id) {
          const result = getReviewsBySession(db, args.session_id);
          if (!result.ok) {
            return { content: [{ type: 'text' as const, text: result.error }], isError: true };
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify(result.data) }] };
        }

        const limit = args.last_n ?? 10;
        const result = getRecentReviews(db, limit);
        if (!result.ok) {
          return { content: [{ type: 'text' as const, text: result.error }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data) }] };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Unexpected error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  );
}
