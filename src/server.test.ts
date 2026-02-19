import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from './server.js';
import { err } from './utils/errors.js';

let shouldThrow = false;

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  function MockMcpServer() {
    return {
      registerTool: vi.fn(),
      connect: vi.fn(),
      server: {},
    };
  }
  return { McpServer: MockMcpServer };
});

vi.mock('./codex/client.js', () => ({
  createCodexClient: vi.fn(() => ({
    reviewPlan: vi.fn(),
    reviewCode: vi.fn(),
    reviewPrecommit: vi.fn(),
  })),
}));

vi.mock('./config/loader.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('better-sqlite3', () => {
  const MockDatabase = vi.fn(function () {
    if (shouldThrow) {
      shouldThrow = false;
      throw new Error('SQLITE_CANTOPEN');
    }
    return { exec: vi.fn(), prepare: vi.fn(), close: vi.fn() };
  });
  return { default: MockDatabase };
});

vi.mock('./storage/reviews.js', () => ({
  initDb: vi.fn(),
  saveReview: vi.fn(),
  getReviewsBySession: vi.fn(),
  getRecentReviews: vi.fn(),
}));

vi.mock('./storage/sessions.js', () => ({
  initSessionsDb: vi.fn(),
  getOrCreateSession: vi.fn(),
}));

import { loadConfig } from './config/loader.js';
import { DEFAULT_CONFIG } from './config/types.js';
import { initDb } from './storage/reviews.js';
import { initSessionsDb } from './storage/sessions.js';
import Database from 'better-sqlite3';

beforeEach(() => {
  vi.clearAllMocks();
  shouldThrow = false;
  vi.mocked(loadConfig).mockReturnValue({ ok: true, data: DEFAULT_CONFIG });
});

describe('createServer', () => {
  it('returns object with connect method (McpServer-like)', () => {
    const server = createServer();
    expect(typeof server.connect).toBe('function');
  });

  it('registers all 5 tools', () => {
    const server = createServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registerTool = (server as any).registerTool as ReturnType<typeof vi.fn>;
    expect(registerTool).toHaveBeenCalledTimes(5);

    const toolNames = registerTool.mock.calls.map(
      (call: unknown[]) => call[0] as string,
    );
    expect(toolNames).toContain('review_plan');
    expect(toolNames).toContain('review_code');
    expect(toolNames).toContain('review_precommit');
    expect(toolNames).toContain('review_status');
    expect(toolNames).toContain('review_history');
  });

  it('config error falls back to defaults', () => {
    vi.mocked(loadConfig).mockReturnValue(err('CONFIG_ERROR: file not found'));

    const server = createServer();
    expect(typeof server.connect).toBe('function');
  });

  it('initializes both database tables', () => {
    createServer();
    expect(initDb).toHaveBeenCalledTimes(1);
    expect(initSessionsDb).toHaveBeenCalledTimes(1);
  });

  it('database open failure falls back to in-memory', () => {
    shouldThrow = true;
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const server = createServer();

    expect(typeof server.connect).toBe('function');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('SQLITE_CANTOPEN'));
    expect(Database).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });
});
