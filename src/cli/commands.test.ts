import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCli } from './commands.js';
import type { CliDeps } from './commands.js';

// Mock the codex client
vi.mock('../backends/index.js', () => ({
  createBackend: vi.fn().mockReturnValue({
    reviewPlan: vi.fn(),
    reviewCode: vi.fn(),
    reviewPrecommit: vi.fn(),
  }),
}));

// Mock config loader. createBackend is mocked (see below), so only the config
// fields the CLI reads directly matter here: review_standards.precommit.auto_diff.
vi.mock('../config/loader.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    ok: true,
    data: {
      config: { review_standards: { precommit: { auto_diff: true } } },
      source: { kind: 'default' },
    },
  }),
  formatConfigSource: vi.fn(() => 'default'),
}));

// Mock copilot-instructions so it doesn't hit the real filesystem
vi.mock('../config/copilot-instructions.js', () => ({
  loadCopilotInstructions: vi.fn(() => ({
    ok: true,
    data: { repoWide: null, scoped: [] },
  })),
}));

// Mock stdin reader
vi.mock('./stdin.js', () => ({
  readInput: vi.fn(),
  resetStdinGuard: vi.fn(),
}));

// Mock only the resolver entry point — withCapturedFrom/stampCapture beside it
// are product logic these tests exercise, so they must not be stubbed out.
vi.mock('../utils/resolve-diff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/resolve-diff.js')>();
  return { ...actual, resolvePrecommitDiff: vi.fn() };
});

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { createBackend } from '../backends/index.js';
import { openReviewDb } from '../storage/db.js';
import { getOrCreateSession } from '../storage/sessions.js';
import { readInput } from './stdin.js';
import { resolvePrecommitDiff } from '../utils/resolve-diff.js';

const mockCreateClient = vi.mocked(createBackend);
const mockReadInput = vi.mocked(readInput);
const mockResolveDiff = vi.mocked(resolvePrecommitDiff);

