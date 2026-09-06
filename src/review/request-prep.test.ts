import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePlanReview, prepareDiffReview } from './request-prep.js';
import type { RequestPreparationDeps, PreparedDiffReview } from './request-prep.js';
import type { Result } from '../utils/errors.js';
import { createPreparationLimiter } from './preparation.js';
import { subprocessEnv } from '../utils/subprocess-env.js';
// TypeScript needs the `kind === 'ready'` narrowing to reach the fields below,
// but a bare `if` makes every assertion inside it OPTIONAL: revert the feature
// and the branch simply stops running, and the test passes having checked
// nothing. Calling this first turns that silent skip into a failure, and the
// `if` that follows is then narrowing only.
function expectReady(result: Result<PreparedDiffReview>): void {
  if (!result.ok) {
    throw new Error(`expected a prepared review, got error: ${result.error}`);
  }
  if (result.data.kind !== 'ready') {
    throw new Error(`expected a 'ready' review, got '${result.data.kind}'`);
  }
}

const run = promisify(execFile);

// REAL git repositories and REAL instruction files. Preparation exists to make a
// caller-named directory decide where git runs and which guidelines apply — a
// mocked filesystem would only prove the mock agrees with itself.
const created: string[] = [];

async function tempDir(prefix = 'rb-prep-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return realpath(dir);
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run('git', args, { cwd, env: subprocessEnv() });
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'Test');
}

async function commitFile(dir: string, name: string, body: string): Promise<void> {
  await writeFile(join(dir, name), body);
  await git(dir, 'add', name);
  await git(dir, 'commit', '-qm', `add ${name}`);
}

async function repoWithCommit(): Promise<string> {
  const dir = await tempDir();
  await initRepo(dir);
  await commitFile(dir, 'app.ts', 'export const a = 1;\n');
  return dir;
}

function deps(defaultWorkingDirectory: string, loadInstructions = false): RequestPreparationDeps {
  return {
    limiter: createPreparationLimiter(),
    defaultWorkingDirectory,
    loadInstructions,
  };
}

