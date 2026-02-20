import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { CodexClient } from '../codex/client.js';
import { createSessionTracker } from '../storage/session-tracker.js';

export function registerReviewPlanTool(server: McpServer, client: CodexClient, db?: Database.Database): void {
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
      },
    },
    async (args) => {
      const tracker = createSessionTracker(db);
      try {
        tracker.preflight(args.session_id);

        const result = await client.reviewPlan(args);
        if (!result.ok) {
          tracker.recordFailure();
          return { content: [{ type: 'text' as const, text: result.error }], isError: true };
        }

        tracker.recordSuccess(result.data.session_id, {
          session_id: result.data.session_id,
          type: 'plan',
          verdict: result.data.verdict,
          summary: result.data.summary,
          findings_json: JSON.stringify(result.data.findings),
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
