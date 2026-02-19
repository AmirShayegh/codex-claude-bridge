import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from './server.js';
import { err } from './utils/errors.js';

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  // Must use function (not arrow) so it's valid as a constructor with `new`
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

import { loadConfig } from './config/loader.js';
import { DEFAULT_CONFIG } from './config/types.js';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: loadConfig succeeds
  vi.mocked(loadConfig).mockReturnValue({ ok: true, data: DEFAULT_CONFIG });
});

describe('createServer', () => {
  it('returns object with connect method (McpServer-like)', () => {
    const server = createServer();
    expect(typeof server.connect).toBe('function');
  });

  it('registers all 5 tools', () => {
    const server = createServer();
    // registerTool is on the mock McpServer instance
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

    // Should not throw
    const server = createServer();
    expect(typeof server.connect).toBe('function');
  });
});
