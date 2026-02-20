import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCodexClient } from './client.js';
import type { ReviewBridgeConfig } from '../config/types.js';
import { DEFAULT_CONFIG } from '../config/types.js';

// Mock thread factory — configurable per test
let mockRun: ReturnType<typeof vi.fn>;
let mockThreadId: string | null;

function makeMockThread() {
  return {
    run: mockRun,
    get id() {
      return mockThreadId;
    },
  };
}

type ThreadFactory = (...args: unknown[]) => ReturnType<typeof makeMockThread>;
let mockStartThread: ReturnType<typeof vi.fn<ThreadFactory>>;
let mockResumeThread: ReturnType<typeof vi.fn<ThreadFactory>>;

let mockConstructorThrow: Error | null;

vi.mock('@openai/codex-sdk', () => {
  // Must use function (not arrow) so it's valid as a constructor with `new`
  function MockCodex() {
    if (mockConstructorThrow) throw mockConstructorThrow;
    return {
      startThread: (...args: unknown[]) => mockStartThread(...args),
      resumeThread: (...args: unknown[]) => mockResumeThread(...args),
    };
  }
  return { Codex: MockCodex };
});

beforeEach(() => {
  vi.clearAllMocks();
  mockThreadId = 'thread_abc123';
  mockRun = vi.fn();
  mockStartThread = vi.fn(() => makeMockThread());
  mockResumeThread = vi.fn(() => makeMockThread());
  mockConstructorThrow = null;
});

const config: ReviewBridgeConfig = { ...DEFAULT_CONFIG };

// Valid responses matching the response schemas (without session_id)
const validPlanResponse = {
  verdict: 'approve',
  summary: 'Plan looks solid',
  findings: [{ severity: 'minor', category: 'style', description: 'Consider renaming', file: null, line: null, suggestion: null }],
};

const validCodeResponse = {
  verdict: 'request_changes',
  summary: 'Issues found',
  findings: [{ severity: 'critical', category: 'bug', description: 'Null pointer', file: null, line: null, suggestion: null }],
};

const validPrecommitResponse = {
  ready_to_commit: true,
  blockers: [],
  warnings: ['Large diff'],
};

describe('createCodexClient', () => {
  it('returns object with reviewPlan, reviewCode, reviewPrecommit', () => {
    const client = createCodexClient(config);
    expect(typeof client.reviewPlan).toBe('function');
    expect(typeof client.reviewCode).toBe('function');
    expect(typeof client.reviewPrecommit).toBe('function');
  });
});

describe('reviewPlan', () => {
  it('returns parsed PlanReviewResult with session_id from thread', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'My plan' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verdict).toBe('approve');
      expect(result.data.summary).toBe('Plan looks solid');
      expect(result.data.findings).toHaveLength(1);
      expect(result.data.session_id).toBe('thread_abc123');
    }
  });
});

describe('reviewCode', () => {
  it('returns parsed CodeReviewResult', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validCodeResponse) });

    const client = createCodexClient(config);
    const result = await client.reviewCode({ diff: 'some diff' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verdict).toBe('request_changes');
      expect(result.data.session_id).toBe('thread_abc123');
    }
  });
});

describe('reviewPrecommit', () => {
  it('returns parsed PrecommitResult', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPrecommitResponse) });

    const client = createCodexClient(config);
    const result = await client.reviewPrecommit({ diff: 'staged diff' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.ready_to_commit).toBe(true);
      expect(result.data.warnings).toEqual(['Large diff']);
      expect(result.data.session_id).toBe('thread_abc123');
    }
  });
});

describe('retry on parse failure', () => {
  it('retries once on malformed JSON and succeeds', async () => {
    mockRun
      .mockResolvedValueOnce({ finalResponse: 'not json {{{' })
      .mockResolvedValueOnce({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(true);
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('returns CODEX_PARSE_ERROR after two malformed JSON attempts', async () => {
    mockRun.mockResolvedValue({ finalResponse: 'not json' });

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CODEX_PARSE_ERROR');
    }
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('returns CODEX_PARSE_ERROR when valid JSON fails Zod validation after retry', async () => {
    const badShape = { verdict: 'invalid_verdict', summary: 123 };
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(badShape) });

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CODEX_PARSE_ERROR');
    }
  });
});

describe('timeout handling', () => {
  it('returns CODEX_TIMEOUT on AbortError', async () => {
    const abortError = new DOMException('signal is aborted', 'AbortError');
    mockRun.mockRejectedValue(abortError);

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CODEX_TIMEOUT');
    }
  });

  it('returns CODEX_TIMEOUT on generic error containing "aborted"', async () => {
    const err = new Error('The operation was aborted');
    mockRun.mockRejectedValue(err);

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CODEX_TIMEOUT');
    }
  });

  it('returns CODEX_TIMEOUT on case-variant abort message', async () => {
    const err = new Error('Request Aborted by signal');
    mockRun.mockRejectedValue(err);

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CODEX_TIMEOUT');
    }
  });
});

