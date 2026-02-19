import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerReviewPlanTool } from './review-plan.js';
import type { CodexClient } from '../codex/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlanReviewResult } from '../codex/types.js';
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

import { saveReview } from '../storage/reviews.js';
import { getOrCreateSession, markSessionCompleted, markSessionFailed, activateSession } from '../storage/sessions.js';

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

  beforeEach(() => {
    vi.mocked(getOrCreateSession).mockReturnValue(ok({ session_id: 'thread_abc', status: 'in_progress' as const, created_at: '2026-01-01', completed_at: null }));
    vi.mocked(activateSession).mockReturnValue(ok({ session_id: 'thread_abc', status: 'in_progress' as const, created_at: '2026-01-01', completed_at: null }));
    vi.mocked(markSessionCompleted).mockReturnValue(ok(undefined));
    vi.mocked(markSessionFailed).mockReturnValue(ok(undefined));
    vi.mocked(saveReview).mockReturnValue(ok(undefined));
    setupHandler(mockDb);
  });

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

  it('creates session entry on success', async () => {
    vi.mocked(mockClient.reviewPlan).mockResolvedValue(ok(validResult));

    await handler({ plan: 'My plan' }, {});

    expect(getOrCreateSession).toHaveBeenCalledWith(mockDb, 'thread_abc');
  });

  it('does not save on client error', async () => {
    vi.mocked(mockClient.reviewPlan).mockResolvedValue(
      err('CODEX_TIMEOUT: timed out'),
    );

    await handler({ plan: 'My plan' }, {});

    expect(saveReview).not.toHaveBeenCalled();
  });

  it('marks session completed after save', async () => {
    vi.mocked(mockClient.reviewPlan).mockResolvedValue(ok(validResult));

    await handler({ plan: 'My plan' }, {});

    expect(markSessionCompleted).toHaveBeenCalledWith(mockDb, 'thread_abc');
  });

  it('logs warning when getOrCreateSession fails', async () => {
    vi.mocked(mockClient.reviewPlan).mockResolvedValue(ok(validResult));
    vi.mocked(getOrCreateSession).mockReturnValue(err('STORAGE_ERROR: table missing'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler({ plan: 'My plan' }, {});

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to track session'));
    expect(result.isError).toBeUndefined();
    consoleSpy.mockRestore();
  });

  it('logs warning when markSessionCompleted fails', async () => {
    vi.mocked(mockClient.reviewPlan).mockResolvedValue(ok(validResult));
    vi.mocked(markSessionCompleted).mockReturnValue(err('STORAGE_ERROR: readonly'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler({ plan: 'My plan' }, {});

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to complete session'));
    expect(result.isError).toBeUndefined();
    consoleSpy.mockRestore();
  });

  it('logs warning when saveReview fails but still returns success', async () => {
    vi.mocked(mockClient.reviewPlan).mockResolvedValue(ok(validResult));
    vi.mocked(saveReview).mockReturnValue(err('STORAGE_ERROR: disk full'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler({ plan: 'My plan' }, {});

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('STORAGE_ERROR'));
    expect(result.isError).toBeUndefined();
    consoleSpy.mockRestore();
  });

  it('activates session before client call when session_id provided', async () => {
    vi.mocked(mockClient.reviewPlan).mockResolvedValue(ok(validResult));

    await handler({ plan: 'My plan', session_id: 'thread_abc' }, {});

    expect(activateSession).toHaveBeenCalledWith(mockDb, 'thread_abc');
    // activateSession should be called before reviewPlan
    const activateOrder = vi.mocked(activateSession).mock.invocationCallOrder[0];
    const reviewOrder = vi.mocked(mockClient.reviewPlan).mock.invocationCallOrder[0];
    expect(activateOrder).toBeLessThan(reviewOrder);
  });

  it('does not activate session when no session_id provided', async () => {
    vi.mocked(mockClient.reviewPlan).mockResolvedValue(ok(validResult));

    await handler({ plan: 'My plan' }, {});

    expect(activateSession).not.toHaveBeenCalled();
    expect(getOrCreateSession).toHaveBeenCalledWith(mockDb, 'thread_abc');
  });

  it('marks session failed when client returns error and session_id provided', async () => {
    vi.mocked(mockClient.reviewPlan).mockResolvedValue(err('CODEX_TIMEOUT: timed out'));

    const result = await handler({ plan: 'My plan', session_id: 'thread_abc' }, {});

    expect(result.isError).toBe(true);
    expect(markSessionFailed).toHaveBeenCalledWith(mockDb, 'thread_abc');
  });

  it('marks session failed when handler throws and session_id provided', async () => {
    vi.mocked(mockClient.reviewPlan).mockRejectedValue(new Error('network error'));

    const result = await handler({ plan: 'My plan', session_id: 'thread_abc' }, {});

    expect(result.isError).toBe(true);
    expect(markSessionFailed).toHaveBeenCalledWith(mockDb, 'thread_abc');
  });

  it('does not mark session failed when activateSession fails', async () => {
    vi.mocked(activateSession).mockReturnValue(err('STORAGE_ERROR: readonly'));
    vi.mocked(mockClient.reviewPlan).mockResolvedValue(err('CODEX_TIMEOUT: timed out'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler({ plan: 'My plan', session_id: 'thread_abc' }, {});

    expect(result.isError).toBe(true);
    expect(markSessionFailed).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('uses preflightId for markSessionCompleted when session_id provided', async () => {
    vi.mocked(activateSession).mockReturnValue(ok({ session_id: 'thread_abc', status: 'in_progress' as const, created_at: '2026-01-01', completed_at: null }));
    const codexResult = { ...validResult, session_id: 'thread_different' };
    vi.mocked(mockClient.reviewPlan).mockResolvedValue(ok(codexResult));

    await handler({ plan: 'My plan', session_id: 'thread_abc' }, {});

    expect(markSessionCompleted).toHaveBeenCalledWith(mockDb, 'thread_abc');
  });
});
