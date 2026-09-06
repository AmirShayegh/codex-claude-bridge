import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReviewBackend } from '../backends/backend.js';
import type { ReviewLifecycle } from '../review/lifecycle.js';
import type { CodeReviewResult, ModelIdentity } from '../review/types.js';
import { err, ok } from '../utils/errors.js';
import { registerReviewCodeTool } from './review-code.js';

vi.mock('../utils/resolve-diff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/resolve-diff.js')>();
  return { ...actual, resolveCodeDiff: vi.fn() };
});

import { resolveCodeDiff } from '../utils/resolve-diff.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandlerFn = (args: Record<string, unknown>, extra: unknown) => Promise<any>;

const MODEL: ModelIdentity = {
  provider: 'gemini',
  role: 'review',
  requested: null,
  resolved: 'Gemini 3.5 Pro (High)',
  observed: null,
  evidence: 'bridge_selection',
};

const RESULT: CodeReviewResult = {
  verdict: 'request_changes',
  summary: 'Issues found',
  findings: [
    {
      severity: 'major',
      category: 'bug',
      description: 'Null dereference',
      file: 'src/index.ts',
      line: 42,
      suggestion: 'Add a guard',
    },
  ],
  session_id: 'code-session',
  provider: 'gemini',
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
    providers: ['codex', 'gemini'],
    allowsModelOverrideOnResume: false,
    reviewPlan: vi.fn(),
    reviewCode: vi.fn(),
    reviewPrecommit: vi.fn(),
  };
  lifecycle = {
    reviewPlan: vi.fn(),
    reviewCode: vi.fn().mockResolvedValue(ok(RESULT)),
    reviewPrecommit: vi.fn(),
  };
  server = { registerTool: vi.fn() };
  vi.mocked(resolveCodeDiff).mockImplementation(async ({ diff }) => ok(diff ?? 'captured diff'));
});

function setup(useLifecycle = true): HandlerFn {
  registerReviewCodeTool(
    server as unknown as McpServer,
    client,
    undefined,
    useLifecycle ? lifecycle : undefined,
  );
  return server.registerTool.mock.calls[0][2] as HandlerFn;
}

describe('registerReviewCodeTool', () => {
  it('registers bounded model and session input schemas', () => {
    setup();
    expect(server.registerTool.mock.calls[0][0]).toBe('review_code');
    const schema = server.registerTool.mock.calls[0][1].inputSchema as Record<
      string,
      { parse(value: unknown): unknown }
    >;
    expect(() => schema.model.parse('x'.repeat(201))).toThrow();
    expect(() => schema.session_id.parse('x\u007fy')).toThrow();
  });

  it('resolves and forwards the exact diff to the lifecycle', async () => {
    const response = await setup()({ diff: 'explicit diff', context: 'intent' }, {});

    expect(resolveCodeDiff).toHaveBeenCalledWith({ diff: 'explicit diff', auto_diff: true });
    expect(lifecycle.reviewCode).toHaveBeenCalledWith(
      expect.objectContaining({ diff: 'explicit diff', context: 'intent' }),
    );
    expect(JSON.parse(response.content[0].text)).toEqual(RESULT);
  });

  it('auto-captures when diff is omitted', async () => {
    await setup()({}, {});
    expect(resolveCodeDiff).toHaveBeenCalledWith({ diff: undefined, auto_diff: true });
    expect(lifecycle.reviewCode).toHaveBeenCalledWith(
      expect.objectContaining({ diff: 'captured diff' }),
    );
  });

  it('returns synthetic model/provenance metadata without lifecycle mutation', async () => {
    vi.mocked(resolveCodeDiff).mockResolvedValue(
      err('NO_WORKING_CHANGES: No changes found vs HEAD.'),
    );

    const response = await setup()({ session_id: 'existing' }, {});
    const parsed = JSON.parse(response.content[0].text);

    expect(parsed).toMatchObject({
      verdict: 'approve',
      session_id: 'existing',
      models: [],
      provenance: { persistence: 'not_recorded', warning: null },
    });
    expect(lifecycle.reviewCode).not.toHaveBeenCalled();
  });

  it('returns git and lifecycle failures as MCP errors', async () => {
    vi.mocked(resolveCodeDiff).mockResolvedValueOnce(err('GIT_ERROR: failed'));
    expect((await setup()({}, {})).isError).toBe(true);

    server = { registerTool: vi.fn() };
    vi.mocked(resolveCodeDiff).mockResolvedValueOnce(ok('diff'));
    vi.mocked(lifecycle.reviewCode).mockResolvedValueOnce(err('REVIEW_BUSY: active'));
    const response = await setup()({}, {});
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('REVIEW_BUSY');
  });

  it('defers resumed model validation to the owner-aware lifecycle', async () => {
    vi.mocked(lifecycle.reviewCode).mockResolvedValueOnce(
      err('INVALID_INPUT: Cannot change model on a resumed session.'),
    );
    const response = await setup()({ diff: 'diff', session_id: 'session-1', model: 'gpt-5.5' }, {});
    expect(response.isError).toBe(true);
    expect(resolveCodeDiff).toHaveBeenCalled();
    expect(lifecycle.reviewCode).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'session-1', model: 'gpt-5.5' }),
    );
  });

  it('retains the no-lifecycle compatibility path', async () => {
    vi.mocked(client.reviewCode).mockResolvedValue(ok(RESULT));
    const response = await setup(false)({ diff: 'diff' }, {});
    expect(JSON.parse(response.content[0].text)).toEqual(RESULT);
  });
});

