import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getStagedDiff, getUnstagedDiff, getDiffBetween, getWorkingDiff, isGitRepo } from './git.js';

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
    mockSuccess(sampleDiff + '\n');
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
    // --verbose passes the regex (all chars valid) but starts with -
    const result = await getDiffBetween('--verbose', 'HEAD');
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

describe('getWorkingDiff', () => {
  it('returns diff vs HEAD when HEAD exists', async () => {
    // First call: rev-parse --verify HEAD succeeds
    // Second call: git diff HEAD returns diff
    let callCount = 0;
    mockExec.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((cmd: string, opts: any, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        callCount++;
        if (callCount === 1) {
          cb(null, 'abc123\n', ''); // HEAD exists
        } else {
          cb(null, sampleDiff + '\n', '');
        }
      }) as typeof exec,
    );

    const result = await getWorkingDiff();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(sampleDiff);
    }
  });

  it('returns empty string when HEAD exists but no changes', async () => {
    let callCount = 0;
    mockExec.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((cmd: string, opts: any, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        callCount++;
        if (callCount === 1) {
          cb(null, 'abc123\n', '');
        } else {
          cb(null, '', '');
        }
      }) as typeof exec,
    );

    const result = await getWorkingDiff();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe('');
    }
  });

  it('falls back to staged + unstaged when HEAD does not exist', async () => {
    let callCount = 0;
    mockExec.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((cmd: string, opts: any, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        callCount++;
        if (callCount === 1) {
          // rev-parse --verify HEAD fails on unborn repo
          cb(Object.assign(new Error('HEAD'), { stderr: "fatal: Needed a single revision\nHEAD" }), '', "fatal: Needed a single revision\nHEAD");
        } else if (callCount === 2) {
          cb(null, sampleDiff + '\n', ''); // staged
        } else {
          cb(null, '', ''); // unstaged (empty)
        }
      }) as typeof exec,
    );

    const result = await getWorkingDiff();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(sampleDiff);
    }
  });

  it('returns GIT_ERROR when not in a git repo', async () => {
    mockFailure('fatal: not a git repository');
    const result = await getWorkingDiff();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('GIT_ERROR');
    }
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

// ISS-028: the directory a capture reports must be the directory git actually
// ran in, so every child command of a capture — including the HEAD probe and the
// unborn-HEAD fallback — has to receive the same cwd.
describe('cwd forwarding', () => {
  function cwdOf(callIndex: number): string | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (mockExec.mock.calls[callIndex][1] as any).cwd;
  }

  it('runs the staged capture in the supplied directory', async () => {
    mockSuccess('');
    await getStagedDiff('/work/repo-b');
    expect(cwdOf(0)).toBe('/work/repo-b');
  });

  it('runs the unstaged capture in the supplied directory', async () => {
    mockSuccess('');
    await getUnstagedDiff('/work/repo-b');
    expect(cwdOf(0)).toBe('/work/repo-b');
  });

  it('runs a ref-to-ref diff in the supplied directory', async () => {
    mockSuccess('');
    await getDiffBetween('main', 'HEAD', '/work/repo-b');
    expect(cwdOf(0)).toBe('/work/repo-b');
  });

  it('runs the work-tree probe in the supplied directory', async () => {
    mockSuccess('true');
    await isGitRepo('/work/repo-b');
    expect(cwdOf(0)).toBe('/work/repo-b');
  });

  it('runs BOTH the HEAD probe and the working diff in the supplied directory', async () => {
    mockSuccess('');
    await getWorkingDiff('/work/repo-b');
    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(cwdOf(0)).toBe('/work/repo-b');
    expect(cwdOf(1)).toBe('/work/repo-b');
  });

  it('runs the unborn-HEAD fallback commands in the supplied directory', async () => {
    // First call (the HEAD probe) fails the way an unborn repo does; the two
    // fallback captures must not silently drift back to the process cwd.
    let call = 0;
    mockExec.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((cmd: string, opts: any, cb: (e: Error | null, out: string, errOut: string) => void) => {
        if (call++ === 0) {
          const stderr = "fatal: Needed a single revision: HEAD";
          cb(Object.assign(new Error(stderr), { stderr }), '', stderr);
          return;
        }
        cb(null, '', '');
      }) as typeof exec,
    );

    const result = await getWorkingDiff('/work/repo-b');

    expect(result.ok).toBe(true);
    expect(mockExec).toHaveBeenCalledTimes(3);
    expect(cwdOf(1)).toBe('/work/repo-b');
    expect(cwdOf(2)).toBe('/work/repo-b');
  });

  it('leaves cwd undefined when none is supplied (inherits the process cwd)', async () => {
    mockSuccess('');
    await getStagedDiff();
    expect(cwdOf(0)).toBeUndefined();
  });
});
