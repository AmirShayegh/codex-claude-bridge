import { describe, it, expect, vi, beforeEach, beforeAll, afterEach, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- Codex SDK mock (same pattern as backends/codex.test.ts) ---
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

let lastCodexOptions: Record<string, unknown> | undefined;

vi.mock('@openai/codex-sdk', () => {
  function MockCodex(options?: Record<string, unknown>) {
    lastCodexOptions = options;
    if (mockConstructorThrow) throw mockConstructorThrow;
    return {
      startThread: (...args: unknown[]) => mockStartThread(...args),
      resumeThread: (...args: unknown[]) => mockResumeThread(...args),
    };
  }
  return { Codex: MockCodex };
});

// --- Git mock ---
// Git is an external boundary, so it is faked wholesale; everything above it
// (workspace resolution, capture, chunking, the response boundary) is the real
// product code under test.
vi.mock('./utils/git.js', () => ({
  getStagedDiff: vi.fn(),
  getWorkingDiff: vi.fn(),
  getUnstagedDiff: vi.fn(),
  getDiffBetween: vi.fn(),
  getRepositoryRoot: vi.fn(),
  classifyHead: vi.fn(),
  isGitRepo: vi.fn(),
}));

import { getStagedDiff, getWorkingDiff, getRepositoryRoot } from './utils/git.js';
import { realpathSync } from 'node:fs';
import {
  mkdtemp,
  mkdir as mkdirp,
  realpath,
  rm,
  writeFile as writeFileAsync,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subprocessEnv, isStrippedGitVariable } from './utils/subprocess-env.js';

// What the server resolves its own launch directory to. Canonicalized, because
// that is what reaches git and comes back as captured_from.
const SERVER_DIR = realpathSync(process.cwd());

// Repository discovery answers about the directory it was given — exactly what
// `git rev-parse --show-toplevel` does. Tests that assert a caller-named
// directory was used MUST use this rather than a constant: a constant root makes
// "the caller's cwd was dropped" and "the caller's cwd was honored" produce the
// same capture, so the assertion cannot fail.
function rootsByDirectory(other: string): void {
  vi.mocked(getRepositoryRoot).mockImplementation((cwd: string) =>
    Promise.resolve({ ok: true, data: cwd.startsWith(other) ? other : SERVER_DIR }),
  );
}

// --- Valid Codex responses (without session_id — injected by client) ---
const validPlanResponse = {
  verdict: 'approve',
  summary: 'Plan looks solid',
  findings: [
    {
      severity: 'minor',
      category: 'style',
      description: 'Consider renaming',
      file: null,
      line: null,
      suggestion: null,
    },
  ],
};

const validCodeResponse = {
  verdict: 'request_changes',
  summary: 'Issues found',
  findings: [
    {
      severity: 'critical',
      category: 'bug',
      description: 'Null pointer',
      file: 'src/foo.ts',
      line: 42,
      suggestion: null,
    },
  ],
};

const validPrecommitResponse = {
  ready_to_commit: true,
  blockers: [],
  warnings: ['Large diff'],
};

// --- Helpers ---
let client: Client;
const savedEnv: Record<string, string | undefined> = {};
const temporaryDatabaseDirs: string[] = [];

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
  // The server's own directory is a real, ordinary repository as far as these
  // tests are concerned; individual cases override this to test other shapes.
  vi.mocked(getRepositoryRoot).mockResolvedValue({ ok: true, data: SERVER_DIR });
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
  await Promise.all(
    temporaryDatabaseDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('MCP integration — review_plan', () => {
  it('returns structured plan review through MCP wire protocol', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });
    client = await startServer();

    const result = await client.callTool({
      name: 'review_plan',
      arguments: { plan: 'My implementation plan' },
    });

    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.verdict).toBe('approve');
    expect(parsed.summary).toBe('Plan looks solid');
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.session_id).toBe('thread_integ_001');
    expect(parsed.models).toEqual([
      {
        provider: 'codex',
        role: 'review',
        requested: null,
        resolved: 'gpt-6-astra',
        observed: null,
        evidence: 'bridge_selection',
      },
    ]);
    expect(parsed.provenance).toEqual({ persistence: 'memory_only', warning: null });
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
    expect(parsed.models).toHaveLength(1);
    expect(parsed.provenance).toEqual({ persistence: 'memory_only', warning: null });
  });

  it('session_id threads from review_plan to review_code', async () => {
    mockRun
      .mockResolvedValueOnce({ finalResponse: JSON.stringify(validPlanResponse) })
      .mockResolvedValueOnce({ finalResponse: JSON.stringify(validCodeResponse) });
    client = await startServer();

    const planResult = await client.callTool({
      name: 'review_plan',
      arguments: { plan: 'My plan' },
    });
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

    // The directory reported back must be the one git was actually handed.
    expect(getStagedDiff).toHaveBeenCalledWith(SERVER_DIR);
    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.ready_to_commit).toBe(true);
    expect(parsed.session_id).toBe('thread_integ_001');
    expect(parsed.captured_from).toBe(SERVER_DIR);
    expect(parsed.models).toHaveLength(1);
    expect(parsed.provenance).toEqual({ persistence: 'memory_only', warning: null });
  });

  it('omits captured_from when the caller supplies an explicit diff', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPrecommitResponse) });
    client = await startServer();

    const result = await client.callTool({
      name: 'review_precommit',
      arguments: { diff: 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b' },
    });

    expect(getStagedDiff).not.toHaveBeenCalled();
    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('captured_from');
  });

  it('empty staged diff returns warning', async () => {
    vi.mocked(getStagedDiff).mockResolvedValue({ ok: true, data: '' });
    client = await startServer();

    const result = await client.callTool({ name: 'review_precommit', arguments: {} });

    const parsed = parseToolResult(result) as Record<string, unknown>;
    // ISS-028: an empty capture names where it looked, so a capture that ran in
    // the wrong repository is visible instead of reading as a clean index.
    expect(parsed.warnings as string[]).toContain(`No staged changes found in ${SERVER_DIR}`);
    expect(parsed.captured_from).toBe(SERVER_DIR);
    expect(parsed.models).toEqual([]);
    expect(parsed.provenance).toEqual({ persistence: 'not_recorded', warning: null });
  });
});

