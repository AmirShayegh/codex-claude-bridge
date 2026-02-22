import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCli } from './commands.js';
import type { CliDeps } from './commands.js';

// Mock the codex client
vi.mock('../codex/client.js', () => ({
  createCodexClient: vi.fn().mockReturnValue({
    reviewPlan: vi.fn(),
    reviewCode: vi.fn(),
    reviewPrecommit: vi.fn(),
  }),
}));

// Mock config loader
vi.mock('../config/loader.js', () => ({
  loadConfig: vi.fn().mockReturnValue({ ok: true, data: {} }),
}));

// Mock stdin reader
vi.mock('./stdin.js', () => ({
  readInput: vi.fn(),
  resetStdinGuard: vi.fn(),
}));

// Mock resolve-diff
vi.mock('../utils/resolve-diff.js', () => ({
  resolvePrecommitDiff: vi.fn(),
}));

import { createCodexClient } from '../codex/client.js';
import { readInput } from './stdin.js';
import { resolvePrecommitDiff } from '../utils/resolve-diff.js';

const mockCreateClient = vi.mocked(createCodexClient);
const mockReadInput = vi.mocked(readInput);
const mockResolveDiff = vi.mocked(resolvePrecommitDiff);

function createDeps(): CliDeps & { stdoutBuf: string; stderrBuf: string; exitCode: number | null } {
  const deps = {
    stdoutBuf: '',
    stderrBuf: '',
    exitCode: null as number | null,
    stdout: { write: (s: string) => { deps.stdoutBuf += s; return true; } },
    stderr: { write: (s: string) => { deps.stderrBuf += s; return true; } },
    exit: (code: number) => { deps.exitCode = code; },
    env: {},
    isTTY: false,
  };
  return deps;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('review-plan command', () => {
  it('calls reviewPlan with plan content from file', async () => {
    mockReadInput.mockResolvedValue({ ok: true, data: 'My plan content' });
    const mockClient = {
      reviewPlan: vi.fn().mockResolvedValue({
        ok: true,
        data: { verdict: 'approve', summary: 'Looks good', findings: [], session_id: 's1' },
      }),
      reviewCode: vi.fn(),
      reviewPrecommit: vi.fn(),
    };
    mockCreateClient.mockReturnValue(mockClient);

    const deps = createDeps();
    await runCli(['node', 'bridge', 'review-plan', '--plan', '/tmp/plan.md'], deps);

    expect(mockReadInput).toHaveBeenCalledWith('/tmp/plan.md');
    expect(mockClient.reviewPlan).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'My plan content' }),
    );
    expect(deps.stdoutBuf).toContain('APPROVE');
    expect(deps.exitCode).toBe(0);
  });

  it('passes focus and depth options', async () => {
    mockReadInput.mockResolvedValue({ ok: true, data: 'plan' });
    const mockClient = {
      reviewPlan: vi.fn().mockResolvedValue({
        ok: true,
        data: { verdict: 'approve', summary: 'ok', findings: [], session_id: 's1' },
      }),
      reviewCode: vi.fn(),
      reviewPrecommit: vi.fn(),
    };
    mockCreateClient.mockReturnValue(mockClient);

    const deps = createDeps();
    await runCli(['node', 'bridge', 'review-plan', '--plan', 'f.md', '--focus', 'security,performance', '--depth', 'thorough'], deps);

    expect(mockClient.reviewPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        focus: ['security', 'performance'],
        depth: 'thorough',
      }),
    );
  });

  it('outputs JSON when --json flag is set', async () => {
    mockReadInput.mockResolvedValue({ ok: true, data: 'plan' });
    const data = { verdict: 'approve', summary: 'ok', findings: [], session_id: 's1' };
    const mockClient = {
      reviewPlan: vi.fn().mockResolvedValue({ ok: true, data }),
      reviewCode: vi.fn(),
      reviewPrecommit: vi.fn(),
    };
    mockCreateClient.mockReturnValue(mockClient);

    const deps = createDeps();
    await runCli(['node', 'bridge', 'review-plan', '--plan', 'f.md', '--json'], deps);

    expect(JSON.parse(deps.stdoutBuf)).toEqual(data);
  });

  it('exits 1 when input read fails', async () => {
    mockReadInput.mockResolvedValue({ ok: false, error: 'ENOENT' });
    mockCreateClient.mockReturnValue({
      reviewPlan: vi.fn(),
      reviewCode: vi.fn(),
      reviewPrecommit: vi.fn(),
    });

    const deps = createDeps();
    await runCli(['node', 'bridge', 'review-plan', '--plan', '/bad/path'], deps);

    expect(deps.exitCode).toBe(1);
    expect(deps.stderrBuf).toContain('ENOENT');
  });
});

