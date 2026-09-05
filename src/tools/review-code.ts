import { TIER_HELP } from '../config/types.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { ReviewBackend } from '../backends/backend.js';
import { sessionModelConflictMessage } from '../backends/orchestrator.js';
import { resolveCodeDiff, NO_WORKING_CHANGES } from '../utils/resolve-diff.js';
import { createSessionTracker } from '../storage/session-tracker.js';
import type { ReviewLifecycle } from '../review/lifecycle.js';
import { ModelSelectorSchema, SessionIdSchema } from '../utils/input-validation.js';

export function registerReviewCodeTool(
  server: McpServer,
  client: ReviewBackend,
  db?: Database.Database,
  lifecycle?: ReviewLifecycle,
): void {
  server.registerTool(
    'review_code',
    {
      description:
        'Get an independent code review of your changes before committing. ' +
        'Call this after writing or modifying code. Pass a git diff as input. ' +
        'The diff parameter MUST contain actual git diff output (from git diff, gh pr diff, etc.), ' +
        'NOT a summary or description of changes. ' +
        'If you reviewed a plan first, pass the same session_id so the reviewer checks the code against the plan. ' +
        'Returns a verdict, findings, responding models, and persistence provenance.',
      inputSchema: {
        diff: z
          .string()
          .optional()
          .describe(
            'Raw git diff output to review. Must be unified diff format ' +
              '(output of git diff, gh pr diff, etc.). Do NOT pass summaries or descriptions. ' +
              'If omitted, auto-captures changes via git diff HEAD.',
          ),
        auto_diff: z
          .boolean()
          .optional()
          .default(true)
          .describe('Auto-capture working tree changes (staged + unstaged) via git diff HEAD'),
        context: z.string().optional().describe('Intent of the changes'),
        session_id: SessionIdSchema.optional().describe('Continue from previous review'),
        criteria: z.array(z.string()).optional().describe('Review criteria to focus on'),
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
      // The shared lifecycle performs owner-aware validation before admission;
      // this scalar gate remains only for the no-lifecycle compatibility path.
      if (!lifecycle && !client.allowsModelOverrideOnResume && args.session_id && args.model) {
        return {
          content: [{ type: 'text' as const, text: sessionModelConflictMessage() }],
          isError: true,
        };
      }
      const tracker = createSessionTracker(db, client.providers, client.provider);
      try {
        // Resolve diff (auto-capture or explicit)
        const diffResult = await resolveCodeDiff({
          diff: args.diff,
          auto_diff: args.auto_diff ?? true,
        });
        if (!diffResult.ok) {
          if (diffResult.error.startsWith(NO_WORKING_CHANGES)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    verdict: 'approve',
                    summary: 'No changes found to review.',
                    findings: [],
                    session_id: args.session_id ?? randomUUID(),
                    models: [],
                    provenance: { persistence: 'not_recorded', warning: null },
                  }),
                },
              ],
            };
          }
          return { content: [{ type: 'text' as const, text: diffResult.error }], isError: true };
        }
        const diff = diffResult.data;

        if (lifecycle) {
          const result = await lifecycle.reviewCode({ ...args, diff });
          if (!result.ok) {
            return { content: [{ type: 'text' as const, text: result.error }], isError: true };
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify(result.data) }] };
        }

        const preflight = tracker.preflight(args.session_id);
        if (!preflight.ok) {
          return { content: [{ type: 'text' as const, text: preflight.error }], isError: true };
        }

        const result = await client.reviewCode({ ...args, diff });
        if (!result.ok) {
          tracker.recordFailure(result.session_id);
          return { content: [{ type: 'text' as const, text: result.error }], isError: true };
        }

        tracker.recordSuccess(
          result.data.session_id,
          {
            session_id: result.data.session_id,
            type: 'code',
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
