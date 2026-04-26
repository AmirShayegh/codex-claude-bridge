import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer, SERVER_INSTRUCTIONS } from './server.js';
import { err } from './utils/errors.js';

let shouldThrow = false;
let lastConstructorArgs: unknown[] = [];

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  function MockMcpServer(...args: unknown[]) {
    lastConstructorArgs = args;
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
  formatConfigSource: vi.fn((s: { kind: string; path?: string }) =>
    s.kind === 'default' ? 'default' : `${s.kind} (${s.path ?? ''})`,
  ),
}));

vi.mock('./config/copilot-instructions.js', () => ({
  loadCopilotInstructions: vi.fn(() => ({
    ok: true,
    data: { repoWide: null, scoped: [] },
  })),
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
  markSessionCompleted: vi.fn(),
  markSessionFailed: vi.fn(),
  activateSession: vi.fn(),
}));

import { loadConfig } from './config/loader.js';
import { DEFAULT_CONFIG } from './config/types.js';
import { loadCopilotInstructions } from './config/copilot-instructions.js';
import { initDb } from './storage/reviews.js';
import { initSessionsDb } from './storage/sessions.js';
import Database from 'better-sqlite3';

beforeEach(() => {
  vi.clearAllMocks();
  shouldThrow = false;
  lastConstructorArgs = [];
  vi.mocked(loadConfig).mockReturnValue({
    ok: true,
    data: { config: DEFAULT_CONFIG, source: { kind: 'default' } },
  });
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

  it('config error aborts startup', () => {
    vi.mocked(loadConfig).mockReturnValue(err('CONFIG_ERROR: invalid JSON in /repo/.reviewbridge.json'));

    expect(() => createServer()).toThrow(/CONFIG_ERROR/);
  });

  it('initializes both database tables', () => {
    createServer();
    expect(initDb).toHaveBeenCalledTimes(1);
    expect(initSessionsDb).toHaveBeenCalledTimes(1);
  });

  it('table init failure logs warning but server still starts', () => {
    vi.mocked(initDb).mockImplementationOnce(() => { throw new Error('SQLITE_READONLY'); });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const server = createServer();

    expect(typeof server.connect).toBe('function');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('SQLITE_READONLY'));
    consoleSpy.mockRestore();
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

  it('derives copilot instructions root from project source path', () => {
    vi.mocked(loadConfig).mockReturnValue({
      ok: true,
      data: {
        config: DEFAULT_CONFIG,
        source: { kind: 'project', path: '/some/repo/.reviewbridge.json' },
      },
    });

    createServer();
    expect(loadCopilotInstructions).toHaveBeenCalledWith('/some/repo');
  });

  it('uses process.cwd() for copilot instructions when source is default/env/user', () => {
    vi.mocked(loadConfig).mockReturnValue({
      ok: true,
      data: { config: DEFAULT_CONFIG, source: { kind: 'default' } },
    });

    createServer();
    expect(loadCopilotInstructions).toHaveBeenCalledWith(undefined);
  });

  it('passes server instructions to McpServer', () => {
    createServer();
    const [serverInfo, options] = lastConstructorArgs as [
      { name: string; version: string },
      { instructions?: string },
    ];
    expect(serverInfo.name).toBe('codex-claude-bridge');
    expect(options.instructions).toBe(SERVER_INSTRUCTIONS);
    expect(options.instructions).toContain('review_plan');
    expect(options.instructions).toContain('review_code');
    expect(options.instructions).toContain('review_precommit');
    expect(options.instructions).toContain('session_id');
  });
});
