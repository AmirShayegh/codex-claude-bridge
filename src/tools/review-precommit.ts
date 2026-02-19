import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { CodexClient } from '../codex/client.js';
import { getStagedDiff } from '../utils/git.js';
import { saveReview } from '../storage/reviews.js';

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

        const result = await client.reviewPrecommit({
          diff,
          checklist: args.checklist,
          session_id: args.session_id,
        });
        if (!result.ok) {
          return { content: [{ type: 'text' as const, text: result.error }], isError: true };
        }
        if (db) {
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
