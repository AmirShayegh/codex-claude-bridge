import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { CodexClient } from '../codex/client.js';
import { saveReview } from '../storage/reviews.js';
import { getOrCreateSession, markSessionCompleted, markSessionFailed, activateSession } from '../storage/sessions.js';

export function registerReviewPlanTool(server: McpServer, client: CodexClient, db?: Database.Database): void {
  server.registerTool(
    'review_plan',
    {
      description: 'Send an implementation plan to Codex for architectural/feasibility review',
      inputSchema: {
        plan: z.string().describe('The implementation plan to review'),
        context: z.string().optional().describe('Project context and constraints'),
        focus: z.array(z.string()).optional().describe('Review focus areas'),
        depth: z.enum(['quick', 'thorough']).optional().describe('Review depth'),
        session_id: z.string().optional().describe('Continue from a previous review session'),
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

        const result = await client.reviewPlan(args);
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
            type: 'plan',
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
