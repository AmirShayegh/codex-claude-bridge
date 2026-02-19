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
    expect(parsed.session_id).toBe('nonexistent');
    expect(parsed.elapsed_seconds).toBeUndefined();
  });

  it('in_progress session returns status with elapsed_seconds', async () => {
    getOrCreateSession(db, 'thread_active');

    const result = await handler({ session_id: 'thread_active' }, {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('in_progress');
    expect(parsed.session_id).toBe('thread_active');
    expect(typeof parsed.elapsed_seconds).toBe('number');
    expect(parsed.elapsed_seconds).toBeGreaterThanOrEqual(0);
  });

  it('completed session returns frozen elapsed_seconds', async () => {
    // Set created_at and completed_at to known values 30 seconds apart
    db.prepare(
      "INSERT INTO sessions (session_id, status, created_at, completed_at) VALUES (?, 'completed', '2026-01-01 00:00:00', '2026-01-01 00:00:30')",
    ).run('thread_frozen');

    const result = await handler({ session_id: 'thread_frozen' }, {});

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('completed');
    expect(parsed.elapsed_seconds).toBe(30);
  });

  it('failed session returns frozen elapsed_seconds', async () => {
    db.prepare(
      "INSERT INTO sessions (session_id, status, created_at, completed_at) VALUES (?, 'failed', '2026-01-01 00:00:00', '2026-01-01 00:01:00')",
    ).run('thread_failed');

    const result = await handler({ session_id: 'thread_failed' }, {});

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('failed');
    expect(parsed.elapsed_seconds).toBe(60);
  });

  it('completed session without completed_at falls back to now', async () => {
    // Edge case: old data before migration
    getOrCreateSession(db, 'thread_old');
    db.prepare("UPDATE sessions SET status = 'completed' WHERE session_id = ?").run('thread_old');

    const result = await handler({ session_id: 'thread_old' }, {});

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('completed');
    expect(typeof parsed.elapsed_seconds).toBe('number');
    expect(parsed.elapsed_seconds).toBeGreaterThanOrEqual(0);
  });

  it('storage error returns MCP error', async () => {
    db.close();

    const result = await handler({ session_id: 'any' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unexpected error');
  });
});