describe('MCP integration — request-bound working directory (ISS-027)', () => {
  // The whole point: one server, several repositories. The caller names the
  // directory per call; the server's own directory is only a default.
  //
  // These are REAL directories: the server proves a caller-named path exists and
  // is readable before it will run anything there, so a made-up path would be
  // rejected long before reaching the behavior under test. Git itself stays
  // mocked — it is the external boundary.
  let OTHER: string;
  const temps: string[] = [];

  beforeAll(async () => {
    OTHER = await realpath(await mkdtemp(join(tmpdir(), 'rb-mcp-b-')));
    temps.push(OTHER);
  });

  afterAll(async () => {
    for (const dir of temps) await rm(dir, { recursive: true, force: true });
  });

  async function plainDir(): Promise<string> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'rb-mcp-plain-')));
    temps.push(dir);
    return dir;
  }

  it('captures a code review from the directory the CALLER named', async () => {
    // Answer about the directory git was RUN in, the way rev-parse does. A
    // constant OTHER here would make a dropped `cwd` invisible: the capture
    // would still land in B even when the server's own directory was used.
    rootsByDirectory(OTHER);
    vi.mocked(getWorkingDiff).mockResolvedValue({
      ok: true,
      data: 'diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b',
    });
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validCodeResponse) });
    client = await startServer();

    const result = await client.callTool({ name: 'review_code', arguments: { cwd: OTHER } });

    expect(getWorkingDiff).toHaveBeenCalledWith(OTHER);
    expect(getWorkingDiff).not.toHaveBeenCalledWith(SERVER_DIR);
    expect((parseToolResult(result) as Record<string, unknown>).captured_from).toBe(OTHER);
  });

  it('captures a precommit check from the directory the CALLER named', async () => {
    rootsByDirectory(OTHER);
    vi.mocked(getStagedDiff).mockResolvedValue({ ok: true, data: 'staged in B' });
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPrecommitResponse) });
    client = await startServer();

    const result = await client.callTool({ name: 'review_precommit', arguments: { cwd: OTHER } });

    expect(getStagedDiff).toHaveBeenCalledWith(OTHER);
    expect(getStagedDiff).not.toHaveBeenCalledWith(SERVER_DIR);
    expect((parseToolResult(result) as Record<string, unknown>).captured_from).toBe(OTHER);
  });

  it('runs the reviewer subprocess in the named directory, including on resume', async () => {
    // Codex reasserts thread options on resume, so a resume that kept the
    // server's directory would move an in-flight review to another repository.
    vi.mocked(getRepositoryRoot).mockResolvedValue({ ok: true, data: OTHER });
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });
    client = await startServer();

    const plan = await client.callTool({
      name: 'review_plan',
      arguments: { plan: 'a plan', cwd: OTHER },
    });
    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: OTHER }),
    );

    const sessionId = (parseToolResult(plan) as Record<string, unknown>).session_id as string;
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validCodeResponse) });
    await client.callTool({
      name: 'review_code',
      arguments: {
        diff: 'diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b',
        session_id: sessionId,
        cwd: OTHER,
      },
    });

    expect(mockResumeThread).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ workingDirectory: OTHER }),
    );
  });

  it('rejects an unusable cwd with INVALID_INPUT and never calls the provider', async () => {
    client = await startServer();

    for (const cwd of ['relative/dir', '~/projects/app', join(OTHER, 'definitely-not-here')]) {
      const result = await client.callTool({ name: 'review_plan', arguments: { plan: 'p', cwd } });
      expect(getErrorText(result)).toContain('INVALID_INPUT');
    }
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockStartThread).not.toHaveBeenCalled();
  });

  it('refuses to auto-capture from a directory that is not a work tree', async () => {
    // Silently reviewing nothing here would read as "your changes are fine".
    vi.mocked(getRepositoryRoot).mockResolvedValue({ ok: true, data: null });
    const plain = await plainDir();
    client = await startServer();

    const result = await client.callTool({ name: 'review_code', arguments: { cwd: plain } });

    const text = getErrorText(result);
    expect(text).toContain('INVALID_INPUT');
    expect(text).toContain('not inside a git work tree');
    expect(getWorkingDiff).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('still reviews an EXPLICIT diff from a directory that is not a work tree', async () => {
    vi.mocked(getRepositoryRoot).mockResolvedValue({ ok: true, data: null });
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validCodeResponse) });
    const plain = await plainDir();
    client = await startServer();

    const result = await client.callTool({
      name: 'review_code',
      arguments: { diff: 'diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b', cwd: plain },
    });

    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.verdict).toBeDefined();
    expect(parsed).not.toHaveProperty('captured_from');
  });

  it('surfaces a real git discovery failure as GIT_ERROR, not "no repository"', async () => {
    vi.mocked(getRepositoryRoot).mockResolvedValue({
      ok: false,
      error: 'GIT_ERROR: detected dubious ownership in repository',
    });
    client = await startServer();

    const result = await client.callTool({
      name: 'review_code',
      arguments: { cwd: await plainDir() },
    });
    expect(getErrorText(result)).toContain('dubious ownership');
  });

  it('advertises cwd on all three review tools', async () => {
    client = await startServer();
    const { tools } = await client.listTools();
    for (const name of ['review_plan', 'review_code', 'review_precommit']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.inputSchema.properties).toHaveProperty('cwd');
    }
  });
});

