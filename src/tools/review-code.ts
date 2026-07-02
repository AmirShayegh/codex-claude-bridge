import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { ReviewBackend } from '../backends/backend.js';
import { sessionModelConflictMessage } from '../backends/orchestrator.js';
import { resolveCodeDiff, NO_WORKING_CHANGES } from '../utils/resolve-diff.js';
import { createSessionTracker } from '../storage/session-tracker.js';

export function registerReviewCodeTool(server: McpServer, client: ReviewBackend, db?: Database.Database): void {
  server.registerTool(
    'review_code',
    {
      description:
        'Get an independent code review of your changes before committing. ' +
        'Call this after writing or modifying code. Pass a git diff as input. ' +
        'The diff parameter MUST contain actual git diff output (from git diff, gh pr diff, etc.), ' +
        'NOT a summary or description of changes. ' +
        'If you reviewed a plan first, pass the same session_id so the reviewer checks the code against the plan. ' +
        'Returns a verdict (approve/request_changes/reject) and findings with file, line, severity, and suggestions.',
      inputSchema: {
        diff: z.string().optional().describe(
          'Raw git diff output to review. Must be unified diff format ' +
          '(output of git diff, gh pr diff, etc.). Do NOT pass summaries or descriptions. ' +
          'If omitted, auto-captures changes via git diff HEAD.',
        ),
        auto_diff: z.boolean().optional().default(true).describe(
          'Auto-capture working tree changes (staged + unstaged) via git diff HEAD',
        ),
        context: z.string().optional().describe('Intent of the changes'),
        session_id: z.string().optional().describe('Continue from previous review'),
        criteria: z.array(z.string()).optional().describe('Review criteria to focus on'),
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
      const tracker = createSessionTracker(db, client.providers, client.provider);
      try {
        // Resolve diff (auto-capture or explicit)
        const diffResult = await resolveCodeDiff({ diff: args.diff, auto_diff: args.auto_diff });
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
                    session_id: args.session_id ?? '',
                  }),
                },
              ],
            };
          }
          return { content: [{ type: 'text' as const, text: diffResult.error }], isError: true };
        }
        const diff = diffResult.data;

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
          content: [{ type: 'text' as const, text: `Unexpected error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  );
}
