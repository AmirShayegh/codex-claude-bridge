import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer, SERVER_INSTRUCTIONS } from './server.js';
import { err } from './utils/errors.js';

let shouldThrow = false;
// Every open fails the way a missing native addon does (ISS-042): persistent
// AND the in-memory fallback, so there is no database at all.
let nativeAddonMissing = false;
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

vi.mock('./backends/index.js', () => ({
  createBackend: vi.fn(() => ({
    provider: 'codex',
    providers: ['codex'],
    allowsModelOverrideOnResume: false,
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

// Capture the preparation deps each tool is registered with: that object is how
// every request learns where to run (ISS-027).
vi.mock('./tools/review-plan.js', () => ({ registerReviewPlanTool: vi.fn() }));
vi.mock('./tools/review-code.js', () => ({ registerReviewCodeTool: vi.fn() }));
vi.mock('./tools/review-precommit.js', () => ({ registerReviewPrecommitTool: vi.fn() }));

vi.mock('better-sqlite3', () => {
  const MockDatabase = vi.fn(function () {
    if (nativeAddonMissing) {
      throw new Error(
        'Could not locate the bindings file. Tried: /x/node_modules/better-sqlite3/build/better_sqlite3.node',
      );
    }
    if (shouldThrow) {
      shouldThrow = false;
      throw new Error('SQLITE_CANTOPEN');
    }
    return {
      exec: vi.fn(),
      prepare: vi.fn(),
      close: vi.fn(),
      pragma: vi.fn((query: string) => {
        if (query === 'table_info(reviews)') return [{ name: 'models_json' }];
        if (query === 'table_info(sessions)') return [{ name: 'model_identity_json' }];
        return [];
      }),
    };
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
import { registerReviewPlanTool } from './tools/review-plan.js';
import { registerReviewCodeTool } from './tools/review-code.js';
import { registerReviewPrecommitTool } from './tools/review-precommit.js';
import { realpathSync } from 'node:fs';
import { initDb } from './storage/reviews.js';
import { initSessionsDb } from './storage/sessions.js';
import Database from 'better-sqlite3';

beforeEach(() => {
  vi.clearAllMocks();
  shouldThrow = false;
  nativeAddonMissing = false;
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
    // The three review tools are registered through their own modules (mocked
    // above to capture the preparation deps); history and status register
    // directly on the server.
    expect(registerReviewPlanTool).toHaveBeenCalledOnce();
    expect(registerReviewCodeTool).toHaveBeenCalledOnce();
    expect(registerReviewPrecommitTool).toHaveBeenCalledOnce();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registerTool = (server as any).registerTool as ReturnType<typeof vi.fn>;
    expect(registerTool).toHaveBeenCalledTimes(2);

    const toolNames = registerTool.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(toolNames).toContain('review_status');
    expect(toolNames).toContain('review_history');
  });

  it('config error aborts startup', () => {
    vi.mocked(loadConfig).mockReturnValue(
      err('CONFIG_ERROR: invalid JSON in /repo/.reviewbridge.json'),
    );

    expect(() => createServer()).toThrow(/CONFIG_ERROR/);
  });

  it('initializes both database tables', () => {
    createServer();
    expect(initDb).toHaveBeenCalledTimes(1);
    expect(initSessionsDb).toHaveBeenCalledTimes(1);
  });

  it('table init failure logs warning but server still starts', () => {
    vi.mocked(initDb).mockImplementationOnce(() => {
      throw new Error('SQLITE_READONLY');
    });
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

  it('starts without storage when the SQLite native addon cannot load (ISS-042)', () => {
    nativeAddonMissing = true;
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const server = createServer();

    // The connection stays up: the client learns about the failure through the
    // tools, not through CONNECTION_CLOSED.
    expect(typeof server.connect).toBe('function');
    expect(registerReviewPlanTool).toHaveBeenCalledOnce();
    expect(registerReviewCodeTool).toHaveBeenCalledOnce();
    expect(registerReviewPrecommitTool).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registerTool = (server as any).registerTool as ReturnType<typeof vi.fn>;
    expect(registerTool.mock.calls.map((call: unknown[]) => call[0])).toEqual(
      expect.arrayContaining(['review_status', 'review_history']),
    );
    // No database handle reaches any tool.
    expect(vi.mocked(registerReviewCodeTool).mock.calls[0][3]).toBeUndefined();
    // Diagnosed once on stderr, with the recovery guidance.
    const diagnoses = consoleSpy.mock.calls.filter((call) =>
      String(call[0]).includes('SQLite native addon could not load'),
    );
    expect(diagnoses).toHaveLength(1);
    expect(String(diagnoses[0][0])).toContain('npm rebuild better-sqlite3');
    consoleSpy.mockRestore();
  });

  it('gives every review tool the same preparation deps, anchored at the launch directory', () => {
    vi.mocked(loadConfig).mockReturnValue({
      ok: true,
      data: { config: DEFAULT_CONFIG, source: { kind: 'default' } },
    });

    createServer();

    const prep = vi.mocked(registerReviewPlanTool).mock.calls[0][2];
    // Canonicalized, so it matches the paths git and the providers report back.
    expect(prep.defaultWorkingDirectory).toBe(realpathSync(process.cwd()));
    expect(prep.loadInstructions).toBe(DEFAULT_CONFIG.copilot_instructions);
    expect(prep.requireCwdForCapture).toBe(true);
    expect(vi.mocked(registerReviewCodeTool).mock.calls[0][2]).toBe(prep);
    expect(vi.mocked(registerReviewPrecommitTool).mock.calls[0][2]).toBe(prep);
  });

  it('relaxes the cwd requirement when the config says so (ISS-047)', () => {
    vi.mocked(loadConfig).mockReturnValue({
      ok: true,
      data: { config: { ...DEFAULT_CONFIG, require_cwd: false }, source: { kind: 'default' } },
    });
    createServer();
    expect(vi.mocked(registerReviewPlanTool).mock.calls[0][2].requireCwdForCapture).toBe(false);
  });

  it('turns instruction loading off when the config disables it', () => {
    vi.mocked(loadConfig).mockReturnValue({
      ok: true,
      data: {
        config: { ...DEFAULT_CONFIG, copilot_instructions: false },
        source: { kind: 'default' },
      },
    });

    createServer();
    expect(vi.mocked(registerReviewPlanTool).mock.calls[0][2].loadInstructions).toBe(false);
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

  it('advertises the package.json version (no hardcoded drift)', async () => {
    const { readFileSync } = await import('node:fs');
    const expectedVersion = (
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
        version: string;
      }
    ).version;

    createServer();
    const [serverInfo] = lastConstructorArgs as [{ name: string; version: string }];
    expect(serverInfo.version).toBe(expectedVersion);
    // Sanity: ensure no future contributor reverts to the historical literal.
    expect(serverInfo.version).not.toBe('0.1.4');
  });
});