describe('MCP integration — concurrent reviews in different repositories', () => {
  // Two repositories reviewed at the same time by one server, with a parse retry
  // in the middle of one of them. Request state is per-call, so nothing here may
  // bleed: not the diff, not the repository instructions, not the directory the
  // reviewer runs in, and not the session the result reports.
  let repoA: string;
  let repoB: string;
  const temps: string[] = [];

  async function repoWithInstructions(marker: string): Promise<string> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), `rb-conc-${marker}-`)));
    temps.push(dir);
    await mkdirp(join(dir, '.github'));
    await writeFileAsync(join(dir, '.github', 'copilot-instructions.md'), `RULES-${marker}`);
    return dir;
  }

  beforeAll(async () => {
    repoA = await repoWithInstructions('A');
    repoB = await repoWithInstructions('B');
  });

  afterAll(async () => {
    for (const dir of temps) await rm(dir, { recursive: true, force: true });
  });

  it('keeps each request’s diff, instructions, directory and session separate across a retry', async () => {
    // Identity discovery: each caller directory is its own repository root.
    vi.mocked(getRepositoryRoot).mockImplementation(async (cwd: string) => ({
      ok: true,
      data: cwd,
    }));
    // A capture that is unmistakably from one repository or the other.
    vi.mocked(getWorkingDiff).mockImplementation(async (cwd: string) => ({
      ok: true,
      data: `diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+MARKER-${cwd === repoA ? 'A' : 'B'}`,
    }));

    const runs: Array<{ dir: string; prompt: string }> = [];
    let injectedFailure = false;
    mockStartThread.mockImplementation((...args: unknown[]) => {
      const dir = (args[0] as { workingDirectory: string }).workingDirectory;
      return {
        get id() {
          return `thread-${dir === repoA ? 'A' : 'B'}`;
        },
        run: vi.fn(async (prompt: string) => {
          runs.push({ dir, prompt });
          // Exactly one malformed response, on the A-side review, so its retry
          // overlaps the B-side review still in flight.
          if (dir === repoA && !injectedFailure) {
            injectedFailure = true;
            return { finalResponse: 'not json at all' };
          }
          return { finalResponse: JSON.stringify(validCodeResponse) };
        }),
      };
    });

    client = await startServer();

    const [resultA, resultB] = await Promise.all([
      client.callTool({ name: 'review_code', arguments: { cwd: repoA } }),
      client.callTool({ name: 'review_code', arguments: { cwd: repoB } }),
    ]);

    const parsedA = parseToolResult(resultA) as Record<string, unknown>;
    const parsedB = parseToolResult(resultB) as Record<string, unknown>;

    // Each answer names its own repository and its own session.
    expect(parsedA.captured_from).toBe(repoA);
    expect(parsedB.captured_from).toBe(repoB);
    expect(parsedA.session_id).toBe('thread-A');
    expect(parsedB.session_id).toBe('thread-B');

    // The retry actually happened, and it stayed on the A side.
    expect(injectedFailure).toBe(true);
    const runsA = runs.filter((r) => r.dir === repoA);
    const runsB = runs.filter((r) => r.dir === repoB);
    expect(runsA).toHaveLength(2);
    expect(runsB).toHaveLength(1);

    // No prompt ever carried the other repository's diff or guidelines —
    // including the retry, which is the turn most likely to be rebuilt wrongly.
    for (const { prompt } of runsA) {
      expect(prompt).toContain('MARKER-A');
      expect(prompt).not.toContain('MARKER-B');
      expect(prompt).toContain('RULES-A');
      expect(prompt).not.toContain('RULES-B');
    }
    for (const { prompt } of runsB) {
      expect(prompt).toContain('MARKER-B');
      expect(prompt).not.toContain('MARKER-A');
      expect(prompt).toContain('RULES-B');
      expect(prompt).not.toContain('RULES-A');
    }

    // Git was asked about each repository by name, never about the server's own.
    expect(getWorkingDiff).toHaveBeenCalledWith(repoA);
    expect(getWorkingDiff).toHaveBeenCalledWith(repoB);
    expect(getWorkingDiff).not.toHaveBeenCalledWith(SERVER_DIR);
  });

  it('gives the reviewer subprocess a sanitized environment', async () => {
    // The SDK REPLACES the child environment when `env` is supplied, so an
    // inherited GIT_DIR here would silently redirect every review.
    client = await startServer();
    await client.callTool({ name: 'review_plan', arguments: { plan: 'p' } });

    const env = lastCodexOptions?.env as Record<string, string> | undefined;
    expect(env).toBeDefined();
    expect(env).toEqual(subprocessEnv());
    expect(Object.keys(env ?? {}).some((k) => isStrippedGitVariable(k))).toBe(false);
  });
});

