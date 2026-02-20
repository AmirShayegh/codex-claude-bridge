import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { CodexClient } from '../codex/client.js';
import { createSessionTracker } from '../storage/session-tracker.js';

export function registerReviewCodeTool(server: McpServer, client: CodexClient, db?: Database.Database): void {
  server.registerTool(
    'review_code',
    {
      description:
        'Get an independent code review of your changes before committing. ' +
        'Call this after writing or modifying code. Pass a git diff as input. ' +
        'If you reviewed a plan first, pass the same session_id so the reviewer checks the code against the plan. ' +
        'Returns a verdict (approve/request_changes/reject) and findings with file, line, severity, and suggestions.',
      inputSchema: {
        diff: z.string().describe('Git diff to review'),
        context: z.string().optional().describe('Intent of the changes'),
        session_id: z.string().optional().describe('Continue from previous review'),
        criteria: z.array(z.string()).optional().describe('Review criteria to focus on'),
      },
    },
    async (args) => {
      const tracker = createSessionTracker(db);
      try {
        tracker.preflight(args.session_id);

        const result = await client.reviewCode(args);
        if (!result.ok) {
          tracker.recordFailure();
          return { content: [{ type: 'text' as const, text: result.error }], isError: true };
        }

        tracker.recordSuccess(result.data.session_id, {
          session_id: result.data.session_id,
          type: 'code',
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