afterAll(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('preparePlanReview', () => {
  it('runs in the directory the request names', async () => {
    const a = await tempDir();
    const b = await tempDir();
    const result = await preparePlanReview(deps(a), { cwd: b });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.workingDirectory).toBe(b);
  });

  it('falls back to the captured default when no directory is named', async () => {
    const a = await tempDir();
    const result = await preparePlanReview(deps(a), {});
    expect(result.ok && result.data.workingDirectory).toBe(a);
  });

  it('needs no repository at all', async () => {
    // A plan is text. Requiring a work tree would reject a perfectly good review.
    const plain = await tempDir();
    expect((await preparePlanReview(deps(plain), { cwd: plain })).ok).toBe(true);
  });

  it('rejects a relative path instead of resolving it against the server', async () => {
    const a = await tempDir();
    const result = await preparePlanReview(deps(a), { cwd: 'relative/dir' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^INVALID_INPUT:/);
  });

  it('rejects a directory that does not exist', async () => {
    const a = await tempDir();
    const result = await preparePlanReview(deps(a), { cwd: join(a, 'nope') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^INVALID_INPUT:/);
  });
});

describe('prepareDiffReview — capture', () => {
  it('captures staged changes from the requested repository, not the default one', async () => {
    // The bug this feature fixes: the server sits in repository A while the
    // caller is working in repository B.
    const a = await repoWithCommit();
    const b = await repoWithCommit();
    await writeFile(join(b, 'app.ts'), 'export const a = 2;\n');
    await git(b, 'add', 'app.ts');

    const result = await prepareDiffReview(deps(a), {
      cwd: b,
      source: { kind: 'capture', target: 'staged' },
    });

    expect(result.ok).toBe(true);
    expectReady(result);
    if (result.ok && result.data.kind === 'ready') {
      expect(result.data.diff).toContain('export const a = 2;');
      expect(result.data.capturedFrom).toBe(b);
    }
  });

  it('captures working-tree changes from the requested repository', async () => {
    const a = await repoWithCommit();
    const b = await repoWithCommit();
    await writeFile(join(b, 'app.ts'), 'export const a = 3;\n');

    const result = await prepareDiffReview(deps(a), {
      cwd: b,
      source: { kind: 'capture', target: 'working' },
    });

    expect(result.ok).toBe(true);
    expectReady(result);
    if (result.ok && result.data.kind === 'ready') {
      expect(result.data.diff).toContain('export const a = 3;');
      expect(result.data.capturedFrom).toBe(b);
    }
  });

  it('anchors capture at the repository ROOT when the caller is in a subdirectory', async () => {
    const repo = await repoWithCommit();
    const nested = join(repo, 'src', 'deep');
    await mkdir(nested, { recursive: true });
    await writeFile(join(repo, 'app.ts'), 'export const a = 4;\n');

    const result = await prepareDiffReview(deps(repo), {
      cwd: nested,
      source: { kind: 'capture', target: 'working' },
    });

    expect(result.ok).toBe(true);
    expectReady(result);
    if (result.ok && result.data.kind === 'ready') {
      // A change OUTSIDE the caller's subdirectory is still part of the review,
      // matching what `git diff` from a subdirectory already reports.
      expect(result.data.diff).toContain('export const a = 4;');
      expect(result.data.capturedFrom).toBe(repo);
      expect(result.data.execution.workingDirectory).toBe(nested);
    }
  });

  it('reports an empty capture instead of inventing a review', async () => {
    const repo = await repoWithCommit();
    const result = await prepareDiffReview(deps(repo), {
      cwd: repo,
      source: { kind: 'capture', target: 'staged' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.kind).toBe('empty-capture');
      if (result.data.kind === 'empty-capture') expect(result.data.capturedFrom).toBe(repo);
    }
  });

  it('captures an unborn repository as index-plus-work-tree', async () => {
    // A brand-new repo has no HEAD to diff against; the change IS everything.
    const repo = await tempDir();
    await initRepo(repo);
    await writeFile(join(repo, 'first.ts'), 'export const first = 1;\n');
    await git(repo, 'add', 'first.ts');

    const result = await prepareDiffReview(deps(repo), {
      cwd: repo,
      source: { kind: 'capture', target: 'working' },
    });

    expect(result.ok).toBe(true);
    expectReady(result);
    if (result.ok && result.data.kind === 'ready') {
      expect(result.data.diff).toContain('export const first = 1;');
    }
  });

  it('refuses to auto-capture outside a work tree', async () => {
    const plain = await tempDir();
    const result = await prepareDiffReview(deps(plain), {
      cwd: plain,
      source: { kind: 'capture', target: 'staged' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^INVALID_INPUT:/);
      expect(result.error).toContain('not inside a git work tree');
    }
  });

  it('follows a symlinked directory to the repository it points at', async () => {
    // Worktrees are routinely reached through a symlink.
    const repo = await repoWithCommit();
    const links = await tempDir();
    const link = join(links, 'link-to-repo');
    await symlink(repo, link);
    await writeFile(join(repo, 'app.ts'), 'export const a = 5;\n');

    const result = await prepareDiffReview(deps(links), {
      cwd: link,
      source: { kind: 'capture', target: 'working' },
    });

    expect(result.ok).toBe(true);
    expectReady(result);
    if (result.ok && result.data.kind === 'ready') expect(result.data.capturedFrom).toBe(repo);
  });
});

describe('prepareDiffReview — explicit diffs', () => {
  const DIFF = 'diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b';

  it('passes the diff through and reports no capture location', async () => {
    const repo = await repoWithCommit();
    const result = await prepareDiffReview(deps(repo), {
      cwd: repo,
      source: { kind: 'explicit', diff: DIFF },
    });
    expect(result.ok).toBe(true);
    expectReady(result);
    if (result.ok && result.data.kind === 'ready') {
      expect(result.data.diff).toBe(DIFF);
      expect(result.data.capturedFrom).toBeUndefined();
    }
  });

  it('reviews an explicit diff from a directory that is not a repository', async () => {
    const plain = await tempDir();
    const result = await prepareDiffReview(deps(plain), {
      cwd: plain,
      source: { kind: 'explicit', diff: DIFF },
    });
    expect(result.ok).toBe(true);
    expectReady(result);
    if (result.ok && result.data.kind === 'ready') {
      expect(result.data.execution.workingDirectory).toBe(plain);
    }
  });
});

describe('repository instruction files', () => {
  async function withInstructions(body: string): Promise<string> {
    const repo = await repoWithCommit();
    await mkdir(join(repo, '.github'), { recursive: true });
    await writeFile(join(repo, '.github', 'copilot-instructions.md'), body);
    await writeFile(join(repo, 'app.ts'), 'export const a = 9;\n');
    return repo;
  }

  it('reads the REQUESTED repository’s instructions, not the default one', async () => {
    const a = await withInstructions('# Repository A rules');
    const b = await withInstructions('# Repository B rules');

    const result = await prepareDiffReview(deps(a, true), {
      cwd: b,
      source: { kind: 'capture', target: 'working' },
    });

    expect(result.ok).toBe(true);
    expectReady(result);
    if (result.ok && result.data.kind === 'ready') {
      expect(result.data.execution.copilotInstructions?.repoWide).toBe('# Repository B rules');
    }
  });

  it('reads instructions from the repository root when the caller is in a subdirectory', async () => {
    const repo = await withInstructions('# Root rules');
    const nested = join(repo, 'src');
    await mkdir(nested, { recursive: true });

    const result = await prepareDiffReview(deps(repo, true), {
      cwd: nested,
      source: { kind: 'capture', target: 'working' },
    });

    expect(result.ok).toBe(true);
    expectReady(result);
    if (result.ok && result.data.kind === 'ready') {
      expect(result.data.execution.copilotInstructions?.repoWide).toBe('# Root rules');
    }
  });

  it('reads nothing when instructions are disabled', async () => {
    const repo = await withInstructions('# Rules');
    const result = await prepareDiffReview(deps(repo, false), {
      cwd: repo,
      source: { kind: 'capture', target: 'working' },
    });
    expect(result.ok).toBe(true);
    expectReady(result);
    if (result.ok && result.data.kind === 'ready') {
      expect(result.data.execution.copilotInstructions).toBeUndefined();
    }
  });

  it('skips the read entirely when no provider call will happen', async () => {
    // An empty capture is answered without a reviewer, so reading (and bounding,
    // and possibly failing on) the instruction tree would be pure waste.
    const repo = await withInstructions('# Rules');
    await git(repo, 'checkout', '-q', '--', 'app.ts');

    const result = await prepareDiffReview(deps(repo, true), {
      cwd: repo,
      source: { kind: 'capture', target: 'staged' },
    });

    expect(result.ok && result.data.kind).toBe('empty-capture');
  });

  it('fails the request when the instruction tree breaks a hard limit', async () => {
    const repo = await withInstructions('x'.repeat(64 * 1024 + 1));
    const result = await prepareDiffReview(deps(repo, true), {
      cwd: repo,
      source: { kind: 'capture', target: 'working' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^INVALID_INPUT:/);
  });

  it('warns and continues when instructions cannot be read for an ordinary reason', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const repo = await repoWithCommit();
    // A .github that is a FILE makes the repo-wide path unreadable as a file
    // without being a limit violation.
    await writeFile(join(repo, '.github'), 'not a directory');
    await writeFile(join(repo, 'app.ts'), 'export const a = 10;\n');

    const result = await prepareDiffReview(deps(repo, true), {
      cwd: repo,
      source: { kind: 'capture', target: 'working' },
    });

    expect(result.ok).toBe(true);
    expectReady(result);
    if (result.ok && result.data.kind === 'ready') {
      expect(result.data.execution.copilotInstructions?.repoWide ?? null).toBeNull();
    }
    warn.mockRestore();
  });
});

describe('bounded preparation', () => {
  it('refuses excess concurrent preparations with REVIEW_BUSY', async () => {
    const repo = await repoWithCommit();
    const shared = deps(repo);
    // Saturate the limiter with work that cannot finish yet.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const held = Array.from({ length: 4 }, () =>
      shared.limiter.run(async () => {
        await gate;
        return { ok: true as const, data: null };
      }),
    );

    const refused = await preparePlanReview(shared, { cwd: repo });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/^REVIEW_BUSY:/);

    release();
    await Promise.all(held);
    expect((await preparePlanReview(shared, { cwd: repo })).ok).toBe(true);
  });

  it('takes no permit for a request rejected on its arguments alone', async () => {
    const repo = await repoWithCommit();
    const shared = deps(repo);
    const runSpy = vi.spyOn(shared.limiter, 'run');

    const result = await preparePlanReview(shared, { cwd: 'relative' });

    expect(result.ok).toBe(false);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('releases the permit before the caller runs the review', async () => {
    const repo = await repoWithCommit();
    const shared = deps(repo);
    await preparePlanReview(shared, { cwd: repo });
    expect(shared.limiter.activeCount()).toBe(0);
  });

  it('releases the permit after a failed preparation', async () => {
    const repo = await repoWithCommit();
    const shared = deps(repo);
    await preparePlanReview(shared, { cwd: join(repo, 'missing') });
    expect(shared.limiter.activeCount()).toBe(0);
  });

  it('releases the permit after an empty-capture short circuit', async () => {
    const repo = await repoWithCommit();
    const shared = deps(repo);
    await prepareDiffReview(shared, {
      cwd: repo,
      source: { kind: 'capture', target: 'staged' },
    });
    expect(shared.limiter.activeCount()).toBe(0);
  });

  // Preparation is written not to throw, but it drives the filesystem and git
  // against a caller-named directory. If one ever does throw, the MCP server
  // must still answer with a Result rather than surface a raw exception.
  it('converts an unexpected throw into a Result instead of propagating it', async () => {
    const repo = await repoWithCommit();
    const shared = deps(repo);
    vi.spyOn(shared.limiter, 'run').mockRejectedValueOnce(new Error('boom'));

    const result = await preparePlanReview(shared, { cwd: repo });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^UNKNOWN_ERROR:/);
      expect(result.error).toContain('boom');
    }
  });

  it('escapes terminal controls in an unexpected preparation failure', async () => {
    const repo = await repoWithCommit();
    const shared = deps(repo);
    const esc = String.fromCharCode(27);
    vi.spyOn(shared.limiter, 'run').mockRejectedValueOnce(new Error(`${esc}[31mboom`));

    const result = await preparePlanReview(shared, { cwd: repo });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('\\x1B');
      expect(result.error).not.toContain(esc);
    }
  });
});

// A LINKED worktree is the case ISS-027 was reported from: `.git` is a file
// pointing at the main repository, the checked-out files live somewhere else
// entirely, and a server started in the main repo would review the wrong tree.
// Nothing here is mocked — this runs real `git worktree`.
const gitAvailable = await (async () => {
  try {
    await run('git', ['--version'], { env: subprocessEnv() });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!gitAvailable)('real linked git worktrees', () => {
  async function withWorktree(): Promise<{ main: string; linked: string }> {
    const root = await tempDir('rb-wt-');
    const main = join(root, 'main');
    const linked = join(root, 'linked');
    await mkdir(main, { recursive: true });
    await initRepo(main);
    await commitFile(main, 'app.ts', 'export const a = 1;\n');
    await git(main, 'worktree', 'add', '-q', linked, '-b', 'feature');
    return { main, linked };
  }

  it("captures the WORKTREE's changes and names the worktree as the source", async () => {
    const { main, linked } = await withWorktree();
    await writeFile(join(linked, 'app.ts'), 'export const a = 2; // worktree\n');
    await writeFile(join(main, 'app.ts'), 'export const a = 99; // main\n');

    // The server was started in the MAIN repository.
    const result = await prepareDiffReview(deps(main), {
      cwd: linked,
      source: { kind: 'capture', target: 'working' },
    });

    expect(result.ok).toBe(true);
    expectReady(result);
    if (result.ok && result.data.kind === 'ready') {
      expect(result.data.diff).toContain('// worktree');
      expect(result.data.diff).not.toContain('// main');
      expect(result.data.capturedFrom).toBe(linked);
      expect(result.data.execution.workingDirectory).toBe(linked);
    }
  });

  it('captures staged changes made inside the worktree', async () => {
    const { main, linked } = await withWorktree();
    await writeFile(join(linked, 'app.ts'), 'export const a = 3; // staged\n');
    await git(linked, 'add', 'app.ts');

    const result = await prepareDiffReview(deps(main), {
      cwd: linked,
      source: { kind: 'capture', target: 'staged' },
    });

    expect(result.ok).toBe(true);
    expectReady(result);
    if (result.ok && result.data.kind === 'ready') {
      expect(result.data.diff).toContain('// staged');
      expect(result.data.capturedFrom).toBe(linked);
    }
  });

  it("reads the worktree's own instruction files, not the main repository's", async () => {
    const { main, linked } = await withWorktree();
    await mkdir(join(main, '.github'), { recursive: true });
    await writeFile(join(main, '.github', 'copilot-instructions.md'), '# Main rules');
    await mkdir(join(linked, '.github'), { recursive: true });
    await writeFile(join(linked, '.github', 'copilot-instructions.md'), '# Worktree rules');
    await writeFile(join(linked, 'app.ts'), 'export const a = 4;\n');

    const result = await prepareDiffReview(deps(main, true), {
      cwd: linked,
      source: { kind: 'capture', target: 'working' },
    });

    expect(result.ok).toBe(true);
    expectReady(result);
    if (result.ok && result.data.kind === 'ready') {
      expect(result.data.execution.copilotInstructions?.repoWide).toBe('# Worktree rules');
    }
  });

  it('anchors a worktree SUBDIRECTORY at the worktree root', async () => {
    const { main, linked } = await withWorktree();
    const nested = join(linked, 'src', 'inner');
    await mkdir(nested, { recursive: true });
    await writeFile(join(linked, 'app.ts'), 'export const a = 5;\n');

    const result = await prepareDiffReview(deps(main), {
      cwd: nested,
      source: { kind: 'capture', target: 'working' },
    });

    expect(result.ok).toBe(true);
    expectReady(result);
    if (result.ok && result.data.kind === 'ready') {
      expect(result.data.capturedFrom).toBe(linked);
      expect(result.data.execution.workingDirectory).toBe(nested);
    }
  });
});
