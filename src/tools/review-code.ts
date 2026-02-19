import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CodexClient } from '../codex/client.js';

export function registerReviewCodeTool(server: McpServer, client: CodexClient): void {
  server.registerTool(
    'review_code',
    {
      description: 'Send code changes (diff) to Codex for code review',
      inputSchema: {
        diff: z.string().describe('Git diff to review'),
        context: z.string().optional().describe('Intent of the changes'),
        session_id: z.string().optional().describe('Continue from previous review'),
        criteria: z.array(z.string()).optional().describe('Review criteria to focus on'),
      },
    },
    async (args) => {
      const result = await client.reviewCode(args);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: result.error }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data) }] };
    },
  );
}
