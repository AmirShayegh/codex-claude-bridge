import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { CodexClient } from '../codex/client.js';
import { saveReview } from '../storage/reviews.js';
import { getOrCreateSession, markSessionCompleted, markSessionFailed, activateSession } from '../storage/sessions.js';

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
      let preflightSessionId: string | undefined;
      try {
        if (db && typeof args.session_id === 'string') {
          const activateResult = activateSession(db, args.session_id);
          if (!activateResult.ok) {
            console.error(`Failed to activate session: ${activateResult.error}`);
          }
          preflightSessionId = args.session_id;
        }

        const result = await client.reviewCode(args);
        if (!result.ok) {
          if (db && preflightSessionId) {
            const failResult = markSessionFailed(db, preflightSessionId);
            if (!failResult.ok) {
              console.error(`Failed to mark session failed: ${failResult.error}`);
            }
          }
          return { content: [{ type: 'text' as const, text: result.error }], isError: true };
        }
        if (db) {
          if (!preflightSessionId) {
            const sessionResult = getOrCreateSession(db, result.data.session_id);
            if (!sessionResult.ok) {
              console.error(`Failed to track session: ${sessionResult.error}`);
            }
          }
          const saveResult = saveReview(db, {
            session_id: result.data.session_id,
            type: 'code',
            verdict: result.data.verdict,
            summary: result.data.summary,
            findings_json: JSON.stringify(result.data.findings),
          });
          if (!saveResult.ok) {
            console.error(`Failed to save review: ${saveResult.error}`);
          }
          const completeResult = markSessionCompleted(db, result.data.session_id);
          if (!completeResult.ok) {
            console.error(`Failed to complete session: ${completeResult.error}`);
          }
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data) }] };
      } catch (e) {
        if (db && preflightSessionId) {
          try { markSessionFailed(db, preflightSessionId); } catch { /* best-effort */ }
        }
        return {
          content: [{ type: 'text' as const, text: `Unexpected error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  );
}
