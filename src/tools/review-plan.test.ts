import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerReviewPlanTool } from './review-plan.js';
import type { CodexClient } from '../codex/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlanReviewResult } from '../codex/types.js';
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

const validResult: PlanReviewResult = {
  verdict: 'approve',
  summary: 'Plan looks solid',
  findings: [{ severity: 'minor', category: 'style', description: 'Consider renaming' }],
  session_id: 'thread_abc',
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
  registerReviewPlanTool(mockServer as unknown as McpServer, mockClient, db as never);
  handler = mockServer.registerTool.mock.calls[0][2] as HandlerFn;
}

describe('registerReviewPlanTool', () => {
  beforeEach(() => setupHandler());

  it('registers tool with name review_plan', () => {
    expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
    expect(mockServer.registerTool.mock.calls[0][0]).toBe('review_plan');
  });

  it('inputSchema marks plan as required (z.string, not optional)', () => {
    const config = mockServer.registerTool.mock.calls[0][1] as { inputSchema: Record<string, unknown> };
    const planField = config.inputSchema.plan;
    expect(planField).toBeDefined();
    expect(() => (planField as { parse: (v: unknown) => unknown }).parse('hello')).not.toThrow();
    expect(() => (planField as { parse: (v: unknown) => unknown }).parse(undefined)).toThrow();
  });

  it('valid plan input returns structured review', async () => {
    vi.mocked(mockClient.reviewPlan).mockResolvedValue(ok(validResult));

    const result = await handler({ plan: 'My plan' }, {});

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.verdict).toBe('approve');
    expect(parsed.summary).toBe('Plan looks solid');
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.session_id).toBe('thread_abc');
    expect(result.isError).toBeUndefined();
  });

  it('Codex client error propagates as MCP error', async () => {
    vi.mocked(mockClient.reviewPlan).mockResolvedValue(
      err('CODEX_TIMEOUT: review timed out after 300s'),
    );

    const result = await handler({ plan: 'My plan' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CODEX_TIMEOUT');
  });

  it('unexpected thrown error returns MCP error', async () => {
    vi.mocked(mockClient.reviewPlan).mockRejectedValue(new Error('network failure'));

    const result = await handler({ plan: 'My plan' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('network failure');
  });

  it('session_id passed through to client', async () => {
    vi.mocked(mockClient.reviewPlan).mockResolvedValue(ok(validResult));

    await handler({ plan: 'My plan', session_id: 'existing_session' }, {});

    expect(mockClient.reviewPlan).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'existing_session' }),
    );
  });

  it('does not save to storage when no db provided', async () => {
    vi.mocked(mockClient.reviewPlan).mockResolvedValue(ok(validResult));

    await handler({ plan: 'My plan' }, {});

    expect(saveReview).not.toHaveBeenCalled();
  });
});

describe('registerReviewPlanTool with db', () => {
  const mockDb = {};

  beforeEach(() => setupHandler(mockDb));

  it('saves review to storage on success', async () => {
    vi.mocked(mockClient.reviewPlan).mockResolvedValue(ok(validResult));

    await handler({ plan: 'My plan' }, {});

    expect(saveReview).toHaveBeenCalledWith(mockDb, {
      session_id: 'thread_abc',
      type: 'plan',
      verdict: 'approve',
      summary: 'Plan looks solid',
      findings_json: JSON.stringify(validResult.findings),
    });
  });

  it('does not save on client error', async () => {
    vi.mocked(mockClient.reviewPlan).mockResolvedValue(
      err('CODEX_TIMEOUT: timed out'),
    );

    await handler({ plan: 'My plan' }, {});

    expect(saveReview).not.toHaveBeenCalled();
  });
});
