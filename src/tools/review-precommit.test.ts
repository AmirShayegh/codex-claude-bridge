import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReviewBackend } from '../backends/backend.js';
import { DEFAULT_CONFIG } from '../config/types.js';
import type { ReviewLifecycle } from '../review/lifecycle.js';
import type { ModelIdentity, PrecommitResult } from '../review/types.js';
import { err, ok } from '../utils/errors.js';
import { registerReviewPrecommitTool } from './review-precommit.js';

vi.mock('../utils/resolve-diff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/resolve-diff.js')>();
  return { ...actual, resolvePrecommitDiff: vi.fn() };
});

import { resolvePrecommitDiff } from '../utils/resolve-diff.js';

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

const RESULT: PrecommitResult = {
  ready_to_commit: true,
  blockers: [],
  warnings: [],
  session_id: 'precommit-session',
  provider: 'codex',
  models: [MODEL],
  provenance: { persistence: 'durable', warning: null },
};

let client: ReviewBackend;
let lifecycle: ReviewLifecycle;
let server: { registerTool: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  client = {
    provider: 'codex',
    providers: ['codex'],
    allowsModelOverrideOnResume: false,
    reviewPlan: vi.fn(),
    reviewCode: vi.fn(),
    reviewPrecommit: vi.fn(),
  };
  lifecycle = {
    reviewPlan: vi.fn(),
    reviewCode: vi.fn(),
    reviewPrecommit: vi.fn().mockResolvedValue(ok(RESULT)),
  };
  server = { registerTool: vi.fn() };
  vi.mocked(resolvePrecommitDiff).mockImplementation(async ({ diff }) =>
    ok(diff ?? 'captured staged diff'),
  );
});

function setup(autoDiff = true, useLifecycle = true): HandlerFn {
  registerReviewPrecommitTool(
    server as unknown as McpServer,
    client,
    undefined,
    {
      ...DEFAULT_CONFIG,
      review_standards: {
        ...DEFAULT_CONFIG.review_standards,
        precommit: { ...DEFAULT_CONFIG.review_standards.precommit, auto_diff: autoDiff },
      },
    },
    useLifecycle ? lifecycle : undefined,
  );
  return server.registerTool.mock.calls[0][2] as HandlerFn;
}

describe('registerReviewPrecommitTool', () => {
  it('registers bounded model and session schemas', () => {
    setup();
    expect(server.registerTool.mock.calls[0][0]).toBe('review_precommit');
    const schema = server.registerTool.mock.calls[0][1].inputSchema as Record<
      string,
      { parse(value: unknown): unknown }
    >;
    expect(() => schema.model.parse('gpt\u0085forged')).toThrow();
    expect(() => schema.session_id.parse(' x')).toThrow();
  });

  it('uses project auto_diff default and forwards the resolved diff', async () => {
    const response = await setup(false)({}, {});

    expect(resolvePrecommitDiff).toHaveBeenCalledWith({ diff: undefined, auto_diff: false });
    expect(lifecycle.reviewPrecommit).toHaveBeenCalledWith({
      diff: 'captured staged diff',
      checklist: undefined,
      session_id: undefined,
      model: undefined,
    });
    expect(JSON.parse(response.content[0].text)).toEqual(RESULT);
  });

  it('lets an explicit auto_diff value override config', async () => {
    await setup(false)({ auto_diff: true }, {});
    expect(resolvePrecommitDiff).toHaveBeenCalledWith({ diff: undefined, auto_diff: true });
  });

  it('returns no-staged synthetic metadata before lifecycle admission', async () => {
    vi.mocked(resolvePrecommitDiff).mockResolvedValue(
      err('NO_STAGED_CHANGES: No staged changes found.'),
    );
    const response = await setup()({ session_id: 'existing' }, {});
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      ready_to_commit: false,
      session_id: 'existing',
      models: [],
      provenance: { persistence: 'not_recorded', warning: null },
    });
    expect(lifecycle.reviewPrecommit).not.toHaveBeenCalled();
  });

  it('returns diff and lifecycle failures as MCP errors', async () => {
    vi.mocked(resolvePrecommitDiff).mockResolvedValueOnce(err('GIT_ERROR: failed'));
    expect((await setup()({}, {})).isError).toBe(true);

    server = { registerTool: vi.fn() };
    vi.mocked(resolvePrecommitDiff).mockResolvedValueOnce(ok('diff'));
    vi.mocked(lifecycle.reviewPrecommit).mockResolvedValueOnce(err('REVIEW_BUSY: active'));
    const response = await setup()({}, {});
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('REVIEW_BUSY');
  });

  it('defers resumed model validation to the owner-aware lifecycle', async () => {
    vi.mocked(lifecycle.reviewPrecommit).mockResolvedValueOnce(
      err('INVALID_INPUT: Cannot change model on a resumed session.'),
    );
    const response = await setup()({ session_id: 'session-1', model: 'gpt-5.5' }, {});
    expect(response.isError).toBe(true);
    expect(resolvePrecommitDiff).toHaveBeenCalled();
    expect(lifecycle.reviewPrecommit).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'session-1', model: 'gpt-5.5' }),
    );
  });

  it('allows Gemini model changes and forwards the selector', async () => {
    client.allowsModelOverrideOnResume = true;
    await setup()({ session_id: 'session-1', model: 'Gemini 3.5 Pro (High)' }, {});
    expect(lifecycle.reviewPrecommit).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'Gemini 3.5 Pro (High)' }),
    );
  });

  it('retains the no-lifecycle compatibility path', async () => {
    vi.mocked(client.reviewPrecommit).mockResolvedValue(ok(RESULT));
    const response = await setup(true, false)({}, {});
    expect(JSON.parse(response.content[0].text)).toEqual(RESULT);
  });
});