describe('session management', () => {
  it('calls startThread when no session_id provided', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexClient(config);
    await client.reviewPlan({ plan: 'plan' });

    expect(mockStartThread).toHaveBeenCalledTimes(1);
    expect(mockResumeThread).not.toHaveBeenCalled();
  });

  it('calls resumeThread when session_id provided', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexClient(config);
    await client.reviewPlan({ plan: 'plan', session_id: 'existing_thread' });

    expect(mockResumeThread).toHaveBeenCalledWith('existing_thread', expect.any(Object));
    expect(mockStartThread).not.toHaveBeenCalled();
  });

  it('returns SESSION_NOT_FOUND when resumeThread throws', async () => {
    mockResumeThread.mockImplementation(() => {
      throw new Error('Thread not found');
    });

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan', session_id: 'bad_id' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('SESSION_NOT_FOUND');
    }
  });

  it('returns UNKNOWN_ERROR when startThread throws unrecognized error (no session_id)', async () => {
    mockStartThread.mockImplementation(() => {
      throw new Error('Failed to spawn');
    });

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('UNKNOWN_ERROR');
      expect(result.error).not.toContain('SESSION_NOT_FOUND');
    }
  });

  it('classifies auth errors from startThread', async () => {
    mockStartThread.mockImplementation(() => {
      throw new Error('api_key not set');
    });

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('AUTH_ERROR');
    }
  });

  it('classifies network errors from startThread', async () => {
    mockStartThread.mockImplementation(() => {
      throw new Error('fetch failed');
    });

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('NETWORK_ERROR');
    }
  });

  it('uses input session_id when thread.id is null', async () => {
    mockThreadId = null;
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan', session_id: 'fallback_id' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.session_id).toBe('fallback_id');
    }
  });
});

describe('runtime errors', () => {
  it('returns UNKNOWN_ERROR when thread.run throws non-abort error', async () => {
    mockRun.mockRejectedValue(new Error('Something completely unexpected'));

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('UNKNOWN_ERROR');
    }
  });
});

describe('error classification', () => {
  it('returns AUTH_ERROR when thread.run throws with "api_key"', async () => {
    mockRun.mockRejectedValue(new Error('Invalid api_key provided'));

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('AUTH_ERROR');
      expect(result.error).toContain('Set OPENAI_API_KEY');
    }
  });

  it('returns AUTH_ERROR when error contains "authentication"', async () => {
    mockRun.mockRejectedValue(new Error('Authentication failed'));

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('AUTH_ERROR');
    }
  });

  it('returns AUTH_ERROR when error contains "401"', async () => {
    mockRun.mockRejectedValue(new Error('401 Unauthorized'));

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('AUTH_ERROR');
    }
  });

  it('returns MODEL_ERROR with extracted model name', async () => {
    mockRun.mockRejectedValue(new Error('The model "o9-turbo" is not supported'));

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('MODEL_ERROR');
      expect(result.error).toContain('o9-turbo');
    }
  });

  it('returns MODEL_ERROR with config model when name not in error', async () => {
    const customConfig = { ...config, model: 'custom-model-7' };
    mockRun.mockRejectedValue(new Error('The model is not found'));

    const client = createCodexClient(customConfig);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('MODEL_ERROR');
      expect(result.error).toContain('custom-model-7');
    }
  });

  it('returns RATE_LIMITED when error contains "rate_limit"', async () => {
    mockRun.mockRejectedValue(new Error('rate_limit exceeded'));

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('RATE_LIMITED');
      expect(result.error).toContain('Wait a moment');
    }
  });

  it('returns NETWORK_ERROR when error contains "fetch failed"', async () => {
    mockRun.mockRejectedValue(new Error('fetch failed'));

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('NETWORK_ERROR');
      expect(result.error).toContain('Check your internet connection');
    }
  });

  it('returns NETWORK_ERROR when error contains "ECONNREFUSED"', async () => {
    mockRun.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:443'));

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('NETWORK_ERROR');
    }
  });

  it('returns NETWORK_ERROR when error contains "ENOTFOUND"', async () => {
    mockRun.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.openai.com'));

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('NETWORK_ERROR');
    }
  });

  it('preserves raw message for unknown errors', async () => {
    mockRun.mockRejectedValue(new Error('Something totally unknown'));

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('UNKNOWN_ERROR');
      expect(result.error).toContain('Something totally unknown');
    }
  });
});

