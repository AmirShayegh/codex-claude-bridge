import { TIER_HELP } from '../config/types.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { ReviewBackend } from '../backends/backend.js';
import { sessionModelConflictMessage } from '../backends/orchestrator.js';
import { createSessionTracker } from '../storage/session-tracker.js';
import type { ReviewLifecycle } from '../review/lifecycle.js';
import { ModelSelectorSchema, SessionIdSchema } from '../utils/input-validation.js';

export function registerReviewPlanTool(
  server: McpServer,
  client: ReviewBackend,
  db?: Database.Database,
  lifecycle?: ReviewLifecycle,
): void {
  server.registerTool(
    'review_plan',
    {
      description:
        'Get an independent code review of your implementation plan before writing code. ' +
        'Call this after drafting a plan and before implementing it. ' +
        'Returns a verdict (approve/revise/reject), findings, session_id, responding models, and persistence provenance. ' +
        'Pass the returned session_id to review_code later so the reviewer has full context.',
      inputSchema: {
        plan: z.string().describe('The implementation plan to review'),
        context: z.string().optional().describe('Project context and constraints'),
        focus: z.array(z.string()).optional().describe('Review focus areas'),
        depth: z.enum(['quick', 'thorough']).optional().describe('Review depth'),
        session_id: SessionIdSchema.optional().describe('Continue from a previous review session'),
        model: ModelSelectorSchema.optional().describe(
          'Override the configured default model for this call (e.g., "gpt-5.6-sol"), or "latest". ' +
            TIER_HELP +
            ' ' +
            'With the Codex provider this cannot be combined with session_id; compare returned ' +
            'resolved and observed labels for runtime changes. Gemini allows changing model on resume.',
        ),
        deliberate: z
          .boolean()
          .optional()
          .describe(
            'Per-call override of the configured review mode: true = both providers review (deliberation); ' +
              'false = single provider with failover. Omit to use the configured mode. Requires a two-provider ' +
              'setup; requesting deliberation under a single-provider config returns an error. Under ' +
              "deliberate-deep, the returned verdict reflects both providers' independent reviews and is NOT " +
              'recomputed from cross-review adjudications — treat deliberation.divergent[].adjudication as ' +
              'advisory input for your own synthesis.',
          ),
      },
    },
    async (args) => {
      // The shared lifecycle validates against the owning leaf before admission.
      // Keep the scalar gate only for the legacy no-lifecycle compatibility path.
      if (!lifecycle && !client.allowsModelOverrideOnResume && args.session_id && args.model) {
        return {
          content: [{ type: 'text' as const, text: sessionModelConflictMessage() }],
          isError: true,
        };
      }
      if (lifecycle) {
        try {
          const result = await lifecycle.reviewPlan(args);
          if (!result.ok) {
            return { content: [{ type: 'text' as const, text: result.error }], isError: true };
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify(result.data) }] };
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
      }
      const tracker = createSessionTracker(db, client.providers, client.provider);
      try {
        const preflight = tracker.preflight(args.session_id);
        if (!preflight.ok) {
          return { content: [{ type: 'text' as const, text: preflight.error }], isError: true };
        }

        const result = await client.reviewPlan(args);
        if (!result.ok) {
          tracker.recordFailure(result.session_id);
          return { content: [{ type: 'text' as const, text: result.error }], isError: true };
        }

        tracker.recordSuccess(
          result.data.session_id,
          {
            session_id: result.data.session_id,
            type: 'plan',
            verdict: result.data.verdict,
            summary: result.data.summary,
            findings_json: JSON.stringify(result.data.findings),
          },
          result.data.provider,
        );

        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data) }] };
      } catch (e) {
        tracker.recordFailureBestEffort();
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
