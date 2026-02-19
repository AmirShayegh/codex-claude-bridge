import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { SessionInfo } from '../storage/sessions.js';

export function registerReviewStatusTool(server: McpServer, db: Database.Database): void {
  server.registerTool(
    'review_status',
    {
      description: 'Check status of an in-progress review',
      inputSchema: {
        session_id: z.string().describe('Session ID to check status of'),
      },
    },
    async (args) => {
      try {
        const row = db
          .prepare('SELECT session_id, status, created_at, completed_at FROM sessions WHERE session_id = ?')
          .get(args.session_id) as SessionInfo | undefined;

        if (!row) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ status: 'not_found', session_id: args.session_id }) }],
          };
        }

        const createdAt = new Date(row.created_at + 'Z');
        let elapsedSeconds: number;
        if (row.completed_at) {
          const completedAt = new Date(row.completed_at + 'Z');
          elapsedSeconds = Math.round((completedAt.getTime() - createdAt.getTime()) / 1000);
        } else {
          elapsedSeconds = Math.round((Date.now() - createdAt.getTime()) / 1000);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: row.status,
              session_id: row.session_id,
              elapsed_seconds: elapsedSeconds,
            }),
          }],
        };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Unexpected error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  );
}
