import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { registerReviewStatusTool } from './review-status.js';
import { initSessionsDb, getOrCreateSession } from '../storage/sessions.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandlerFn = (args: Record<string, unknown>, extra: unknown) => Promise<any>;

let db: InstanceType<typeof Database>;
let mockServer: { registerTool: ReturnType<typeof vi.fn> };
let handler: HandlerFn;

beforeEach(() => {
  db = new Database(':memory:');
  initSessionsDb(db);
  mockServer = { registerTool: vi.fn() };
  registerReviewStatusTool(mockServer as unknown as McpServer, db);
  handler = mockServer.registerTool.mock.calls[0][2] as HandlerFn;
});

describe('registerReviewStatusTool', () => {
  it('registers tool with name review_status', () => {
    expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
    expect(mockServer.registerTool.mock.calls[0][0]).toBe('review_status');
  });

  it('unknown session_id returns not_found status', async () => {
    const result = await handler({ session_id: 'nonexistent' }, {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('not_found');
  });

  it('active session returns active status', async () => {
    getOrCreateSession(db, 'thread_active');

    const result = await handler({ session_id: 'thread_active' }, {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('active');
    expect(parsed.session_id).toBe('thread_active');
  });

  it('completed session returns completed status', async () => {
    getOrCreateSession(db, 'thread_done');
    db.prepare("UPDATE sessions SET status = 'completed' WHERE session_id = ?").run('thread_done');

    const result = await handler({ session_id: 'thread_done' }, {});

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('completed');
  });

  it('storage error returns MCP error', async () => {
    db.close();

    const result = await handler({ session_id: 'any' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unexpected error');
  });
});