describe('constructor error classification', () => {
  it('classifies auth errors during SDK init', async () => {
    mockConstructorThrow = new Error('api_key not set');

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('AUTH_ERROR');
      expect(result.error).toContain('SDK initialization failed');
    }
  });

  it('classifies network errors during SDK init', async () => {
    mockConstructorThrow = new Error('fetch failed');

    const client = createCodexClient(config);
    const result = await client.reviewPlan({ plan: 'plan' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('NETWORK_ERROR');
      expect(result.error).toContain('SDK initialization failed');
    }
  });
});

describe('config passthrough', () => {
  it('passes model and reasoning effort to thread options', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const customConfig: ReviewBridgeConfig = {
      ...DEFAULT_CONFIG,
      model: 'o3',
      reasoning_effort: 'high',
    };
    const client = createCodexClient(customConfig);
    await client.reviewPlan({ plan: 'plan' });

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'o3',
        modelReasoningEffort: 'high',
      }),
    );
  });
});

describe('config flows to prompts', () => {
  const configWithContext: ReviewBridgeConfig = {
    ...DEFAULT_CONFIG,
    project_context: 'Fintech app, PCI-DSS required',
    review_standards: {
      ...DEFAULT_CONFIG.review_standards,
      plan_review: {
        focus: ['security', 'compliance'],
        depth: 'thorough' as const,
      },
      code_review: {
        criteria: ['security', 'performance'],
        require_tests: true,
        max_file_size: 500,
      },
      precommit: {
        auto_diff: true,
        block_on: ['critical', 'major'] as Array<'critical' | 'major' | 'minor' | 'suggestion' | 'nitpick'>,
      },
    },
  };

  it('reviewPlan prompt includes project_context from config', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexClient(configWithContext);
    await client.reviewPlan({ plan: 'My plan' });

    const prompt = mockRun.mock.calls[0][0] as string;
    expect(prompt).toContain('Fintech app, PCI-DSS required');
  });

  it('reviewPlan prompt uses config focus as fallback', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexClient(configWithContext);
    await client.reviewPlan({ plan: 'My plan' });

    const prompt = mockRun.mock.calls[0][0] as string;
    expect(prompt).toContain('security');
    expect(prompt).toContain('compliance');
  });

  it('reviewCode prompt includes project_context from config', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validCodeResponse) });

    const client = createCodexClient(configWithContext);
    await client.reviewCode({ diff: 'some diff' });

    const prompt = mockRun.mock.calls[0][0] as string;
    expect(prompt).toContain('Fintech app, PCI-DSS required');
  });

  it('reviewCode prompt includes test coverage when require_tests is true', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validCodeResponse) });

    const client = createCodexClient(configWithContext);
    await client.reviewCode({ diff: 'some diff' });

    const prompt = mockRun.mock.calls[0][0] as string;
    expect(prompt).toContain('Test coverage');
  });

  it('reviewPrecommit prompt includes project_context from config', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPrecommitResponse) });

    const client = createCodexClient(configWithContext);
    await client.reviewPrecommit({ diff: 'staged diff' });

    const prompt = mockRun.mock.calls[0][0] as string;
    expect(prompt).toContain('Fintech app, PCI-DSS required');
  });

  it('reviewPrecommit prompt includes block_on severity threshold', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPrecommitResponse) });

    const client = createCodexClient(configWithContext);
    await client.reviewPrecommit({ diff: 'staged diff' });

    const prompt = mockRun.mock.calls[0][0] as string;
    expect(prompt).toContain('critical or major');
  });

  it('reviewPlan prompt uses severity rubric', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });

    const client = createCodexClient(config);
    await client.reviewPlan({ plan: 'My plan' });

    const prompt = mockRun.mock.calls[0][0] as string;
    expect(prompt).toContain('Severity definitions');
  });

  it('reviewCode prompt uses severity rubric', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validCodeResponse) });

    const client = createCodexClient(config);
    await client.reviewCode({ diff: 'some diff' });

    const prompt = mockRun.mock.calls[0][0] as string;
    expect(prompt).toContain('Severity definitions');
  });
});

describe('constructor failure', () => {
  it('returns UNKNOWN_ERROR from all methods when SDK constructor throws', async () => {
    mockConstructorThrow = new Error('Missing binary');

    const client = createCodexClient(config);

    const plan = await client.reviewPlan({ plan: 'plan' });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toContain('UNKNOWN_ERROR');

    const code = await client.reviewCode({ diff: 'diff' });
    expect(code.ok).toBe(false);
    if (!code.ok) expect(code.error).toContain('SDK initialization failed');

    const pre = await client.reviewPrecommit({ diff: 'diff' });
    expect(pre.ok).toBe(false);
    if (!pre.ok) expect(pre.error).toContain('UNKNOWN_ERROR');
  });
});
