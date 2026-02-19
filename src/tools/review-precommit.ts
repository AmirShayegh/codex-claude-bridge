import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { CodexClient } from '../codex/client.js';
import { getStagedDiff } from '../utils/git.js';
import { saveReview } from '../storage/reviews.js';
import { getOrCreateSession, markSessionCompleted, markSessionFailed, activateSession } from '../storage/sessions.js';

export function registerReviewPrecommitTool(server: McpServer, client: CodexClient, db?: Database.Database): void {
  server.registerTool(
    'review_precommit',
    {
      description: 'Quick pre-commit sanity check. Auto-captures staged git changes by default.',
      inputSchema: {
        auto_diff: z.boolean().optional().default(true).describe('Auto-capture staged git changes'),
        diff: z.string().optional().describe('Explicit diff to review instead of auto-capture'),
        session_id: z.string().optional().describe('Continue from previous review'),
        checklist: z.array(z.string()).optional().describe('Custom pre-commit checks'),
      },
    },
    async (args) => {
      let preflightSessionId: string | undefined;
      try {
        let diff: string;

        // Diff resolution precedence: explicit diff > auto_diff > error
        // auto_diff defaults to true when not provided (undefined !== false)
        if (args.diff) {
          diff = args.diff;
        } else if (args.auto_diff !== false) {
          const gitResult = await getStagedDiff();
          if (!gitResult.ok) {
            return { content: [{ type: 'text' as const, text: gitResult.error }], isError: true };
          }
          if (!gitResult.data) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    ready_to_commit: false,
                    blockers: [],
                    warnings: ['No staged changes found'],
                    session_id: args.session_id ?? '',
                  }),
                },
              ],
            };
          }
          diff = gitResult.data;
        } else {
          return {
            content: [{ type: 'text' as const, text: 'auto_diff disabled and no diff provided' }],
            isError: true,
          };
        }

        // Pre-flight: activate session after diff resolved, before client call
        if (db && typeof args.session_id === 'string') {
          const activateResult = activateSession(db, args.session_id);
          if (!activateResult.ok) {
            console.error(`Failed to activate session: ${activateResult.error}`);
          }
          preflightSessionId = args.session_id;
        }

        const result = await client.reviewPrecommit({
          diff,
          checklist: args.checklist,
          session_id: args.session_id,
        });
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
            type: 'precommit',
            verdict: result.data.ready_to_commit ? 'approve' : 'reject',
            summary: result.data.warnings.join('; ') || result.data.blockers.join('; ') || 'Clean',
            findings_json: JSON.stringify(result.data.blockers),
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