function createDeps(): CliDeps & { stdoutBuf: string; stderrBuf: string; exitCode: number | null } {
  const deps = {
    stdoutBuf: '',
    stderrBuf: '',
    exitCode: null as number | null,
    stdout: {
      write: (s: string) => {
        deps.stdoutBuf += s;
        return true;
      },
    },
    stderr: {
      write: (s: string) => {
        deps.stderrBuf += s;
        return true;
      },
    },
    exit: (code: number) => {
      deps.exitCode = code;
    },
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
      provider: 'codex' as const,
      providers: ['codex'] as const,
      allowsModelOverrideOnResume: false,
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
      provider: 'codex' as const,
      providers: ['codex'] as const,
      allowsModelOverrideOnResume: false,
      reviewPlan: vi.fn().mockResolvedValue({
        ok: true,
        data: { verdict: 'approve', summary: 'ok', findings: [], session_id: 's1' },
      }),
      reviewCode: vi.fn(),
      reviewPrecommit: vi.fn(),
    };
    mockCreateClient.mockReturnValue(mockClient);

    const deps = createDeps();
    await runCli(
      [
        'node',
        'bridge',
        'review-plan',
        '--plan',
        'f.md',
        '--focus',
        'security,performance',
        '--depth',
        'thorough',
      ],
      deps,
    );

    expect(mockClient.reviewPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        focus: ['security', 'performance'],
        depth: 'thorough',
      }),
    );
  });

  it('trims a valid model selector before invoking the backend', async () => {
    mockReadInput.mockResolvedValue({ ok: true, data: 'plan' });
    const mockClient = {
      provider: 'codex' as const,
      providers: ['codex'] as const,
      allowsModelOverrideOnResume: false,
      reviewPlan: vi.fn().mockResolvedValue({
        ok: true,
        data: { verdict: 'approve', summary: 'ok', findings: [], session_id: 's1' },
      }),
      reviewCode: vi.fn(),
      reviewPrecommit: vi.fn(),
    };
    mockCreateClient.mockReturnValue(mockClient);

    await runCli(
      ['node', 'bridge', 'review-plan', '--plan', 'f.md', '--model', '  gpt-5.6-sol  '],
      createDeps(),
    );

    expect(mockClient.reviewPlan).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.6-sol' }),
    );
  });

  it('rejects control-bearing models and whitespace-mutated session ids before initialization', async () => {
    const controls = createDeps();
    await runCli(
      ['node', 'bridge', 'review-plan', '--plan', 'f.md', '--model', 'gpt\nforged'],
      controls,
    );
    expect(controls.exitCode).toBe(1);
    expect(controls.stderrBuf).toContain('INVALID_INPUT');
    expect(mockCreateClient).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const whitespace = createDeps();
    await runCli(
      ['node', 'bridge', 'review-plan', '--plan', 'f.md', '--session', ' surrounded '],
      whitespace,
    );
    expect(whitespace.exitCode).toBe(1);
    expect(whitespace.stderrBuf).toContain('INVALID_INPUT');
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('outputs JSON when --json flag is set', async () => {
    mockReadInput.mockResolvedValue({ ok: true, data: 'plan' });
    const data = { verdict: 'approve', summary: 'ok', findings: [], session_id: 's1' };
    const mockClient = {
      provider: 'codex' as const,
      providers: ['codex'] as const,
      allowsModelOverrideOnResume: false,
      reviewPlan: vi.fn().mockResolvedValue({ ok: true, data }),
      reviewCode: vi.fn(),
      reviewPrecommit: vi.fn(),
    };
    mockCreateClient.mockReturnValue(mockClient);

    const deps = createDeps();
    await runCli(['node', 'bridge', 'review-plan', '--plan', 'f.md', '--json'], deps);

    expect(JSON.parse(deps.stdoutBuf)).toEqual({
      ...data,
      provenance: { persistence: 'not_recorded', warning: null },
    });
  });

  it('exits 1 when input read fails', async () => {
    mockReadInput.mockResolvedValue({ ok: false, error: 'ENOENT' });
    mockCreateClient.mockReturnValue({
      provider: 'codex',
      providers: ['codex'] as const,
      allowsModelOverrideOnResume: false,
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
      provider: 'codex' as const,
      providers: ['codex'] as const,
      allowsModelOverrideOnResume: false,
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

  it('returns an unrecorded synthetic result for an empty diff without routing a session', async () => {
    mockReadInput.mockResolvedValue({ ok: true, data: '' });
    const reviewCode = vi.fn();
    mockCreateClient.mockReturnValue({
      provider: 'codex',
      providers: ['codex'],
      allowsModelOverrideOnResume: false,
      reviewPlan: vi.fn(),
      reviewCode,
      reviewPrecommit: vi.fn(),
    });
    const deps = createDeps();

    await runCli(
      ['node', 'bridge', 'review-code', '--diff', 'empty.patch', '--session', 'unknown', '--json'],
      deps,
    );

    expect(JSON.parse(deps.stdoutBuf)).toMatchObject({
      verdict: 'approve',
      session_id: 'unknown',
      models: [],
      provenance: { persistence: 'not_recorded', warning: null },
    });
    expect(reviewCode).not.toHaveBeenCalled();
  });
});

describe('review-precommit command', () => {
  it('auto-captures staged diff when no --diff flag', async () => {
    mockResolveDiff.mockResolvedValue({ ok: true, data: 'staged diff' });
    const mockClient = {
      provider: 'codex' as const,
      providers: ['codex'] as const,
      allowsModelOverrideOnResume: false,
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

  it('prints the capture directory when the resolver reports one (ISS-028)', async () => {
    mockResolveDiff.mockResolvedValue({
      ok: true,
      data: 'staged diff',
      capturedFrom: '/work/repo-b',
    });
    mockCreateClient.mockReturnValue({
      provider: 'codex',
      providers: ['codex'],
      allowsModelOverrideOnResume: false,
      reviewPlan: vi.fn(),
      reviewCode: vi.fn(),
      reviewPrecommit: vi.fn().mockResolvedValue({
        ok: true,
        data: { ready_to_commit: true, blockers: [], warnings: [], session_id: 's-cap' },
      }),
    });

    const deps = createDeps();
    await runCli(['node', 'bridge', 'review-precommit'], deps);

    expect(deps.stdoutBuf).toContain('Captured from: /work/repo-b');
  });

  it('discards a capture location the backend tried to supply (ISS-028)', async () => {
    mockResolveDiff.mockResolvedValue({ ok: true, data: 'explicit diff' });
    mockReadInput.mockResolvedValue({ ok: true, data: 'explicit diff' });
    mockCreateClient.mockReturnValue({
      provider: 'codex',
      providers: ['codex'],
      allowsModelOverrideOnResume: false,
      reviewPlan: vi.fn(),
      reviewCode: vi.fn(),
      reviewPrecommit: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          ready_to_commit: true,
          blockers: [],
          warnings: [],
          session_id: 's-forged',
          captured_from: '/forged/by/provider',
        },
      }),
    });

    const deps = createDeps();
    await runCli(['node', 'bridge', 'review-precommit', '--diff', '/tmp/d.diff', '--json'], deps);

    const parsed = JSON.parse(deps.stdoutBuf) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('captured_from');
  });

  const precommitClient = () => ({
    provider: 'codex' as const,
    providers: ['codex'] as const,
    allowsModelOverrideOnResume: false,
    reviewPlan: vi.fn(),
    reviewCode: vi.fn(),
    reviewPrecommit: vi.fn().mockResolvedValue({
      ok: true,
      data: { ready_to_commit: true, blockers: [], warnings: [], session_id: 's' },
    }),
  });

  it('ISS-004: --no-auto-diff overrides a config auto_diff:true', async () => {
    mockResolveDiff.mockResolvedValue({ ok: true, data: 'staged diff' });
    mockCreateClient.mockReturnValue(precommitClient());

    const deps = createDeps();
    await runCli(['node', 'bridge', 'review-precommit', '--no-auto-diff'], deps);

    expect(mockResolveDiff).toHaveBeenCalledWith({ diff: undefined, auto_diff: false });
  });

  it('ISS-004: --auto-diff overrides a config auto_diff:false', async () => {
    const { loadConfig } = await import('../config/loader.js');
    vi.mocked(loadConfig).mockReturnValueOnce({
      ok: true,
      data: {
        config: { review_standards: { precommit: { auto_diff: false } } },
        source: { kind: 'default' },
      },
    } as never);
    mockResolveDiff.mockResolvedValue({ ok: true, data: 'staged diff' });
    mockCreateClient.mockReturnValue(precommitClient());

    const deps = createDeps();
    await runCli(['node', 'bridge', 'review-precommit', '--auto-diff'], deps);

    expect(mockResolveDiff).toHaveBeenCalledWith({ diff: undefined, auto_diff: true });
  });

  it('exits 2 when commit is blocked', async () => {
    mockResolveDiff.mockResolvedValue({ ok: true, data: 'staged diff' });
    const mockClient = {
      provider: 'codex' as const,
      providers: ['codex'] as const,
      allowsModelOverrideOnResume: false,
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
      provider: 'codex' as const,
      providers: ['codex'] as const,
      allowsModelOverrideOnResume: false,
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
      provider: 'codex',
      providers: ['codex'] as const,
      allowsModelOverrideOnResume: false,
      reviewPlan: vi.fn(),
      reviewCode: vi.fn(),
      reviewPrecommit: vi.fn(),
    });

    const deps = createDeps();
    await runCli(['node', 'bridge', 'review-precommit'], deps);

    expect(deps.exitCode).toBe(1);
    expect(deps.stderrBuf).toContain('GIT_ERROR');
  });

  it('returns an unrecorded no-staged result without routing or invoking a provider', async () => {
    mockResolveDiff.mockResolvedValue({
      ok: false,
      error: 'NO_STAGED_CHANGES: No staged changes found.',
    });
    const reviewPrecommit = vi.fn();
    mockCreateClient.mockReturnValue({
      provider: 'codex',
      providers: ['codex'],
      allowsModelOverrideOnResume: false,
      reviewPlan: vi.fn(),
      reviewCode: vi.fn(),
      reviewPrecommit,
    });
    const deps = createDeps();

    await runCli(['node', 'bridge', 'review-precommit', '--session', 'unknown', '--json'], deps);

    expect(JSON.parse(deps.stdoutBuf)).toMatchObject({
      ready_to_commit: false,
      session_id: 'unknown',
      models: [],
      provenance: { persistence: 'not_recorded', warning: null },
    });
    expect(reviewPrecommit).not.toHaveBeenCalled();
    expect(deps.exitCode).toBe(2);
  });

  it('names the capture directory in a no-staged-changes result (ISS-028)', async () => {
    mockResolveDiff.mockResolvedValue({
      ok: false,
      error: 'NO_STAGED_CHANGES: No staged changes found in /work/repo-b.',
      capturedFrom: '/work/repo-b',
    });
    mockCreateClient.mockReturnValue({
      provider: 'codex',
      providers: ['codex'],
      allowsModelOverrideOnResume: false,
      reviewPlan: vi.fn(),
      reviewCode: vi.fn(),
      reviewPrecommit: vi.fn(),
    });
    const deps = createDeps();

    await runCli(['node', 'bridge', 'review-precommit', '--json'], deps);

    expect(JSON.parse(deps.stdoutBuf)).toMatchObject({
      ready_to_commit: false,
      warnings: ['No staged changes found in /work/repo-b'],
      captured_from: '/work/repo-b',
    });
    expect(deps.exitCode).toBe(2);
  });
});

describe('config errors', () => {
  it('exits 1 with stderr message when loadConfig returns err', async () => {
    const { loadConfig } = await import('../config/loader.js');
    vi.mocked(loadConfig).mockReturnValueOnce({
      ok: false,
      error: 'CONFIG_ERROR: RB_CONFIG_PATH=/missing.json not found',
    });
    mockReadInput.mockResolvedValue({ ok: true, data: 'plan' });

    const deps = createDeps();
    await runCli(['node', 'bridge', 'review-plan', '--plan', '/tmp/p.md'], deps);

    expect(deps.exitCode).toBe(1);
    expect(deps.stderrBuf).toContain('CONFIG_ERROR');
    expect(deps.stderrBuf).toContain('RB_CONFIG_PATH');
  });

  it('escapes controls in errors rendered before the generic handler runs', async () => {
    const escape = String.fromCharCode(0x1b);
    const c1 = String.fromCharCode(0x85);
    const { loadConfig } = await import('../config/loader.js');
    vi.mocked(loadConfig).mockReturnValueOnce({
      ok: false,
      error: `CONFIG_ERROR: bad\nline${escape}escape${c1}c1`,
    });

    const deps = createDeps();
    await runCli(['node', 'bridge', 'review-plan', '--plan', '/tmp/p.md'], deps);

    expect(deps.stderrBuf).toBe('Error: CONFIG_ERROR: bad\\nline\\x1Bescape\\x85c1\n');
    expect(deps.stderrBuf).not.toContain(escape);
    expect(deps.stderrBuf).not.toContain(c1);
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

// ISS-017: the cross-provider resume guard must also fire in the CLI, not just
// the MCP tool layer. Uses a REAL seeded db (guard logic is unmocked here).
describe('cross-provider resume guard (ISS-017)', () => {
  const DIFF = 'diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b';
  let dbPath: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.REVIEW_BRIDGE_DB;
    dbPath = join(tmpdir(), `bridge-guard-${process.pid}-${Date.now()}.db`);
    process.env.REVIEW_BRIDGE_DB = dbPath;
    const seed = openReviewDb();
    getOrCreateSession(seed, 'g-sess', 'gemini'); // a gemini-owned session
    seed.close();
    mockReadInput.mockResolvedValue({ ok: true, data: DIFF });
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.REVIEW_BRIDGE_DB;
    else process.env.REVIEW_BRIDGE_DB = savedEnv;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(dbPath + suffix);
      } catch {
        /* ignore */
      }
    }
  });

  it('rejects a gemini-owned session under a codex client (PROVIDER_MISMATCH, exit 1)', async () => {
    mockCreateClient.mockReturnValue({
      provider: 'codex',
      providers: ['codex'],
      allowsModelOverrideOnResume: false,
      reviewPlan: vi.fn(),
      reviewCode: vi.fn(),
      reviewPrecommit: vi.fn(),
    });

    const deps = createDeps();
    await runCli(
      ['node', 'bridge', 'review-code', '--diff', '/tmp/d.diff', '--session', 'g-sess'],
      deps,
    );

    expect(deps.exitCode).toBe(1);
    expect(deps.stderrBuf).toContain('PROVIDER_MISMATCH');
  });

  it('allows the session when the client serves that provider', async () => {
    const reviewCode = vi.fn().mockResolvedValue({
      ok: true,
      data: { verdict: 'approve', summary: 's', findings: [], session_id: 'g-sess' },
    });
    mockCreateClient.mockReturnValue({
      provider: 'gemini',
      providers: ['gemini'],
      allowsModelOverrideOnResume: true,
      reviewPlan: vi.fn(),
      reviewCode,
      reviewPrecommit: vi.fn(),
    });

    const deps = createDeps();
    await runCli(
      ['node', 'bridge', 'review-code', '--diff', '/tmp/d.diff', '--session', 'g-sess'],
      deps,
    );

    expect(reviewCode).toHaveBeenCalled();
    expect(deps.exitCode).not.toBe(1);
  });
});
