import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_WORKSPACE_PATH_LENGTH,
  instructionsRootFor,
  resolveWorkspace,
  validateWorkspacePath,
} from './workspace.js';
import { ok, err } from './errors.js';

vi.mock('./git.js', () => ({ getRepositoryRoot: vi.fn() }));

import { getRepositoryRoot } from './git.js';

const mockGetRepositoryRoot = vi.mocked(getRepositoryRoot);

// Real directories: path canonicalization is exactly the behavior under test,
// so faking the filesystem here would test the fake.
const created: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rb-workspace-'));
  created.push(dir);
  // macOS puts temp dirs under /var, a symlink to /private/var. realpath is
  // what makes the resolved value comparable to git's own output.
  return realpath(dir);
}

afterAll(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRepositoryRoot.mockResolvedValue(ok(null));
});

describe('validateWorkspacePath', () => {
  it('accepts an absolute path', () => {
    expect(validateWorkspacePath('/work/repo-b')).toEqual({ ok: true, data: '/work/repo-b' });
  });

  it('accepts paths containing spaces and shell metacharacters', () => {
    // No shell is ever involved, so these are ordinary directory names.
    for (const path of ['/work/my repo', '/work/repo;rm -rf', '/work/repo$(whoami)', '/work/a&b']) {
      expect(validateWorkspacePath(path).ok).toBe(true);
    }
  });

  it('rejects an empty path', () => {
    const result = validateWorkspacePath('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('must not be empty');
  });

  it('rejects a relative path', () => {
    const result = validateWorkspacePath('relative/dir');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('must be an absolute path');
  });

  it('rejects a "~" path instead of expanding it', () => {
    // Expanding would resolve against the SERVER's home directory — the exact
    // class of silent wrong-directory bug this feature exists to remove.
    const result = validateWorkspacePath('~/projects/app');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('must not start with "~"');
      expect(result.error).toContain('not expanded');
    }
  });

  it('rejects control characters', () => {
    const result = validateWorkspacePath('/work/repo');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('control characters');
  });

  it('rejects a path longer than the bound', () => {
    const result = validateWorkspacePath('/' + 'a'.repeat(MAX_WORKSPACE_PATH_LENGTH));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('at most 4096 characters');
  });

  it('accepts a path exactly at the bound', () => {
    expect(validateWorkspacePath('/' + 'a'.repeat(MAX_WORKSPACE_PATH_LENGTH - 1)).ok).toBe(true);
  });

  it('never echoes the rejected path back', () => {
    // A rejection message is rendered somewhere; a caller-controlled path in it
    // is both an injection surface and a filesystem-probe oracle.
    const result = validateWorkspacePath('~/secret-project-name');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain('secret-project-name');
  });
});

describe('resolveWorkspace', () => {
  it('canonicalizes an existing directory', async () => {
    const dir = await tempDir();
    const result = await resolveWorkspace(dir);
    expect(result).toEqual({ ok: true, data: { workingDirectory: dir, repositoryRoot: null } });
  });

  it('follows a symlink to its canonical target', async () => {
    // Worktrees under .claude/worktrees/ are routinely reached via a symlink;
    // rejecting them would reject the case this feature is for.
    const dir = await tempDir();
    const target = join(dir, 'real');
    const link = join(dir, 'link');
    await mkdir(target);
    await symlink(target, link);

    const result = await resolveWorkspace(link);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.workingDirectory).toBe(target);
  });

  it('resolves a nested subdirectory to itself', async () => {
    const dir = await tempDir();
    const nested = join(dir, 'a', 'b', 'c');
    await mkdir(nested, { recursive: true });
    const result = await resolveWorkspace(nested);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.workingDirectory).toBe(nested);
  });

  it('accepts a directory whose name contains spaces', async () => {
    const dir = await tempDir();
    const spaced = join(dir, 'my project dir');
    await mkdir(spaced);
    const result = await resolveWorkspace(spaced);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.workingDirectory).toBe(spaced);
  });

  it('rejects a path that does not exist', async () => {
    const dir = await tempDir();
    const result = await resolveWorkspace(join(dir, 'missing'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('existing, readable directory');
  });

  it('rejects a broken symlink', async () => {
    const dir = await tempDir();
    const link = join(dir, 'dangling');
    await symlink(join(dir, 'nowhere'), link);
    const result = await resolveWorkspace(link);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^INVALID_INPUT:/);
  });

  it('rejects a path that names a file', async () => {
    const dir = await tempDir();
    const file = join(dir, 'notes.txt');
    await writeFile(file, 'hi');
    const result = await resolveWorkspace(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('existing, readable directory');
  });

  it('rejects a relative path without touching the filesystem', async () => {
    const result = await resolveWorkspace('relative');
    expect(result.ok).toBe(false);
    expect(mockGetRepositoryRoot).not.toHaveBeenCalled();
  });

  it('gives every filesystem rejection the SAME sanitized message', async () => {
    // Different messages per failure would let a caller probe the server's
    // filesystem by watching which one comes back.
    const dir = await tempDir();
    const file = join(dir, 'f');
    await writeFile(file, 'x');
    const missing = await resolveWorkspace(join(dir, 'nope'));
    const isFile = await resolveWorkspace(file);
    expect(missing.ok).toBe(false);
    expect(isFile.ok).toBe(false);
    if (!missing.ok && !isFile.ok) expect(missing.error).toBe(isFile.error);
  });

  it('never echoes the caller path in a filesystem rejection', async () => {
    const dir = await tempDir();
    const result = await resolveWorkspace(join(dir, 'secret-name-xyz'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain('secret-name-xyz');
  });

  it('reports the repository root when the directory is inside a work tree', async () => {
    const dir = await tempDir();
    mockGetRepositoryRoot.mockResolvedValue(ok('/work/repo-b'));
    const result = await resolveWorkspace(dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.repositoryRoot).toBe('/work/repo-b');
    expect(mockGetRepositoryRoot).toHaveBeenCalledWith(dir);
  });

  it('accepts a directory that is not a repository at all', async () => {
    // review_plan needs no repository, and an explicit diff can be reviewed
    // from anywhere — only auto-capture requires a work tree.
    const dir = await tempDir();
    mockGetRepositoryRoot.mockResolvedValue(ok(null));
    const result = await resolveWorkspace(dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.repositoryRoot).toBeNull();
  });

  // "Not a repository" and "git failed" are different answers. A failure means
  // we cannot know which repository this directory belongs to — and so cannot
  // know which instruction files apply — so it must not be flattened to null.
  it('propagates a real git discovery failure instead of pretending there is no repo', async () => {
    const dir = await tempDir();
    mockGetRepositoryRoot.mockResolvedValue(err('GIT_ERROR: fatal: detected dubious ownership'));

    const result = await resolveWorkspace(dir);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^GIT_ERROR:.*dubious ownership/);
  });
});

describe('instructionsRootFor', () => {
  it('prefers the repository root so a subdirectory still means the whole repo', () => {
    expect(
      instructionsRootFor({
        workingDirectory: '/work/repo-b/src/nested',
        repositoryRoot: '/work/repo-b',
      }),
    ).toBe('/work/repo-b');
  });

  it('falls back to the working directory outside a repository', () => {
    expect(instructionsRootFor({ workingDirectory: '/tmp/plain', repositoryRoot: null })).toBe(
      '/tmp/plain',
    );
  });
});
