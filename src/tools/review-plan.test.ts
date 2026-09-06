import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReviewBackend } from '../backends/backend.js';
import type { ReviewLifecycle } from '../review/lifecycle.js';
import type { ModelIdentity, PlanReviewResult } from '../review/types.js';
import { err, ok } from '../utils/errors.js';
import { registerReviewPlanTool } from './review-plan.js';

// Preparation is the tool's workspace seam (ISS-027). It is faked here so these
// tests stay about tool wiring; request-prep.test.ts covers the real flow.
vi.mock('../review/request-prep.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../review/request-prep.js')>();
  return { ...actual, preparePlanReview: vi.fn() };
});

import { preparePlanReview } from '../review/request-prep.js';
import type { RequestPreparationDeps } from '../review/request-prep.js';
import { createPreparationLimiter } from '../review/preparation.js';

const EXEC = { workingDirectory: '/work/repo-b' };

const PREP: RequestPreparationDeps = {
  limiter: createPreparationLimiter(),
  defaultWorkingDirectory: '/work/repo-b',
  loadInstructions: false,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandlerFn = (args: Record<string, unknown>, extra: unknown) => Promise<any>;

const MODEL: ModelIdentity = {
  provider: 'codex',
  role: 'review',
  requested: null,
  resolved: 'gpt-5.6-sol',
  observed: 'gpt-5.6-sol',
  evidence: 'runtime_session_record',
};

const RESULT: PlanReviewResult = {
  verdict: 'approve',
  summary: 'Plan looks solid',
  findings: [],
  session_id: '01901234-5678-7abc-8def-0123456789ab',
  provider: 'codex',
  models: [MODEL],
  provenance: { persistence: 'durable', warning: null },
};

let client: ReviewBackend;
let lifecycle: ReviewLifecycle;
let server: { registerTool: ReturnType<typeof vi.fn> };

beforeEach(() => {
  client = {
    provider: 'codex',
    providers: ['codex'],
    allowsModelOverrideOnResume: false,
    reviewPlan: vi.fn(),
    reviewCode: vi.fn(),
    reviewPrecommit: vi.fn(),
  };
  lifecycle = {
    reviewPlan: vi.fn().mockResolvedValue(ok(RESULT)),
    reviewCode: vi.fn(),
    reviewPrecommit: vi.fn(),
  };
  server = { registerTool: vi.fn() };
  vi.mocked(preparePlanReview).mockResolvedValue(ok(EXEC));
});

function setup(useLifecycle = true): HandlerFn {
  registerReviewPlanTool(
    server as unknown as McpServer,
    client,
    PREP,
    undefined,
    useLifecycle ? lifecycle : undefined,
  );
  return server.registerTool.mock.calls[0][2] as HandlerFn;
}

describe('registerReviewPlanTool', () => {
  it('registers the tool and bounded model/session validators', () => {
    setup();
    expect(server.registerTool.mock.calls[0][0]).toBe('review_plan');
    const schema = server.registerTool.mock.calls[0][1].inputSchema as Record<
      string,
      { parse(value: unknown): unknown }
    >;
    expect(() => schema.plan.parse(undefined)).toThrow();
    expect(schema.model.parse('  gpt-5.6-sol  ')).toBe('gpt-5.6-sol');
    expect(() => schema.model.parse(`gpt\nforged`)).toThrow();
    expect(() => schema.session_id.parse(' surrounded ')).toThrow();
  });

  it('returns lifecycle model and provenance metadata unchanged', async () => {
    const handler = setup();
    const response = await handler({ plan: 'My plan' }, {});

    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.content[0].text)).toEqual(RESULT);
    expect(lifecycle.reviewPlan).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'My plan', execution: EXEC }),
    );
    expect(client.reviewPlan).not.toHaveBeenCalled();
  });

  it('returns a lifecycle failure as an MCP error', async () => {
    vi.mocked(lifecycle.reviewPlan).mockResolvedValue(err('REVIEW_BUSY: active'));
    const response = await setup()({ plan: 'My plan' }, {});
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('REVIEW_BUSY');
  });

  it('defers resumed model validation to the owner-aware lifecycle', async () => {
    vi.mocked(lifecycle.reviewPlan).mockResolvedValueOnce(
      err('INVALID_INPUT: Cannot change model on a resumed session.'),
    );
    const response = await setup()(
      { plan: 'My plan', session_id: 'session-1', model: 'gpt-5.5' },
      {},
    );
    expect(response.isError).toBe(true);
    expect(lifecycle.reviewPlan).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'session-1', model: 'gpt-5.5' }),
    );
  });

  it('allows a Gemini model change on resume', async () => {
    client.allowsModelOverrideOnResume = true;
    const handler = setup();
    await handler({ plan: 'My plan', session_id: 'session-1', model: 'Gemini 3.5 Pro (High)' }, {});
    expect(lifecycle.reviewPlan).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'session-1', model: 'Gemini 3.5 Pro (High)' }),
    );
  });

  it('retains the no-lifecycle compatibility path', async () => {
    vi.mocked(client.reviewPlan).mockResolvedValue(ok(RESULT));
    const response = await setup(false)({ plan: 'My plan' }, {});
    expect(JSON.parse(response.content[0].text)).toEqual(RESULT);
  });

  it('turns an unexpected lifecycle exception into an MCP error', async () => {
    vi.mocked(lifecycle.reviewPlan).mockRejectedValue(new Error('network failure'));
    const response = await setup()({ plan: 'My plan' }, {});
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('network failure');
  });
});
