import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from './config/loader.js';
import { DEFAULT_CONFIG } from './config/types.js';
import { createCodexClient } from './codex/client.js';
import { initDb } from './storage/reviews.js';
import { initSessionsDb } from './storage/sessions.js';
import { registerReviewPlanTool } from './tools/review-plan.js';
import { registerReviewCodeTool } from './tools/review-code.js';
import { registerReviewPrecommitTool } from './tools/review-precommit.js';
import { registerReviewHistoryTool } from './tools/review-history.js';
import { registerReviewStatusTool } from './tools/review-status.js';

export function createServer(): McpServer {
  const configResult = loadConfig();
  if (!configResult.ok) {
    console.error(`Config load failed, using defaults: ${configResult.error}`);
  }
  const config = configResult.ok ? configResult.data : DEFAULT_CONFIG;

  const client = createCodexClient(config);

  const dbPath = process.env.REVIEW_BRIDGE_DB ?? 'reviews.db';
  let db: InstanceType<typeof Database>;
  try {
    db = new Database(dbPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Database open failed (${dbPath}), falling back to in-memory: ${msg}`);
    db = new Database(':memory:');
  }
  initDb(db);
  initSessionsDb(db);

  const server = new McpServer({ name: 'codex-claude-bridge', version: '0.1.0' });

  registerReviewPlanTool(server, client, db);
  registerReviewCodeTool(server, client, db);
  registerReviewPrecommitTool(server, client, db);
  registerReviewHistoryTool(server, db);
  registerReviewStatusTool(server, db);

  return server;
}
