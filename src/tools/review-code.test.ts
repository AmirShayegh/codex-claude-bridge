import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerReviewCodeTool } from './review-code.js';
import type { CodexClient } from '../codex/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CodeReviewResult } from '../codex/types.js';
import { ok, err } from '../utils/errors.js';

vi.mock('../storage/reviews.js', () => ({
  saveReview: vi.fn(),
}));

vi.mock('../storage/sessions.js', () => ({
  getOrCreateSession: vi.fn(),
  markSessionCompleted: vi.fn(),
  markSessionFailed: vi.fn(),
  activateSession: vi.fn(),
}));

vi.mock('../utils/resolve-diff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/resolve-diff.js')>();
  return {
    ...actual,
    resolveCodeDiff: vi.fn(),
  };
});

import { saveReview } from '../storage/reviews.js';
import { getOrCreateSession, markSessionCompleted, markSessionFailed, activateSession } from '../storage/sessions.js';
import { resolveCodeDiff } from '../utils/resolve-diff.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandlerFn = (args: Record<string, unknown>, extra: unknown) => Promise<any>;

let mockClient: CodexClient;
let mockServer: { registerTool: ReturnType<typeof vi.fn> };
let handler: HandlerFn;

const validResult: CodeReviewResult = {
  verdict: 'request_changes',
  summary: 'Issues found',
  findings: [
    {
      severity: 'critical',
      category: 'bug',
      description: 'Null pointer dereference',
      file: 'src/index.ts',
      line: 42,
      suggestion: 'Add null check',
    },
  ],
  session_id: 'thread_xyz',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockClient = {
    reviewPlan: vi.fn(),
    reviewCode: vi.fn(),
    reviewPrecommit: vi.fn(),
  };
  mockServer = { registerTool: vi.fn() };
  // Default: resolveCodeDiff passes through whatever diff is provided
  vi.mocked(resolveCodeDiff).mockImplementation(async (args) => {
    return ok(args.diff ?? 'auto-captured diff');
  });
});

function setupHandler(db?: unknown) {
  registerReviewCodeTool(mockServer as unknown as McpServer, mockClient, db as never);
  handler = mockServer.registerTool.mock.calls[0][2] as HandlerFn;
}

describe('registerReviewCodeTool', () => {
  beforeEach(() => setupHandler());

  it('registers tool with name review_code', () => {
    expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
    expect(mockServer.registerTool.mock.calls[0][0]).toBe('review_code');
  });

  it('diff input returns structured review', async () => {
    vi.mocked(mockClient.reviewCode).mockResolvedValue(ok(validResult));

    const result = await handler({ diff: 'some diff content' }, {});

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verdict).toBe('request_changes');
    expect(parsed.session_id).toBe('thread_xyz');
    expect(result.isError).toBeUndefined();
  });

  it('findings include file/line references', async () => {
    vi.mocked(mockClient.reviewCode).mockResolvedValue(ok(validResult));

    const result = await handler({ diff: 'some diff' }, {});

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings[0].file).toBe('src/index.ts');
    expect(parsed.findings[0].line).toBe(42);
    expect(parsed.findings[0].suggestion).toBe('Add null check');
  });

  it('Codex client error propagates as MCP error', async () => {
    vi.mocked(mockClient.reviewCode).mockResolvedValue(
      err('CODEX_PARSE_ERROR: malformed JSON in response'),
    );

    const result = await handler({ diff: 'some diff' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CODEX_PARSE_ERROR');
  });

  it('unexpected thrown error returns MCP error', async () => {
    vi.mocked(mockClient.reviewCode).mockRejectedValue(new Error('connection reset'));

    const result = await handler({ diff: 'some diff' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('connection reset');
  });

  it('session_id forwarded to client', async () => {
    vi.mocked(mockClient.reviewCode).mockResolvedValue(ok(validResult));

    await handler({ diff: 'some diff', session_id: 'existing_session' }, {});

    expect(mockClient.reviewCode).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'existing_session' }),
    );
  });

  it('does not save to storage when no db provided', async () => {
    vi.mocked(mockClient.reviewCode).mockResolvedValue(ok(validResult));

    await handler({ diff: 'some diff' }, {});

    expect(saveReview).not.toHaveBeenCalled();
  });
});

