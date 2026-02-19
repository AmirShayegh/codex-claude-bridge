import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// --- Codex SDK mock (same pattern as codex/client.test.ts) ---
let mockRun: ReturnType<typeof vi.fn>;
let mockThreadId: string | null;
let mockConstructorThrow: Error | null;

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

vi.mock('@openai/codex-sdk', () => {
  function MockCodex() {
    if (mockConstructorThrow) throw mockConstructorThrow;
    return {
      startThread: (...args: unknown[]) => mockStartThread(...args),
      resumeThread: (...args: unknown[]) => mockResumeThread(...args),
    };
  }
  return { Codex: MockCodex };
});

// --- Git mock ---
vi.mock('./utils/git.js', () => ({
  getStagedDiff: vi.fn(),
  getUnstagedDiff: vi.fn(),
  getDiffBetween: vi.fn(),
  isGitRepo: vi.fn(),
}));

import { getStagedDiff } from './utils/git.js';

// --- Valid Codex responses (without session_id — injected by client) ---
const validPlanResponse = {
  verdict: 'approve',
  summary: 'Plan looks solid',
  findings: [{ severity: 'minor', category: 'style', description: 'Consider renaming' }],
};

const validCodeResponse = {
  verdict: 'request_changes',
  summary: 'Issues found',
  findings: [{ severity: 'critical', category: 'bug', description: 'Null pointer', file: 'src/foo.ts', line: 42 }],
};

const validPrecommitResponse = {
  ready_to_commit: true,
  blockers: [],
  warnings: ['Large diff'],
};

// --- Helpers ---
let client: Client;
const savedEnv: Record<string, string | undefined> = {};

async function startServer(): Promise<Client> {
  // Dynamic import to get a fresh module with current mock state
  const { createServer } = await import('./server.js');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const c = new Client({ name: 'integration-test', version: '1.0.0' });
  await c.connect(clientTransport);
  return c;
}

// callTool returns a complex union — extract text content
interface ToolTextResult {
  content: Array<{ type: string; text: string }>;
}

function parseToolResult(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const { content } = result as unknown as ToolTextResult;
  return JSON.parse(content[0].text);
}

function getErrorText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const { content } = result as unknown as ToolTextResult;
  return content[0].text;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockThreadId = 'thread_integ_001';
  mockRun = vi.fn();
  mockStartThread = vi.fn(() => makeMockThread());
  mockResumeThread = vi.fn(() => makeMockThread());
  mockConstructorThrow = null;
  // Force in-memory DB for integration tests
  savedEnv.REVIEW_BRIDGE_DB = process.env.REVIEW_BRIDGE_DB;
  process.env.REVIEW_BRIDGE_DB = ':memory:';
});

afterEach(async () => {
  if (client) await client.close().catch(() => {});
  if (savedEnv.REVIEW_BRIDGE_DB === undefined) {
    delete process.env.REVIEW_BRIDGE_DB;
  } else {
    process.env.REVIEW_BRIDGE_DB = savedEnv.REVIEW_BRIDGE_DB;
  }
});

describe('MCP integration — review_plan', () => {
  it('returns structured plan review through MCP wire protocol', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });
    client = await startServer();

    const result = await client.callTool({ name: 'review_plan', arguments: { plan: 'My implementation plan' } });

    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.verdict).toBe('approve');
    expect(parsed.summary).toBe('Plan looks solid');
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.session_id).toBe('thread_integ_001');
  });

  it('Codex SDK init failure returns MCP error without crashing server', async () => {
    mockConstructorThrow = new Error('Missing binary');
    client = await startServer();

    const result = await client.callTool({ name: 'review_plan', arguments: { plan: 'My plan' } });

    const text = getErrorText(result);
    expect(text).toContain('UNKNOWN_ERROR');
    expect(text).toContain('SDK initialization failed');
  });
});

describe('MCP integration — review_code', () => {
  it('returns structured code review with findings through MCP wire protocol', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validCodeResponse) });
    client = await startServer();

    const result = await client.callTool({
      name: 'review_code',
      arguments: { diff: '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new' },
    });

    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.verdict).toBe('request_changes');
    expect(parsed.findings).toHaveLength(1);
    const finding = (parsed.findings as Record<string, unknown>[])[0];
    expect(finding.file).toBe('src/foo.ts');
    expect(finding.line).toBe(42);
    expect(parsed.session_id).toBe('thread_integ_001');
  });

  it('session_id threads from review_plan to review_code', async () => {
    mockRun
      .mockResolvedValueOnce({ finalResponse: JSON.stringify(validPlanResponse) })
      .mockResolvedValueOnce({ finalResponse: JSON.stringify(validCodeResponse) });
    client = await startServer();

    const planResult = await client.callTool({ name: 'review_plan', arguments: { plan: 'My plan' } });
    const planParsed = parseToolResult(planResult) as Record<string, unknown>;
    const sessionId = planParsed.session_id as string;

    await client.callTool({
      name: 'review_code',
      arguments: { diff: 'some diff', session_id: sessionId },
    });

    expect(mockResumeThread).toHaveBeenCalledWith(sessionId, expect.any(Object));
  });
});

describe('MCP integration — review_precommit', () => {
  it('auto-captures staged diff and returns precommit result', async () => {
    vi.mocked(getStagedDiff).mockResolvedValue({ ok: true, data: 'staged diff content' });
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPrecommitResponse) });
    client = await startServer();

    const result = await client.callTool({ name: 'review_precommit', arguments: {} });

    expect(getStagedDiff).toHaveBeenCalled();
    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.ready_to_commit).toBe(true);
    expect(parsed.session_id).toBe('thread_integ_001');
  });

  it('empty staged diff returns warning', async () => {
    vi.mocked(getStagedDiff).mockResolvedValue({ ok: true, data: '' });
    client = await startServer();

    const result = await client.callTool({ name: 'review_precommit', arguments: {} });

    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect((parsed.warnings as string[])).toContain('No staged changes found');
  });
});

describe('MCP integration — review_history', () => {
  it('returns saved reviews after review_plan completes', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });
    client = await startServer();

    // First: run a review so it gets saved to DB
    await client.callTool({ name: 'review_plan', arguments: { plan: 'My plan' } });

    // Then: query history
    const result = await client.callTool({ name: 'review_history', arguments: { last_n: 5 } });

    const parsed = parseToolResult(result) as { reviews: Record<string, unknown>[] };
    expect(parsed.reviews).toHaveLength(1);
    expect(parsed.reviews[0].type).toBe('plan');
    expect(parsed.reviews[0].verdict).toBe('approve');
    expect(parsed.reviews[0].session_id).toBe('thread_integ_001');
  });
});

describe('MCP integration — review_status', () => {
  it('returns session info after review completes', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });
    client = await startServer();

    await client.callTool({ name: 'review_plan', arguments: { plan: 'My plan' } });

    const result = await client.callTool({
      name: 'review_status',
      arguments: { session_id: 'thread_integ_001' },
    });

    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.status).toBe('completed');
    expect(parsed.session_id).toBe('thread_integ_001');
    expect(typeof parsed.elapsed_seconds).toBe('number');
  });

  it('unknown session returns not_found', async () => {
    client = await startServer();

    const result = await client.callTool({
      name: 'review_status',
      arguments: { session_id: 'nonexistent' },
    });

    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.status).toBe('not_found');
  });
});