describe('MCP integration — review_code auto-capture (ISS-028)', () => {
  it('reports the capture directory on an auto-captured review', async () => {
    vi.mocked(getWorkingDiff).mockResolvedValue({
      ok: true,
      data: 'diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b',
    });
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validCodeResponse) });
    client = await startServer();

    const result = await client.callTool({ name: 'review_code', arguments: {} });

    expect(getWorkingDiff).toHaveBeenCalledWith(SERVER_DIR);
    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.captured_from).toBe(SERVER_DIR);
  });

  it('names the capture directory when there is nothing to review', async () => {
    vi.mocked(getWorkingDiff).mockResolvedValue({ ok: true, data: '' });
    client = await startServer();

    const result = await client.callTool({ name: 'review_code', arguments: {} });

    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.verdict).toBe('approve');
    expect(parsed.summary).toBe(`No changes found to review in ${SERVER_DIR}.`);
    expect(parsed.captured_from).toBe(SERVER_DIR);
    // A provider-free synthetic answer never reaches the model.
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('omits captured_from when the caller supplies an explicit diff', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validCodeResponse) });
    client = await startServer();

    const result = await client.callTool({
      name: 'review_code',
      arguments: { diff: 'diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b' },
    });

    expect(getWorkingDiff).not.toHaveBeenCalled();
    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('captured_from');
  });
});

