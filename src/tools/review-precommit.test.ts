import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerReviewPrecommitTool } from './review-precommit.js';
import type { CodexClient } from '../codex/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PrecommitResult } from '../codex/types.js';
import { ok, err } from '../utils/errors.js';

vi.mock('../utils/git.js', () => ({
  getStagedDiff: vi.fn(),
}));

vi.mock('../storage/reviews.js', () => ({
  saveReview: vi.fn(),
}));

import { getStagedDiff } from '../utils/git.js';
import { saveReview } from '../storage/reviews.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandlerFn = (args: Record<string, unknown>, extra: unknown) => Promise<any>;

let mockClient: CodexClient;
let mockServer: { registerTool: ReturnType<typeof vi.fn> };
let handler: HandlerFn;

const validResult: PrecommitResult = {
  ready_to_commit: true,
  blockers: [],
  warnings: ['Large diff'],
  session_id: 'thread_pre',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockClient = {
    reviewPlan: vi.fn(),
    reviewCode: vi.fn(),
    reviewPrecommit: vi.fn(),
  };
  mockServer = { registerTool: vi.fn() };
});

function setupHandler(db?: unknown) {
  registerReviewPrecommitTool(mockServer as unknown as McpServer, mockClient, db as never);
  handler = mockServer.registerTool.mock.calls[0][2] as HandlerFn;
}

describe('registerReviewPrecommitTool', () => {
  beforeEach(() => setupHandler());

  it('registers tool with name review_precommit', () => {
    expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
    expect(mockServer.registerTool.mock.calls[0][0]).toBe('review_precommit');
  });

  it('auto_diff captures staged changes', async () => {
    vi.mocked(getStagedDiff).mockResolvedValue(ok('staged diff content'));
    vi.mocked(mockClient.reviewPrecommit).mockResolvedValue(ok(validResult));

    const result = await handler({}, {});

    expect(getStagedDiff).toHaveBeenCalledTimes(1);
    expect(mockClient.reviewPrecommit).toHaveBeenCalledWith(
      expect.objectContaining({ diff: 'staged diff content' }),
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ready_to_commit).toBe(true);
    expect(result.isError).toBeUndefined();
  });

  it('no staged changes returns warning', async () => {
    vi.mocked(getStagedDiff).mockResolvedValue(ok(''));

    const result = await handler({}, {});

    expect(mockClient.reviewPrecommit).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ready_to_commit).toBe(false);
    expect(parsed.warnings).toContain('No staged changes found');
  });

  it('ready_to_commit is false when blockers exist', async () => {
    vi.mocked(getStagedDiff).mockResolvedValue(ok('some diff'));
    const blockedResult: PrecommitResult = {
      ready_to_commit: false,
      blockers: ['Missing error handling in auth module'],
      warnings: [],
      session_id: 'thread_blocked',
    };
    vi.mocked(mockClient.reviewPrecommit).mockResolvedValue(ok(blockedResult));

    const result = await handler({}, {});

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ready_to_commit).toBe(false);
    expect(parsed.blockers).toContain('Missing error handling in auth module');
  });

  it('explicit diff skips getStagedDiff when auto_diff is false', async () => {
    vi.mocked(mockClient.reviewPrecommit).mockResolvedValue(ok(validResult));

    await handler({ diff: 'explicit diff', auto_diff: false }, {});

    expect(getStagedDiff).not.toHaveBeenCalled();
    expect(mockClient.reviewPrecommit).toHaveBeenCalledWith(
      expect.objectContaining({ diff: 'explicit diff' }),
    );
  });

  it('explicit diff takes precedence over auto_diff', async () => {
    vi.mocked(mockClient.reviewPrecommit).mockResolvedValue(ok(validResult));

    await handler({ diff: 'explicit diff', auto_diff: true }, {});

    expect(getStagedDiff).not.toHaveBeenCalled();
    expect(mockClient.reviewPrecommit).toHaveBeenCalledWith(
      expect.objectContaining({ diff: 'explicit diff' }),
    );
  });

  it('auto_diff false + no diff returns error', async () => {
    const result = await handler({ auto_diff: false }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('auto_diff disabled and no diff provided');
    expect(getStagedDiff).not.toHaveBeenCalled();
    expect(mockClient.reviewPrecommit).not.toHaveBeenCalled();
  });

  it('getStagedDiff failure returns MCP error', async () => {
    vi.mocked(getStagedDiff).mockResolvedValue(err('GIT_ERROR: not a git repository'));

    const result = await handler({}, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('GIT_ERROR');
    expect(mockClient.reviewPrecommit).not.toHaveBeenCalled();
  });

  it('no staged changes preserves caller session_id', async () => {
    vi.mocked(getStagedDiff).mockResolvedValue(ok(''));

    const result = await handler({ session_id: 'thread_existing' }, {});

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.session_id).toBe('thread_existing');
    expect(parsed.ready_to_commit).toBe(false);
  });

  it('unexpected thrown error returns MCP error', async () => {
    vi.mocked(getStagedDiff).mockResolvedValue(ok('some diff'));
    vi.mocked(mockClient.reviewPrecommit).mockRejectedValue(new Error('timeout'));

    const result = await handler({}, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('timeout');
  });

  it('does not save to storage when no db provided', async () => {
    vi.mocked(getStagedDiff).mockResolvedValue(ok('some diff'));
    vi.mocked(mockClient.reviewPrecommit).mockResolvedValue(ok(validResult));

    await handler({}, {});

    expect(saveReview).not.toHaveBeenCalled();
  });
});

describe('registerReviewPrecommitTool with db', () => {
  const mockDb = {};

  beforeEach(() => setupHandler(mockDb));

  it('saves review to storage on success', async () => {
    vi.mocked(getStagedDiff).mockResolvedValue(ok('some diff'));
    vi.mocked(mockClient.reviewPrecommit).mockResolvedValue(ok(validResult));

    await handler({}, {});

    expect(saveReview).toHaveBeenCalledWith(mockDb, {
      session_id: 'thread_pre',
      type: 'precommit',
      verdict: 'approve',
      summary: 'Large diff',
      findings_json: '[]',
    });
  });

  it('rejected review with blockers uses blockers for summary', async () => {
    vi.mocked(getStagedDiff).mockResolvedValue(ok('some diff'));
    const blockedResult: PrecommitResult = {
      ready_to_commit: false,
      blockers: ['Missing error handling', 'SQL injection risk'],
      warnings: [],
      session_id: 'thread_blocked',
    };
    vi.mocked(mockClient.reviewPrecommit).mockResolvedValue(ok(blockedResult));

    await handler({}, {});

    expect(saveReview).toHaveBeenCalledWith(mockDb, expect.objectContaining({
      verdict: 'reject',
      summary: 'Missing error handling; SQL injection risk',
    }));
  });

  it('does not save on client error', async () => {
    vi.mocked(getStagedDiff).mockResolvedValue(ok('some diff'));
    vi.mocked(mockClient.reviewPrecommit).mockResolvedValue(
      err('CODEX_TIMEOUT: timed out'),
    );

    await handler({}, {});

    expect(saveReview).not.toHaveBeenCalled();
  });
});
