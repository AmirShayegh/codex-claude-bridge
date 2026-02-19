import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CodexClient } from '../codex/client.js';

export function registerReviewPlanTool(server: McpServer, client: CodexClient): void {
  server.registerTool(
    'review_plan',
    {
      description: 'Send an implementation plan to Codex for architectural/feasibility review',
      inputSchema: {
        plan: z.string().describe('The implementation plan to review'),
        context: z.string().optional().describe('Project context and constraints'),
        focus: z.array(z.string()).optional().describe('Review focus areas'),
        depth: z.enum(['quick', 'thorough']).optional().describe('Review depth'),
        session_id: z.string().optional().describe('Continue from a previous review session'),
      },
    },
    async (args) => {
      try {
        const result = await client.reviewPlan(args);
        if (!result.ok) {
          return { content: [{ type: 'text' as const, text: result.error }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data) }] };
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Unexpected error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  );
}