describe('registerReviewCodeTool with db', () => {
  // transaction(fn)() invokes fn synchronously — matches better-sqlite3's
  // shape that recordSuccess uses for atomicity (T-002).
  const mockDb = { transaction: <T>(fn: () => T) => () => fn() };

  beforeEach(() => {
    vi.mocked(getOrCreateSession).mockReturnValue(ok({ session_id: 'thread_xyz', status: 'in_progress' as const, created_at: '2026-01-01', completed_at: null }));
    vi.mocked(activateSession).mockReturnValue(ok({ session_id: 'thread_xyz', status: 'in_progress' as const, created_at: '2026-01-01', completed_at: null }));
    vi.mocked(markSessionCompleted).mockReturnValue(ok(undefined));
    vi.mocked(markSessionFailed).mockReturnValue(ok(undefined));
    vi.mocked(saveReview).mockReturnValue(ok(undefined));
    setupHandler(mockDb);
  });

  it('saves review to storage on success', async () => {
    vi.mocked(mockClient.reviewCode).mockResolvedValue(ok(validResult));

    await handler({ diff: 'some diff' }, {});

    expect(saveReview).toHaveBeenCalledWith(mockDb, {
      session_id: 'thread_xyz',
      type: 'code',
      verdict: 'request_changes',
      summary: 'Issues found',
      findings_json: JSON.stringify(validResult.findings),
    });
  });

  it('creates session entry on success', async () => {
    vi.mocked(mockClient.reviewCode).mockResolvedValue(ok(validResult));

    await handler({ diff: 'some diff' }, {});

    expect(getOrCreateSession).toHaveBeenCalledWith(mockDb, 'thread_xyz');
  });

  it('does not save on client error', async () => {
    vi.mocked(mockClient.reviewCode).mockResolvedValue(
      err('CODEX_TIMEOUT: timed out'),
    );

    await handler({ diff: 'some diff' }, {});

    expect(saveReview).not.toHaveBeenCalled();
  });

  it('marks session completed after save', async () => {
    vi.mocked(mockClient.reviewCode).mockResolvedValue(ok(validResult));

    await handler({ diff: 'some diff' }, {});

    expect(markSessionCompleted).toHaveBeenCalledWith(mockDb, 'thread_xyz');
  });

  it('logs warning when getOrCreateSession fails', async () => {
    vi.mocked(mockClient.reviewCode).mockResolvedValue(ok(validResult));
    vi.mocked(getOrCreateSession).mockReturnValue(err('STORAGE_ERROR: table missing'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler({ diff: 'some diff' }, {});

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to track session'));
    expect(result.isError).toBeUndefined();
    consoleSpy.mockRestore();
  });

  it('logs warning when markSessionCompleted fails', async () => {
    vi.mocked(mockClient.reviewCode).mockResolvedValue(ok(validResult));
    vi.mocked(markSessionCompleted).mockReturnValue(err('STORAGE_ERROR: readonly'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler({ diff: 'some diff' }, {});

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('readonly'));
    expect(result.isError).toBeUndefined();
    consoleSpy.mockRestore();
  });

  it('logs warning when saveReview fails but still returns success', async () => {
    vi.mocked(mockClient.reviewCode).mockResolvedValue(ok(validResult));
    vi.mocked(saveReview).mockReturnValue(err('STORAGE_ERROR: disk full'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler({ diff: 'some diff' }, {});

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('STORAGE_ERROR'));
    expect(result.isError).toBeUndefined();
    consoleSpy.mockRestore();
  });

  it('activates session before client call when session_id provided', async () => {
    vi.mocked(mockClient.reviewCode).mockResolvedValue(ok(validResult));

    await handler({ diff: 'some diff', session_id: 'thread_xyz' }, {});

    expect(activateSession).toHaveBeenCalledWith(mockDb, 'thread_xyz');
    const activateOrder = vi.mocked(activateSession).mock.invocationCallOrder[0];
    const reviewOrder = vi.mocked(mockClient.reviewCode).mock.invocationCallOrder[0];
    expect(activateOrder).toBeLessThan(reviewOrder);
  });

  it('does not activate session when no session_id provided', async () => {
    vi.mocked(mockClient.reviewCode).mockResolvedValue(ok(validResult));

    await handler({ diff: 'some diff' }, {});

    expect(activateSession).not.toHaveBeenCalled();
    expect(getOrCreateSession).toHaveBeenCalledWith(mockDb, 'thread_xyz');
  });

  it('marks session failed when client returns error and session_id provided', async () => {
    vi.mocked(mockClient.reviewCode).mockResolvedValue(err('CODEX_TIMEOUT: timed out'));

    const result = await handler({ diff: 'some diff', session_id: 'thread_xyz' }, {});

    expect(result.isError).toBe(true);
    expect(markSessionFailed).toHaveBeenCalledWith(mockDb, 'thread_xyz');
  });

  it('marks session failed when handler throws and session_id provided', async () => {
    vi.mocked(mockClient.reviewCode).mockRejectedValue(new Error('network error'));

    const result = await handler({ diff: 'some diff', session_id: 'thread_xyz' }, {});

    expect(result.isError).toBe(true);
    expect(markSessionFailed).toHaveBeenCalledWith(mockDb, 'thread_xyz');
  });

  it('does not mark session failed when activateSession fails', async () => {
    vi.mocked(activateSession).mockReturnValue(err('STORAGE_ERROR: readonly'));
    vi.mocked(mockClient.reviewCode).mockResolvedValue(err('CODEX_TIMEOUT: timed out'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler({ diff: 'some diff', session_id: 'thread_xyz' }, {});

    expect(result.isError).toBe(true);
    expect(markSessionFailed).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('uses preflightId for markSessionCompleted when session_id provided', async () => {
    vi.mocked(activateSession).mockReturnValue(ok({ session_id: 'thread_xyz', status: 'in_progress' as const, created_at: '2026-01-01', completed_at: null }));
    const codexResult = { ...validResult, session_id: 'thread_different' };
    vi.mocked(mockClient.reviewCode).mockResolvedValue(ok(codexResult));

    await handler({ diff: 'some diff', session_id: 'thread_xyz' }, {});

    expect(markSessionCompleted).toHaveBeenCalledWith(mockDb, 'thread_xyz');
  });
});

describe('review_code auto_diff', () => {
  beforeEach(() => setupHandler());

  it('auto-captures changes when diff is omitted', async () => {
    vi.mocked(resolveCodeDiff).mockResolvedValue(ok('auto-captured diff'));
    vi.mocked(mockClient.reviewCode).mockResolvedValue(ok(validResult));

    await handler({}, {});

    expect(resolveCodeDiff).toHaveBeenCalledWith({ diff: undefined, auto_diff: undefined });
    expect(mockClient.reviewCode).toHaveBeenCalledWith(
      expect.objectContaining({ diff: 'auto-captured diff' }),
    );
  });

  it('passes explicit diff through resolveCodeDiff', async () => {
    vi.mocked(resolveCodeDiff).mockResolvedValue(ok('explicit diff'));
    vi.mocked(mockClient.reviewCode).mockResolvedValue(ok(validResult));

    await handler({ diff: 'explicit diff' }, {});

    expect(resolveCodeDiff).toHaveBeenCalledWith(
      expect.objectContaining({ diff: 'explicit diff' }),
    );
  });

  it('returns approve-shaped response when no working changes', async () => {
    vi.mocked(resolveCodeDiff).mockResolvedValue(
      err('NO_WORKING_CHANGES: No changes found vs HEAD.'),
    );

    const result = await handler({}, {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verdict).toBe('approve');
    expect(parsed.summary).toBe('No changes found to review.');
    expect(parsed.findings).toEqual([]);
    expect(parsed.session_id).toBe('');
  });

  it('returns MCP error when git fails', async () => {
    vi.mocked(resolveCodeDiff).mockResolvedValue(
      err('GIT_ERROR: fatal: not a git repository'),
    );

    const result = await handler({}, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('GIT_ERROR');
  });

  it('does not call client.reviewCode when no working changes', async () => {
    vi.mocked(resolveCodeDiff).mockResolvedValue(
      err('NO_WORKING_CHANGES: No changes found vs HEAD.'),
    );

    await handler({}, {});

    expect(mockClient.reviewCode).not.toHaveBeenCalled();
  });
});
