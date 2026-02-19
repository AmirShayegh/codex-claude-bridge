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
          .prepare('SELECT session_id, status, created_at FROM sessions WHERE session_id = ?')
          .get(args.session_id) as SessionInfo | undefined;

        if (!row) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ status: 'not_found', session_id: args.session_id }) }],
          };
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: row.status, session_id: row.session_id, created_at: row.created_at }) }],
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
