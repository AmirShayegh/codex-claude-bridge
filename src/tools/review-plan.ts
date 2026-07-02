import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { ReviewBackend } from '../backends/backend.js';
import { sessionModelConflictMessage } from '../backends/orchestrator.js';
import { createSessionTracker } from '../storage/session-tracker.js';

export function registerReviewPlanTool(server: McpServer, client: ReviewBackend, db?: Database.Database): void {
  server.registerTool(
    'review_plan',
    {
      description:
        'Get an independent code review of your implementation plan before writing code. ' +
        'Call this after drafting a plan and before implementing it. ' +
        'Returns a verdict (approve/revise/reject), findings with severity and suggestions, and a session_id. ' +
        'Pass the returned session_id to review_code later so the reviewer has full context.',
      inputSchema: {
        plan: z.string().describe('The implementation plan to review'),
        context: z.string().optional().describe('Project context and constraints'),
        focus: z.array(z.string()).optional().describe('Review focus areas'),
        depth: z.enum(['quick', 'thorough']).optional().describe('Review depth'),
        session_id: z.string().optional().describe('Continue from a previous review session'),
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
      // Reject session_id + model only for backends that can't change model on
      // resume (Codex, whose SDK reasserts --model). Done here, before
      // preflight(), so this pure input error doesn't mark a valid session
      // `failed`. Backends that allow override on resume (Gemini) fall through
      // and honor the model — the orchestrator applies the same capability gate.
      if (!client.allowsModelOverrideOnResume && args.session_id && args.model) {
        return {
          content: [{ type: 'text' as const, text: sessionModelConflictMessage() }],
          isError: true,
        };
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
          content: [{ type: 'text' as const, text: `Unexpected error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  );
}