// ISS-028: an auto-captured review names the directory git ran in. The value is
// stamped at the response boundary, so it reaches the caller but never the
// reviewer, the lifecycle input, or persisted history.
describe('capture location reporting (ISS-028)', () => {
  it('stamps the resolver capture location onto a lifecycle result', async () => {
    vi.mocked(resolveCodeDiff).mockResolvedValue({
      ok: true,
      data: 'captured diff',
      capturedFrom: '/work/repo-b',
    });

    const response = await setup()({}, {});

    expect(JSON.parse(response.content[0].text)).toEqual({
      ...RESULT,
      captured_from: '/work/repo-b',
    });
  });

  it('keeps the capture location out of the persisted review input', async () => {
    vi.mocked(resolveCodeDiff).mockResolvedValue({
      ok: true,
      data: 'captured diff',
      capturedFrom: '/work/repo-b',
    });

    await setup()({}, {});

    expect(lifecycle.reviewCode).toHaveBeenCalledWith(
      expect.not.objectContaining({ captured_from: expect.anything() }),
    );
  });

  it('stamps the capture location on the no-lifecycle compatibility path', async () => {
    vi.mocked(resolveCodeDiff).mockResolvedValue({
      ok: true,
      data: 'captured diff',
      capturedFrom: '/work/repo-b',
    });
    vi.mocked(client.reviewCode).mockResolvedValue(ok(RESULT));

    const response = await setup(false)({}, {});

    expect(JSON.parse(response.content[0].text).captured_from).toBe('/work/repo-b');
  });

  it('omits captured_from entirely for an explicit diff', async () => {
    const response = await setup()({ diff: 'explicit diff' }, {});
    expect(JSON.parse(response.content[0].text)).not.toHaveProperty('captured_from');
  });

  it('discards a capture location the backend supplied', async () => {
    vi.mocked(resolveCodeDiff).mockResolvedValue(ok('explicit diff'));
    vi.mocked(lifecycle.reviewCode).mockResolvedValueOnce(
      ok({ ...RESULT, captured_from: '/forged/by/provider' }),
    );

    const response = await setup()({ diff: 'explicit diff' }, {});

    expect(JSON.parse(response.content[0].text)).not.toHaveProperty('captured_from');
  });

  it('names the capture directory when there is nothing to review', async () => {
    vi.mocked(resolveCodeDiff).mockResolvedValue({
      ok: false,
      error: 'NO_WORKING_CHANGES: No changes found vs HEAD in /work/repo-b.',
      capturedFrom: '/work/repo-b',
    });

    const parsed = JSON.parse((await setup()({}, {})).content[0].text);

    expect(parsed.summary).toBe('No changes found to review in /work/repo-b.');
    expect(parsed.captured_from).toBe('/work/repo-b');
    expect(lifecycle.reviewCode).not.toHaveBeenCalled();
  });

  it('escapes controls in the message while keeping the field raw', async () => {
    vi.mocked(resolveCodeDiff).mockResolvedValue({
      ok: false,
      error: 'NO_WORKING_CHANGES: nothing',
      capturedFrom: '/work/re\u001bpo',
    });

    const parsed = JSON.parse((await setup()({}, {})).content[0].text);

    expect(parsed.summary).toContain('\\x1B');
    expect(parsed.summary).not.toContain('\u001b');
    expect(parsed.captured_from).toBe('/work/re\u001bpo');
  });
});
