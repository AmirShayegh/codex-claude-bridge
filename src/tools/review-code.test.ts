import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerReviewCodeTool } from './review-code.js';
import type { CodexClient } from '../codex/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CodeReviewResult } from '../codex/types.js';
import { ok, err } from '../utils/errors.js';

vi.mock('../storage/reviews.js', () => ({
  saveReview: vi.fn(),
}));

import { saveReview } from '../storage/reviews.js';

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
  const mockDb = {};

  beforeEach(() => setupHandler(mockDb));

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

  it('does not save on client error', async () => {
    vi.mocked(mockClient.reviewCode).mockResolvedValue(
      err('CODEX_TIMEOUT: timed out'),
    );

    await handler({ diff: 'some diff' }, {});

    expect(saveReview).not.toHaveBeenCalled();
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
});
