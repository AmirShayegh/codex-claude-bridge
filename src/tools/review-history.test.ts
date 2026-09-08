import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { registerReviewHistoryTool } from './review-history.js';
import { initDb, saveReview } from '../storage/reviews.js';
import { initSessionsDb } from '../storage/sessions.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandlerFn = (args: Record<string, unknown>, extra: unknown) => Promise<any>;

let db: InstanceType<typeof Database>;
let mockServer: { registerTool: ReturnType<typeof vi.fn> };
let handler: HandlerFn;

beforeEach(() => {
  db = new Database(':memory:');
  initDb(db);
  initSessionsDb(db);
  mockServer = { registerTool: vi.fn() };
  registerReviewHistoryTool(mockServer as unknown as McpServer, db);
  handler = mockServer.registerTool.mock.calls[0][2] as HandlerFn;
});

describe('registerReviewHistoryTool', () => {
  it('registers tool with name review_history', () => {
    expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
    expect(mockServer.registerTool.mock.calls[0][0]).toBe('review_history');
  });

  it('bounds last_n to 1..100 and validates decimal cursors', () => {
    const schema = mockServer.registerTool.mock.calls[0][1].inputSchema as Record<
      string,
      { parse(value: unknown): unknown }
    >;
    expect(() => schema.last_n.parse(1)).not.toThrow();
    expect(() => schema.last_n.parse(100)).not.toThrow();
    expect(() => schema.last_n.parse(0)).toThrow();
    expect(() => schema.last_n.parse(101)).toThrow();
    expect(() => schema.cursor.parse('42')).not.toThrow();
    expect(() => schema.cursor.parse('01')).toThrow();
    expect(() => schema.cursor.parse('not-an-id')).toThrow();
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
    expect(parsed.reviews).toHaveLength(1);
    expect(parsed.reviews[0].summary).toBe('Good plan');
    expect(parsed.next_cursor).toBeNull();
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
    expect(parsed.reviews).toHaveLength(1);
    expect(parsed.reviews[0].summary).toBe('Second');
    expect(parsed.next_cursor).toBe('2');
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
    expect(parsed.reviews).toHaveLength(10);
  });

  it('empty result returns empty array (not error)', async () => {
    const result = await handler({ session_id: 'nonexistent' }, {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.reviews).toEqual([]);
    expect(parsed.next_cursor).toBeNull();
  });

  it('paginates recent reviews newest-first without overlap', async () => {
    for (let i = 1; i <= 3; i++) {
      saveReview(db, {
        session_id: `recent_${i}`,
        type: 'code',
        verdict: 'approve',
        summary: `Review ${i}`,
        findings_json: '[]',
      });
    }

    const first = JSON.parse((await handler({ last_n: 2 }, {})).content[0].text);
    const second = JSON.parse(
      (await handler({ last_n: 2, cursor: first.next_cursor }, {})).content[0].text,
    );

    expect(first.reviews.map((review: { summary: string }) => review.summary)).toEqual([
      'Review 3',
      'Review 2',
    ]);
    expect(second.reviews.map((review: { summary: string }) => review.summary)).toEqual([
      'Review 1',
    ]);
    expect(second.next_cursor).toBeNull();
  });

  it('paginates one session oldest-first and defaults its page size to 100', async () => {
    for (let i = 1; i <= 102; i++) {
      saveReview(db, {
        session_id: 'one-session',
        type: 'plan',
        verdict: 'approve',
        summary: `Review ${i}`,
        findings_json: '[]',
      });
    }

    const first = JSON.parse((await handler({ session_id: 'one-session' }, {})).content[0].text);
    const second = JSON.parse(
      (await handler({ session_id: 'one-session', cursor: first.next_cursor }, {})).content[0].text,
    );

    expect(first.reviews).toHaveLength(100);
    expect(first.reviews[0].summary).toBe('Review 1');
    expect(second.reviews.map((review: { summary: string }) => review.summary)).toEqual([
      'Review 101',
      'Review 102',
    ]);
  });

  it('storage error returns MCP error', async () => {
    // Close db to force storage error
    db.close();

    const result = await handler({}, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('STORAGE_ERROR');
  });
});
