import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { ReviewBackend } from '../backends/backend.js';
import type { ReviewBridgeConfig } from '../config/types.js';
import { sessionModelConflictMessage } from '../backends/orchestrator.js';
import { resolvePrecommitDiff, NO_STAGED_CHANGES } from '../utils/resolve-diff.js';
import { resolveCwd } from '../utils/cwd.js';
import { discoverProjectConfig } from '../config/loader.js';
import { createSessionTracker } from '../storage/session-tracker.js';

export function registerReviewPrecommitTool(
  server: McpServer,
  client: ReviewBackend,
  db: Database.Database | undefined,
  config: ReviewBridgeConfig,
): void {
  server.registerTool(
    'review_precommit',
    {
      description:
        'Final sanity check right before committing. Auto-captures staged git changes. ' +
        'Call this after git add and before git commit to catch last-minute issues. ' +
        'Returns ready_to_commit (boolean), blockers that must be fixed, and warnings.',
      inputSchema: {
        auto_diff: z
          .boolean()
          .optional()
          .describe('Auto-capture staged git changes. Omit to use the project config default (review_standards.precommit.auto_diff).'),
        diff: z.string().optional().describe('Explicit diff to review instead of auto-capture'),
        session_id: z.string().optional().describe('Continue from previous review'),
        checklist: z.array(z.string()).optional().describe('Custom pre-commit checks'),
        model: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Override the configured default model for this call (e.g., "gpt-5.5"), or "latest". ' +
              'With the Codex provider this cannot be combined with session_id (a resumed thread ' +
              'keeps its model); the Gemini provider allows changing model on a resumed session.',
          ),
        cwd: z
          .string()
          .optional()
          .describe(
            'Repository directory for auto-capture and config discovery; git commands run here, ' +
              "and this repo's .reviewbridge.json (if any, searched by walking up from here) is " +
              'used for defaults like auto_diff. Defaults to the server process cwd.',
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
      const cwdResult = resolveCwd(args.cwd);
      if (!cwdResult.ok) {
        return { content: [{ type: 'text' as const, text: cwdResult.error }], isError: true };
      }
      const cwd = cwdResult.data;

      // config is loaded once at server startup from the server process's own
      // launch directory (src/server.ts), so it can't reflect a repo named by
      // a per-call cwd. When the caller names one, walk up from THAT
      // directory the same way the server's own boot-time discovery would
      // (discoverProjectConfig — same walk-up/.git-boundary algorithm as
      // loadConfig()'s implicit mode, just anchored at cwd instead of
      // process.cwd()), so a repo-root .reviewbridge.json becomes reachable
      // even when cwd names a SUBDIRECTORY of that repo. This only affects
      // the one field this tool reads per call
      // (review_standards.precommit.auto_diff) — provider/backend selection,
      // deliberate-mode capability, and copilot instructions are still wired
      // once when the backend is constructed at server startup and stay tied
      // to the server's launch directory; re-resolving those per call would
      // mean reconstructing the backend per call, out of scope for this fix.
      //
      // If nothing is found anywhere up the tree from cwd, precommitConfig
      // stays the server's own BOOT-TIME config — never built-in schema
      // defaults. Falling back to schema defaults here would silently
      // discard whatever the server actually loaded at startup
      // (RB_CONFIG_PATH, $HOME/.reviewbridge.json, or its own
      // launch-directory walk-up): e.g. a user who set
      // precommit.auto_diff:false globally would see it silently reset to
      // the schema default (true) the instant they passed a cwd whose own
      // tree has no config file of its own.
      let precommitConfig = config;
      if (cwd !== undefined) {
        const discovered = discoverProjectConfig(cwd);
        if (!discovered.ok) {
          return { content: [{ type: 'text' as const, text: discovered.error }], isError: true };
        }
        if (discovered.data) {
          precommitConfig = discovered.data.config;
        }
        // else: nothing found walking up from cwd — precommitConfig stays
        // the boot-time config set above, by design.
      }

      const tracker = createSessionTracker(db, client.providers, client.provider);
      try {
        // An explicit auto_diff arg wins; otherwise fall back to the project
        // config default (config is the validated ReviewBridgeConfig, so the
        // field is always present — no optional chaining needed).
        const autoDiff = args.auto_diff ?? precommitConfig.review_standards.precommit.auto_diff;
        const diffResult = await resolvePrecommitDiff({
          diff: args.diff,
          auto_diff: autoDiff,
          cwd,
        });
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
          cwd,
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
