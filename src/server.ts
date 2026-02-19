import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from './config/loader.js';
import { DEFAULT_CONFIG } from './config/types.js';
import { createCodexClient } from './codex/client.js';
import { registerReviewPlanTool } from './tools/review-plan.js';
import { registerReviewCodeTool } from './tools/review-code.js';
import { registerReviewPrecommitTool } from './tools/review-precommit.js';

export function createServer(): McpServer {
  const configResult = loadConfig();
  if (!configResult.ok) {
    console.error(`Config load failed, using defaults: ${configResult.error}`);
  }
  const config = configResult.ok ? configResult.data : DEFAULT_CONFIG;

  const client = createCodexClient(config);

  const server = new McpServer({ name: 'codex-claude-bridge', version: '0.1.0' });

  registerReviewPlanTool(server, client);
  registerReviewCodeTool(server, client);
  registerReviewPrecommitTool(server, client);

  // Stub tools — real handlers come with storage layer (Phase 3)
  server.registerTool(
    'review_status',
    {
      description: 'Check status of an in-progress review',
      inputSchema: {
        session_id: z.string().describe('Session ID to check status of'),
      },
    },
    async () => {
      return {
        content: [{ type: 'text' as const, text: 'review_status is not yet implemented' }],
        isError: true,
      };
    },
  );

  server.registerTool(
    'review_history',
    {
      description: 'Query past reviews by session or count',
      inputSchema: {
        session_id: z.string().optional().describe('Specific session to query'),
        last_n: z.number().int().positive().optional().describe('Return last N reviews'),
      },
    },
    async () => {
      return {
        content: [{ type: 'text' as const, text: 'review_history is not yet implemented' }],
        isError: true,
      };
    },
  );

  return server;
}