describe('MCP integration — review_history', () => {
  it('round-trips durable provenance and model metadata through a file-backed database', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-durable-int-'));
    temporaryDatabaseDirs.push(directory);
    process.env.REVIEW_BRIDGE_DB = path.join(directory, 'reviews.db');
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });
    client = await startServer();

    const review = parseToolResult(
      await client.callTool({ name: 'review_plan', arguments: { plan: 'Durable plan' } }),
    ) as Record<string, unknown>;
    const history = parseToolResult(
      await client.callTool({ name: 'review_history', arguments: { last_n: 1 } }),
    ) as { reviews: Array<Record<string, unknown>> };

    expect(review.provenance).toEqual({ persistence: 'durable', warning: null });
    expect(history.reviews[0].models).toEqual(review.models);
    expect(history.reviews[0].model_metadata_status).toBe('recorded');
  });

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
    expect(parsed.reviews[0].model_metadata_status).toBe('recorded');
    expect(parsed.reviews[0].models).toHaveLength(1);
  });

  it('round-trips identical model snapshots for plan, code, and precommit', async () => {
    mockRun
      .mockResolvedValueOnce({ finalResponse: JSON.stringify(validPlanResponse) })
      .mockResolvedValueOnce({ finalResponse: JSON.stringify(validCodeResponse) })
      .mockResolvedValueOnce({ finalResponse: JSON.stringify(validPrecommitResponse) });
    client = await startServer();

    const plan = parseToolResult(
      await client.callTool({ name: 'review_plan', arguments: { plan: 'My plan' } }),
    ) as Record<string, unknown>;
    const code = parseToolResult(
      await client.callTool({
        name: 'review_code',
        arguments: { diff: 'short diff', session_id: plan.session_id },
      }),
    ) as Record<string, unknown>;
    const precommit = parseToolResult(
      await client.callTool({
        name: 'review_precommit',
        arguments: {
          diff: 'short staged diff',
          auto_diff: false,
          session_id: plan.session_id,
        },
      }),
    ) as Record<string, unknown>;
    const history = parseToolResult(
      await client.callTool({
        name: 'review_history',
        arguments: { session_id: 'thread_integ_001' },
      }),
    ) as { reviews: Array<Record<string, unknown>>; next_cursor: string | null };

    expect(history.reviews.map((review) => review.type)).toEqual(['plan', 'code', 'precommit']);
    expect(history.reviews.map((review) => review.models)).toEqual([
      plan.models,
      code.models,
      precommit.models,
    ]);
    expect(history.reviews.every((review) => review.model_metadata_status === 'recorded')).toBe(
      true,
    );
    expect(history.next_cursor).toBeNull();
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

describe('MCP integration — session lifecycle', () => {
  it('completed session has frozen elapsed_seconds', async () => {
    mockRun.mockResolvedValue({ finalResponse: JSON.stringify(validPlanResponse) });
    client = await startServer();

    await client.callTool({ name: 'review_plan', arguments: { plan: 'My plan' } });

    const result1 = await client.callTool({
      name: 'review_status',
      arguments: { session_id: 'thread_integ_001' },
    });
    await new Promise((r) => setTimeout(r, 1100));
    const result2 = await client.callTool({
      name: 'review_status',
      arguments: { session_id: 'thread_integ_001' },
    });

    const parsed1 = parseToolResult(result1) as Record<string, unknown>;
    const parsed2 = parseToolResult(result2) as Record<string, unknown>;
    expect(parsed1.status).toBe('completed');
    expect(parsed2.status).toBe('completed');
    expect(parsed1.elapsed_seconds).toBe(parsed2.elapsed_seconds);
  });

  it('rejects an unknown memory-only resume without inventing failed session state', async () => {
    mockRun.mockRejectedValue(new Error('network timeout'));
    client = await startServer();

    const review = await client.callTool({
      name: 'review_plan',
      arguments: { plan: 'My plan', session_id: 'thread_integ_001' },
    });
    expect(getErrorText(review)).toContain('SESSION_ROUTING_UNAVAILABLE');

    const result = await client.callTool({
      name: 'review_status',
      arguments: { session_id: 'thread_integ_001' },
    });

    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.status).toBe('not_found');
  });

  it('review_history accumulates across plan and code phases', async () => {
    mockRun
      .mockResolvedValueOnce({ finalResponse: JSON.stringify(validPlanResponse) })
      .mockResolvedValueOnce({ finalResponse: JSON.stringify(validCodeResponse) });
    client = await startServer();

    await client.callTool({ name: 'review_plan', arguments: { plan: 'My plan' } });
    await client.callTool({
      name: 'review_code',
      arguments: { diff: 'some diff', session_id: 'thread_integ_001' },
    });

    const result = await client.callTool({ name: 'review_history', arguments: { last_n: 10 } });

    const parsed = parseToolResult(result) as { reviews: Record<string, unknown>[] };
    expect(parsed.reviews).toHaveLength(2);
    const types = parsed.reviews.map((r) => r.type);
    expect(types).toContain('plan');
    expect(types).toContain('code');
  });

  it('server survives Codex failure and handles next request', async () => {
    mockRun
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockResolvedValueOnce({ finalResponse: JSON.stringify(validPlanResponse) });
    client = await startServer();

    const failResult = await client.callTool({
      name: 'review_plan',
      arguments: { plan: 'Plan A' },
    });
    const failText = getErrorText(failResult);
    expect(failText).toContain('transient failure');

    const okResult = await client.callTool({ name: 'review_plan', arguments: { plan: 'Plan B' } });
    const parsed = parseToolResult(okResult) as Record<string, unknown>;
    expect(parsed.verdict).toBe('approve');
  });
});

// T-001: end-to-end test that a chunked review failing on chunk 2 marks the
// chunk-1 session as failed, exercised through real chunking + real SQLite
// (not mocked) so the actual product path is verified, not a stand-in.
describe('MCP integration — review_code multi-chunk session failure (T-001)', () => {
  let configDir: string | undefined;

  // Two files, each ~1000 tokens (~4000 chars), so under a forced
  // diffBudget=500 the chunker emits 2 pieces (one per file).
  function makeMultiChunkDiff(): string {
    const padLines = (prefix: string, count: number): string[] =>
      Array.from(
        { length: count },
        (_, i) => `${prefix}${i} padding-text-here-extra-words-for-volume`,
      );
    const fileOne = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,80 +1,80 @@',
      ...padLines('-old line ', 80),
      ...padLines('+new line ', 80),
    ];
    const fileTwo = [
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1,80 +1,80 @@',
      ...padLines('-old second ', 80),
      ...padLines('+new second ', 80),
    ];
    return [...fileOne, ...fileTwo].join('\n');
  }

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-int-'));
    configDir = dir;
    await fs.writeFile(
      path.join(dir, '.reviewbridge.json'),
      JSON.stringify({ max_chunk_tokens: 2200 }),
    );
    savedEnv.RB_CONFIG_PATH = process.env.RB_CONFIG_PATH;
    process.env.RB_CONFIG_PATH = path.join(dir, '.reviewbridge.json');
  });

  afterEach(async () => {
    if (savedEnv.RB_CONFIG_PATH === undefined) delete process.env.RB_CONFIG_PATH;
    else process.env.RB_CONFIG_PATH = savedEnv.RB_CONFIG_PATH;
    if (configDir) {
      await fs.rm(configDir, { recursive: true, force: true });
      configDir = undefined;
    }
  });

  it('marks session failed when chunk 2 errors after chunk 1 succeeded', async () => {
    const thread1Id = 'thread_partial_T001';
    mockThreadId = thread1Id;

    mockRun
      .mockResolvedValueOnce({ finalResponse: JSON.stringify(validCodeResponse) })
      .mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));

    client = await startServer();

    const reviewResult = await client.callTool({
      name: 'review_code',
      arguments: { diff: makeMultiChunkDiff() },
    });
    const errorText = getErrorText(reviewResult);
    expect(errorText).toContain('REVIEW_TIMEOUT');

    // Real chunking must have produced ≥2 chunks for this scenario to be valid.
    expect(mockRun).toHaveBeenCalledTimes(2);

    const statusResult = await client.callTool({
      name: 'review_status',
      arguments: { session_id: thread1Id },
    });
    const statusParsed = parseToolResult(statusResult) as Record<string, unknown>;
    expect(statusParsed.status).toBe('failed');
    expect(statusParsed.session_id).toBe(thread1Id);
  });
});