describe('review-code command', () => {
  it('calls reviewCode with diff content', async () => {
    mockReadInput.mockResolvedValue({ ok: true, data: 'diff --git ...' });
    const mockClient = {
      reviewPlan: vi.fn(),
      reviewCode: vi.fn().mockResolvedValue({
        ok: true,
        data: { verdict: 'approve', summary: 'Clean', findings: [], session_id: 's2' },
      }),
      reviewPrecommit: vi.fn(),
    };
    mockCreateClient.mockReturnValue(mockClient);

    const deps = createDeps();
    await runCli(['node', 'bridge', 'review-code', '--diff', 'changes.patch'], deps);

    expect(mockReadInput).toHaveBeenCalledWith('changes.patch');
    expect(mockClient.reviewCode).toHaveBeenCalledWith(
      expect.objectContaining({ diff: 'diff --git ...' }),
    );
    expect(deps.exitCode).toBe(0);
  });
});

describe('review-precommit command', () => {
  it('auto-captures staged diff when no --diff flag', async () => {
    mockResolveDiff.mockResolvedValue({ ok: true, data: 'staged diff' });
    const mockClient = {
      reviewPlan: vi.fn(),
      reviewCode: vi.fn(),
      reviewPrecommit: vi.fn().mockResolvedValue({
        ok: true,
        data: { ready_to_commit: true, blockers: [], warnings: [], session_id: 's3' },
      }),
    };
    mockCreateClient.mockReturnValue(mockClient);

    const deps = createDeps();
    await runCli(['node', 'bridge', 'review-precommit'], deps);

    expect(mockResolveDiff).toHaveBeenCalledWith({ diff: undefined, auto_diff: true });
    expect(deps.stdoutBuf).toContain('OK TO COMMIT');
    expect(deps.exitCode).toBe(0);
  });

  it('exits 2 when commit is blocked', async () => {
    mockResolveDiff.mockResolvedValue({ ok: true, data: 'staged diff' });
    const mockClient = {
      reviewPlan: vi.fn(),
      reviewCode: vi.fn(),
      reviewPrecommit: vi.fn().mockResolvedValue({
        ok: true,
        data: { ready_to_commit: false, blockers: ['Bug found'], warnings: [], session_id: 's4' },
      }),
    };
    mockCreateClient.mockReturnValue(mockClient);

    const deps = createDeps();
    await runCli(['node', 'bridge', 'review-precommit'], deps);

    expect(deps.stdoutBuf).toContain('COMMIT BLOCKED');
    expect(deps.exitCode).toBe(2);
  });

  it('uses explicit diff from --diff flag', async () => {
    mockReadInput.mockResolvedValue({ ok: true, data: 'explicit diff' });
    mockResolveDiff.mockResolvedValue({ ok: true, data: 'explicit diff' });
    const mockClient = {
      reviewPlan: vi.fn(),
      reviewCode: vi.fn(),
      reviewPrecommit: vi.fn().mockResolvedValue({
        ok: true,
        data: { ready_to_commit: true, blockers: [], warnings: [], session_id: 's5' },
      }),
    };
    mockCreateClient.mockReturnValue(mockClient);

    const deps = createDeps();
    await runCli(['node', 'bridge', 'review-precommit', '--diff', 'my.patch'], deps);

    expect(mockReadInput).toHaveBeenCalledWith('my.patch');
    // auto_diff should be false when --diff is provided
    expect(mockResolveDiff).toHaveBeenCalledWith({ diff: 'explicit diff', auto_diff: false });
  });

  it('exits 1 when diff resolution fails', async () => {
    mockResolveDiff.mockResolvedValue({ ok: false, error: 'GIT_ERROR: not a git repo' });
    mockCreateClient.mockReturnValue({
      reviewPlan: vi.fn(),
      reviewCode: vi.fn(),
      reviewPrecommit: vi.fn(),
    });

    const deps = createDeps();
    await runCli(['node', 'bridge', 'review-precommit'], deps);

    expect(deps.exitCode).toBe(1);
    expect(deps.stderrBuf).toContain('GIT_ERROR');
  });
});

describe('--help and --version', () => {
  it('shows help text', async () => {
    const deps = createDeps();
    await runCli(['node', 'bridge', '--help'], deps);

    expect(deps.stdoutBuf).toContain('review-plan');
    expect(deps.stdoutBuf).toContain('review-code');
    expect(deps.stdoutBuf).toContain('review-precommit');
  });

  it('shows version', async () => {
    const deps = createDeps();
    await runCli(['node', 'bridge', '--version'], deps);

    // Should output some version string
    expect(deps.stdoutBuf).toMatch(/\d+\.\d+\.\d+/);
  });
});
