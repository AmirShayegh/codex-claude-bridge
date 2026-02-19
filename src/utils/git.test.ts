import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getStagedDiff, getUnstagedDiff, getDiffBetween, isGitRepo } from './git.js';

vi.mock('node:child_process', () => ({ exec: vi.fn() }));

import { exec } from 'node:child_process';

const mockExec = vi.mocked(exec);

function mockSuccess(stdout: string) {
  mockExec.mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((cmd: string, opts: any, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, stdout, '');
    }) as typeof exec,
  );
}

function mockFailure(stderr: string) {
  mockExec.mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((cmd: string, opts: any, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(Object.assign(new Error(stderr), { stderr }), '', stderr);
    }) as typeof exec,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

const sampleDiff = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,5 @@
+import { foo } from "./foo";
 export default app;`;

describe('getStagedDiff', () => {
  it('returns ok with diff string when changes are staged', async () => {
    mockSuccess(sampleDiff);
    const result = await getStagedDiff();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(sampleDiff);
    }
  });

  it('returns ok with empty string when no staged changes', async () => {
    mockSuccess('');
    const result = await getStagedDiff();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe('');
    }
  });

  it('returns err with GIT_ERROR when not a git repo', async () => {
    mockFailure('fatal: not a git repository');
    const result = await getStagedDiff();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('GIT_ERROR');
      expect(result.error).toContain('fatal: not a git repository');
    }
  });

  it('returns err containing stderr message when git command fails', async () => {
    mockFailure('error: pathspec not found');
    const result = await getStagedDiff();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('GIT_ERROR');
      expect(result.error).toContain('error: pathspec not found');
    }
  });
});

describe('getUnstagedDiff', () => {
  it('returns ok with diff string', async () => {
    mockSuccess(sampleDiff);
    const result = await getUnstagedDiff();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(sampleDiff);
    }
  });

  it('returns ok with empty string when no unstaged changes', async () => {
    mockSuccess('');
    const result = await getUnstagedDiff();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe('');
    }
  });
});

describe('getDiffBetween', () => {
  it('returns ok with diff between two refs', async () => {
    mockSuccess(sampleDiff);
    const result = await getDiffBetween('main', 'feature/login');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(sampleDiff);
    }
  });

  it('returns err with GIT_ERROR when command fails', async () => {
    mockFailure('fatal: bad revision');
    const result = await getDiffBetween('main', 'nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('GIT_ERROR');
      expect(result.error).toContain('fatal: bad revision');
    }
  });

  it('returns err for refs starting with - (argument injection guard)', async () => {
    const result = await getDiffBetween('--output=/tmp/evil', 'HEAD');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('GIT_ERROR');
      expect(result.error).toContain('invalid git ref');
    }
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('returns err for refs containing shell metacharacters', async () => {
    const result = await getDiffBetween('main; rm -rf /', 'HEAD');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('GIT_ERROR');
      expect(result.error).toContain('invalid git ref');
    }
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe('isGitRepo', () => {
  it('returns true inside a git repo', async () => {
    mockSuccess('true\n');
    const result = await isGitRepo();
    expect(result).toBe(true);
  });

  it('returns false outside a git repo', async () => {
    mockFailure('fatal: not a git repository');
    const result = await isGitRepo();
    expect(result).toBe(false);
  });

  it('returns false in a bare repo (stdout is "false")', async () => {
    mockSuccess('false\n');
    const result = await isGitRepo();
    expect(result).toBe(false);
  });
});

describe('command verification', () => {
  it('getStagedDiff runs git diff --cached --no-color', async () => {
    mockSuccess('');
    await getStagedDiff();
    expect(mockExec).toHaveBeenCalledTimes(1);
    const cmd = mockExec.mock.calls[0][0];
    expect(cmd).toBe('git diff --cached --no-color');
  });

  it('getUnstagedDiff runs git diff --no-color', async () => {
    mockSuccess('');
    await getUnstagedDiff();
    expect(mockExec).toHaveBeenCalledTimes(1);
    const cmd = mockExec.mock.calls[0][0];
    expect(cmd).toBe('git diff --no-color');
  });

  it('getDiffBetween runs git diff --no-color base head', async () => {
    mockSuccess('');
    await getDiffBetween('main', 'HEAD');
    expect(mockExec).toHaveBeenCalledTimes(1);
    const cmd = mockExec.mock.calls[0][0];
    expect(cmd).toBe('git diff --no-color main HEAD');
  });
});
