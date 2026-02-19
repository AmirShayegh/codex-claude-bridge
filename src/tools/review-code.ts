import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { CodexClient } from '../codex/client.js';
import { saveReview } from '../storage/reviews.js';

export function registerReviewCodeTool(server: McpServer, client: CodexClient, db?: Database.Database): void {
  server.registerTool(
    'review_code',
    {
      description: 'Send code changes (diff) to Codex for code review',
      inputSchema: {
        diff: z.string().describe('Git diff to review'),
        context: z.string().optional().describe('Intent of the changes'),
        session_id: z.string().optional().describe('Continue from previous review'),
        criteria: z.array(z.string()).optional().describe('Review criteria to focus on'),
      },
    },
    async (args) => {
      try {
        const result = await client.reviewCode(args);
        if (!result.ok) {
          return { content: [{ type: 'text' as const, text: result.error }], isError: true };
        }
        if (db) {
          saveReview(db, {
            session_id: result.data.session_id,
            type: 'code',
            verdict: result.data.verdict,
            summary: result.data.summary,
            findings_json: JSON.stringify(result.data.findings),
          });
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
