import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { ReviewBackend } from '../backends/backend.js';
import { sessionModelConflictMessage } from '../backends/orchestrator.js';
import { resolvePrecommitDiff, NO_STAGED_CHANGES } from '../utils/resolve-diff.js';
import { createSessionTracker } from '../storage/session-tracker.js';

export function registerReviewPrecommitTool(server: McpServer, client: ReviewBackend, db?: Database.Database): void {
  server.registerTool(
    'review_precommit',
    {
      description:
        'Final sanity check right before committing. Auto-captures staged git changes. ' +
        'Call this after git add and before git commit to catch last-minute issues. ' +
        'Returns ready_to_commit (boolean), blockers that must be fixed, and warnings.',
      inputSchema: {
        auto_diff: z.boolean().optional().default(true).describe('Auto-capture staged git changes'),
        diff: z.string().optional().describe('Explicit diff to review instead of auto-capture'),
        session_id: z.string().optional().describe('Continue from previous review'),
        checklist: z.array(z.string()).optional().describe('Custom pre-commit checks'),
        model: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Override the configured default model for this call (e.g., "gpt-5.4"), or "latest". ' +
              'With the Codex provider this cannot be combined with session_id (a resumed thread ' +
              'keeps its model); the Gemini provider allows changing model on a resumed session.',
          ),
      },
    },
    async (args) => {
      // Reject session_id + model only when the backend can't change model on
      // resume. See review-plan.ts for the rationale.
      if (!client.allowsModelOverrideOnResume && args.session_id && args.model) {
        return {
          content: [{ type: 'text' as const, text: sessionModelConflictMessage() }],
          isError: true,
        };
      }
      const tracker = createSessionTracker(db, client.provider);
      try {
        const diffResult = await resolvePrecommitDiff({ diff: args.diff, auto_diff: args.auto_diff });
        if (!diffResult.ok) {
          // "No staged changes" is not an error — return structured response
          if (diffResult.error.startsWith(NO_STAGED_CHANGES)) {
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
          return { content: [{ type: 'text' as const, text: diffResult.error }], isError: true };
        }
        const diff = diffResult.data;

        // Pre-flight: guard cross-provider resume, then activate session after
        // diff resolved and before the client call.
        const preflight = tracker.preflight(args.session_id);
        if (!preflight.ok) {
          return { content: [{ type: 'text' as const, text: preflight.error }], isError: true };
        }

        const result = await client.reviewPrecommit({
          diff,
          checklist: args.checklist,
          session_id: args.session_id,
          model: args.model,
        });
        if (!result.ok) {
          tracker.recordFailure(result.session_id);
          return { content: [{ type: 'text' as const, text: result.error }], isError: true };
        }

        tracker.recordSuccess(result.data.session_id, {
          session_id: result.data.session_id,
          type: 'precommit',
          verdict: result.data.ready_to_commit ? 'approve' : 'reject',
          summary: result.data.warnings.join('; ') || result.data.blockers.join('; ') || 'Clean',
          findings_json: JSON.stringify(result.data.blockers),
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data) }] };
      } catch (e) {
        tracker.recordFailureBestEffort();
        return {
          content: [{ type: 'text' as const, text: `Unexpected error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  );
}
