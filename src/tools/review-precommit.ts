import { TIER_HELP } from '../config/types.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { ReviewBackend } from '../backends/backend.js';
import type { ReviewBridgeConfig } from '../config/types.js';
import { sessionModelConflictMessage } from '../backends/orchestrator.js';
import {
  resolvePrecommitDiff,
  withCapturedFrom,
  NO_STAGED_CHANGES,
} from '../utils/resolve-diff.js';
import { escapeTerminalControls } from '../utils/terminal.js';
import { createSessionTracker } from '../storage/session-tracker.js';
import type { ReviewLifecycle } from '../review/lifecycle.js';
import { ModelSelectorSchema, SessionIdSchema } from '../utils/input-validation.js';

export function registerReviewPrecommitTool(
  server: McpServer,
  client: ReviewBackend,
  db: Database.Database | undefined,
  config: ReviewBridgeConfig,
  lifecycle?: ReviewLifecycle,
): void {
  server.registerTool(
    'review_precommit',
    {
      description:
        'Final sanity check right before committing. Auto-captures staged git changes. ' +
        'Call this after git add and before git commit to catch last-minute issues. ' +
        'Returns ready_to_commit, blockers, warnings, responding models, and persistence provenance. ' +
        'An auto-captured check also returns captured_from: the absolute directory the bridge ran ' +
        'git in. If that is not the repository you are working in, pass the diff explicitly.',
      inputSchema: {
        auto_diff: z
          .boolean()
          .optional()
          .describe(
            'Auto-capture staged git changes. Omit to use the project config default (review_standards.precommit.auto_diff).',
          ),
        diff: z.string().optional().describe('Explicit diff to review instead of auto-capture'),
        session_id: SessionIdSchema.optional().describe('Continue from previous review'),
        checklist: z.array(z.string()).optional().describe('Custom pre-commit checks'),
        model: ModelSelectorSchema.optional().describe(
          'Override the configured default model for this call (e.g., "gpt-5.6-sol"), or "latest". ' +
            TIER_HELP +
            ' ' +
            'With the Codex provider this cannot be combined with session_id; compare returned ' +
            'resolved and observed labels for runtime changes. Gemini allows changing model on resume.',
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
        // An explicit auto_diff arg wins; otherwise fall back to the project
        // config default (config is the validated ReviewBridgeConfig, so the
        // field is always present — no optional chaining needed).
        const autoDiff = args.auto_diff ?? config.review_standards.precommit.auto_diff;
        const diffResult = await resolvePrecommitDiff({ diff: args.diff, auto_diff: autoDiff });
        // Set only when git actually ran. Every capture-derived field below comes
        // from this one value, never from a fresh cwd read (ISS-028).
        const capturedFrom = diffResult.capturedFrom;
        if (!diffResult.ok) {
          // "No staged changes" is not an error — return structured response. It
          // names the directory it looked in, so a capture that ran in the wrong
          // repository is visible instead of reading as a clean index.
          if (diffResult.error.startsWith(NO_STAGED_CHANGES)) {
            const emptyCapture = withCapturedFrom(
              {
                ready_to_commit: false,
                blockers: [],
                warnings: [
                  capturedFrom
                    ? `No staged changes found in ${escapeTerminalControls(capturedFrom)}`
                    : 'No staged changes found',
                ],
                session_id: args.session_id ?? randomUUID(),
                models: [],
                provenance: { persistence: 'not_recorded', warning: null },
              },
              capturedFrom,
            );
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(emptyCapture) }],
            };
          }
          return { content: [{ type: 'text' as const, text: diffResult.error }], isError: true };
        }
        const diff = diffResult.data;

        if (lifecycle) {
          const result = await lifecycle.reviewPrecommit({
            diff,
            checklist: args.checklist,
            session_id: args.session_id,
            model: args.model,
          });
          if (!result.ok) {
            return { content: [{ type: 'text' as const, text: result.error }], isError: true };
          }
          // Decorate after persistence: history stores the review, not where the
          // host happened to capture it.
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(withCapturedFrom(result.data, capturedFrom)),
              },
            ],
          };
        }

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

        tracker.recordSuccess(
          result.data.session_id,
          {
            session_id: result.data.session_id,
            type: 'precommit',
            verdict: result.data.ready_to_commit ? 'approve' : 'reject',
            summary: result.data.warnings.join('; ') || result.data.blockers.join('; ') || 'Clean',
            findings_json: JSON.stringify(result.data.blockers),
          },
          result.data.provider,
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(withCapturedFrom(result.data, capturedFrom)),
            },
          ],
        };
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
