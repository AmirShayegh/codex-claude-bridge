import { MODEL_PARAM_HELP, ReviewTierSchema, TIER_PARAM_HELP } from '../config/types.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { ReviewBackend } from '../backends/backend.js';
import { sessionModelConflictMessage } from '../backends/orchestrator.js';
import { normalizeCodeDiffSource, withCapturedFrom } from '../utils/resolve-diff.js';
import { escapeTerminalControls } from '../utils/terminal.js';
import { createSessionTracker } from '../storage/session-tracker.js';
import type { ReviewLifecycle } from '../review/lifecycle.js';
import {
  CWD_DESCRIPTION,
  GitRefSchema,
  ModelSelectorSchema,
  SessionIdSchema,
  WorkingDirectorySchema,
} from '../utils/input-validation.js';
import { prepareDiffReview } from '../review/request-prep.js';
import {
  classifyToolArguments,
  invalidInputResponse,
  selectModel,
  toolInputSchema,
  withArgumentReport,
} from './tool-input.js';
import type { RequestPreparationDeps } from '../review/request-prep.js';

// The accepted parameters, kept as a plain shape so the handler can classify
// whatever else the call carried (ISS-054).
const CODE_INPUT = {
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
  base: GitRefSchema.optional().describe(
    'Review a committed range instead: the ref to diff FROM (e.g. "main", "origin/main", ' +
      'a commit, or "HEAD~1"). Runs git diff <base> <head> in cwd. Cannot be combined with diff.',
  ),
  head: GitRefSchema.optional().describe(
    'The ref to diff TO when base is given (default: "HEAD"). Requires base.',
  ),
  cwd: WorkingDirectorySchema.optional().describe(CWD_DESCRIPTION),
  context: z.string().optional().describe('Intent of the changes'),
  session_id: SessionIdSchema.optional().describe('Continue from previous review'),
  criteria: z.array(z.string()).optional().describe('Review criteria to focus on'),
  model: ModelSelectorSchema.optional().describe(MODEL_PARAM_HELP),
  tier: ReviewTierSchema.optional().describe(TIER_PARAM_HELP),
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
};

export function registerReviewCodeTool(
  server: McpServer,
  client: ReviewBackend,
  prep: RequestPreparationDeps,
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
        'NOT a summary or description of changes. To review a branch or landed commits, pass base ' +
        '(and optionally head) instead and the bridge runs git diff base head in cwd. ' +
        'If you reviewed a plan first, pass the same session_id so the reviewer checks the code against the plan. ' +
        'Returns a verdict, findings, responding models, and persistence provenance. ' +
        'An auto-captured review also returns captured_from: the absolute directory the bridge ran ' +
        'git in. If that is not the repository you are working in, pass the diff explicitly.',
      inputSchema: toolInputSchema(CODE_INPUT),
    },
    async (rawArgs) => {
      // Unknown keys are folded, echoed, or refused here (ISS-054), never
      // silently stripped; model/tier collapse to the one selector backends take.
      const classified = classifyToolArguments(CODE_INPUT, rawArgs, { refuseSelectorIntent: true });
      if (!classified.ok) return invalidInputResponse(classified.error);
      const { args, report } = classified.data;
      const selector = selectModel(args);
      if (!selector.ok) return invalidInputResponse(selector.error);
      const model = selector.data;
      // The shared lifecycle performs owner-aware validation before admission;
      // this scalar gate remains only for the no-lifecycle compatibility path.
      if (!lifecycle && !client.allowsModelOverrideOnResume && args.session_id && model) {
        return {
          content: [{ type: 'text' as const, text: sessionModelConflictMessage() }],
          isError: true,
        };
      }
      // Decide the diff SOURCE from the arguments alone, before any filesystem
      // work: an explicit diff never touches git, whatever cwd was requested.
      const source = normalizeCodeDiffSource({
        diff: args.diff,
        auto_diff: args.auto_diff ?? true,
        base: args.base,
        head: args.head,
      });
      if (!source.ok) {
        return { content: [{ type: 'text' as const, text: source.error }], isError: true };
      }

      const tracker = createSessionTracker(db, client.providers, client.provider);
      try {
        const prepared = await prepareDiffReview(prep, { cwd: args.cwd, source: source.data });
        if (!prepared.ok) {
          return { content: [{ type: 'text' as const, text: prepared.error }], isError: true };
        }
        if (prepared.data.kind === 'empty-capture') {
          // An empty capture is a real (approving) answer, so it must still say
          // WHERE it looked — otherwise it is indistinguishable from a capture
          // that ran in the wrong repository.
          const where = escapeTerminalControls(prepared.data.capturedFrom);
          const range =
            source.data.kind === 'capture' && source.data.target === 'range' ? source.data : null;
          const emptyCapture = withCapturedFrom(
            {
              verdict: 'approve',
              // A range names its refs (probe-loop, ISS-049): "no changes in
              // <dir>" reads as a clean tree, which is not what was asked.
              summary: range
                ? `No changes between ${range.base} and ${range.head} in ${where}.`
                : `No changes found to review in ${where}.`,
              findings: [],
              session_id: args.session_id ?? randomUUID(),
              models: [],
              provenance: { persistence: 'not_recorded', warning: null },
            },
            prepared.data.capturedFrom,
          );
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(withArgumentReport(emptyCapture, report)),
              },
            ],
          };
        }
        // Set only when git actually ran. Every capture-derived field below comes
        // from this one value, never from a fresh cwd read (ISS-028).
        const { diff, capturedFrom, execution } = prepared.data;
        // Built explicitly, never spread from `args`.
        const input = {
          diff,
          execution,
          context: args.context,
          criteria: args.criteria,
          session_id: args.session_id,
          model,
          deliberate: args.deliberate,
        };

        if (lifecycle) {
          const result = await lifecycle.reviewCode(input);
          if (!result.ok) {
            return { content: [{ type: 'text' as const, text: result.error }], isError: true };
          }
          // Decorate after persistence: history stores the review, not where the
          // host happened to capture it.
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  withArgumentReport(withCapturedFrom(result.data, capturedFrom), report),
                ),
              },
            ],
          };
        }

        const preflight = tracker.preflight(args.session_id);
        if (!preflight.ok) {
          return { content: [{ type: 'text' as const, text: preflight.error }], isError: true };
        }

        const result = await client.reviewCode(input);
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

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                withArgumentReport(withCapturedFrom(result.data, capturedFrom), report),
              ),
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
