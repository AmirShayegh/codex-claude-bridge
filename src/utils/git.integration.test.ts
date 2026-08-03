// Real git, no mocks — the exact scenario the bug report is about: auto-
// capture running against a repo named by `cwd` while the TEST's own
// process.cwd() is somewhere else entirely (this file's own directory,
// unrelated to either fixture). Complements git.test.ts's mocked unit
// coverage of every branch (preflight classification, error narrowing,
// etc.) with one end-to-end pass against a real git binary and a real work
// tree, colocated per the repo's own *.integration.test.ts convention (see
// src/server.integration.test.ts, src/storage/session-tracker.integration.test.ts).
//
// CI-safe: skips cleanly (not a failure) when git isn't on PATH.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStagedDiff, getWorkingDiff, isGitRepo } from './git.js';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasGit())('REAL git (no mocks) — the behavior the bug report is about', () => {
  let repo: string;
  let nonRepo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'codex-bridge-realgit-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'codex-bridge test'], { cwd: repo });
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repo });
    writeFileSync(join(repo, 'staged.txt'), 'hello staged\n');
    execFileSync('git', ['add', 'staged.txt'], { cwd: repo });

    nonRepo = mkdtempSync(join(tmpdir(), 'codex-bridge-realgit-nonrepo-'));
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(nonRepo, { recursive: true, force: true });
  });

  it('getStagedDiff(cwd) returns the real staged diff from a foreign process.cwd() — THE bug', async () => {
    // This test process's own cwd is wherever vitest launched from (this
    // repo's root), not `repo` — exactly the MCP-server-launched-elsewhere
    // scenario. Only the cwd param, not process.cwd(), should matter.
    const result = await getStagedDiff(repo);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain('staged.txt');
      expect(result.data).toContain('hello staged');
    }
  });

  it('getWorkingDiff(cwd) returns the real unstaged diff from a foreign process.cwd()', async () => {
    writeFileSync(join(repo, 'seed.txt'), 'seed changed\n');
    const result = await getWorkingDiff(repo);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain('seed.txt');
    }
  });

  it('a non-repo cwd yields the friendly, cwd-naming message — never the raw --no-index dump', async () => {
    const result = await getStagedDiff(nonRepo);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('GIT_ERROR');
      expect(result.error).toContain('is not inside a git repository');
      expect(result.error).toContain(nonRepo);
      // The exact old failure mode this fix replaces: git's --no-index
      // fallback complaining about --cached as an unknown option.
      expect(result.error.toLowerCase()).not.toContain('unknown option');
    }
  });

  it('isGitRepo discriminates a real repo from a real non-repo directory', async () => {
    expect(await isGitRepo(repo)).toBe(true);
    expect(await isGitRepo(nonRepo)).toBe(false);
  });
});
