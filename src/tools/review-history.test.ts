import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { registerReviewHistoryTool } from './review-history.js';
import { initDb, saveReview } from '../storage/reviews.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandlerFn = (args: Record<string, unknown>, extra: unknown) => Promise<any>;

let db: InstanceType<typeof Database>;
let mockServer: { registerTool: ReturnType<typeof vi.fn> };
let handler: HandlerFn;

beforeEach(() => {
  db = new Database(':memory:');
  initDb(db);
  mockServer = { registerTool: vi.fn() };
  registerReviewHistoryTool(mockServer as unknown as McpServer, db);
  handler = mockServer.registerTool.mock.calls[0][2] as HandlerFn;
});

describe('registerReviewHistoryTool', () => {
  it('registers tool with name review_history', () => {
    expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
    expect(mockServer.registerTool.mock.calls[0][0]).toBe('review_history');
  });

  it('returns reviews for a specific session_id', async () => {
    saveReview(db, {
      session_id: 'thread_1',
      type: 'plan',
      verdict: 'approve',
      summary: 'Good plan',
      findings_json: '[]',
    });

    const result = await handler({ session_id: 'thread_1' }, {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].summary).toBe('Good plan');
  });

  it('returns last_n recent reviews when no session_id', async () => {
    saveReview(db, {
      session_id: 'thread_a',
      type: 'plan',
      verdict: 'approve',
      summary: 'First',
      findings_json: '[]',
    });
    saveReview(db, {
      session_id: 'thread_b',
      type: 'code',
      verdict: 'reject',
      summary: 'Second',
      findings_json: '[]',
    });

    const result = await handler({ last_n: 1 }, {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].summary).toBe('Second');
  });

  it('defaults to last 10 reviews when neither session_id nor last_n', async () => {
    for (let i = 0; i < 15; i++) {
      saveReview(db, {
        session_id: `thread_${i}`,
        type: 'plan',
        verdict: 'approve',
        summary: `Review ${i}`,
        findings_json: '[]',
      });
    }

    const result = await handler({}, {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(10);
  });

  it('empty result returns empty array (not error)', async () => {
    const result = await handler({ session_id: 'nonexistent' }, {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([]);
  });

  it('storage error returns MCP error', async () => {
    // Close db to force storage error
    db.close();

    const result = await handler({}, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('STORAGE_ERROR');
  });
});
