import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getStagedDiff,
  getUnstagedDiff,
  getDiffBetween,
  getWorkingDiff,
  isGitRepo,
} from './git.js';

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

// getStagedDiff/getWorkingDiff now preflight with `git rev-parse
// --is-inside-work-tree` before their real command. `first` scripts that
// preflight call (defaults to a passing 'true\n'); `rest` scripts every call
// after it in order, repeating the last entry once exhausted.
function mockSequence(
  first: { stdout?: string; stderr?: string } | 'preflight-ok',
  ...rest: { stdout?: string; stderr?: string }[]
) {
  const preflight = first === 'preflight-ok' ? { stdout: 'true\n' } : first;
  const calls = [preflight, ...rest];
  let callCount = 0;
  mockExec.mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((cmd: string, opts: any, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      const entry = calls[Math.min(callCount, calls.length - 1)];
      callCount++;
      if (entry.stderr !== undefined) {
        cb(
          Object.assign(new Error(entry.stderr), { stderr: entry.stderr }),
          entry.stdout ?? '',
          entry.stderr,
        );
      } else {
        cb(null, entry.stdout ?? '', '');
      }
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
    mockSequence('preflight-ok', { stdout: sampleDiff + '\n' });
    const result = await getStagedDiff();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(sampleDiff);
    }
  });

  it('returns ok with empty string when no staged changes', async () => {
    mockSequence('preflight-ok', { stdout: '' });
    const result = await getStagedDiff();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe('');
    }
  });

  it('returns the friendly not-a-repo error when the preflight check fails outright', async () => {
    mockFailure('fatal: not a git repository');
    const result = await getStagedDiff();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('GIT_ERROR');
      expect(result.error).toContain('is not inside a git repository');
      expect(result.error).toContain('cwd');
      expect(result.error).not.toContain('fatal: not a git repository');
    }
  });

  it('returns the friendly not-a-repo error when the preflight reports false (e.g. a bare repo)', async () => {
    mockSuccess('false\n');
    const result = await getStagedDiff();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('is not inside a git repository');
    }
  });

  it('F1: a real, non-repo preflight failure (dubious ownership) surfaces its own text — NOT the misleading not-a-repo message', async () => {
    // A well-known real git message (safe.directory ownership check, git
    // 2.35.2+): the directory genuinely IS a repo, but git refuses to
    // operate in it. Rewriting this to "not inside a git repository" would
    // send someone chasing the wrong fix (passing cwd/diff instead of
    // running the git config command git itself is telling them to run).
    const dubiousOwnership =
      "fatal: detected dubious ownership in repository at '/my/repo'\n" +
      'To add an exception for this directory, call:\n\n' +
      '\tgit config --global --add safe.directory /my/repo';
    mockFailure(dubiousOwnership);

    const result = await getStagedDiff('/my/repo');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('GIT_ERROR');
      expect(result.error).toContain('dubious ownership');
      expect(result.error).toContain('safe.directory');
      expect(result.error).not.toContain('is not inside a git repository');
    }
  });

  it('F1: a preflight failure from a missing git binary / other real error also surfaces its own text', async () => {
    mockFailure('spawn git ENOENT');

    const result = await getStagedDiff();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('GIT_ERROR');
      expect(result.error).toContain('ENOENT');
      expect(result.error).not.toContain('is not inside a git repository');
    }
  });

  it('P1: a real error whose PATH literally contains the phrase "not a git repository" is NOT misclassified (anchored match, not a bare substring test)', async () => {
    // The exact adversarial case: a dubious-ownership error naming a
    // directory that happens to be called "not a git repository". An
    // unanchored /not a git repository/i test would match this anywhere in
    // the string and wrongly rewrite it to the friendly not-a-repo message —
    // actively wrong advice, since the real fix is `git config --global
    // --add safe.directory`, not the cwd param.
    const trickyPath = '/tmp/not a git repository/repo';
    const dubiousOwnershipWithTrickyPath =
      `fatal: detected dubious ownership in repository at '${trickyPath}'\n` +
      'To add an exception for this directory, call:\n\n' +
      `\tgit config --global --add safe.directory '${trickyPath}'`;
    mockFailure(dubiousOwnershipWithTrickyPath);

    const result = await getStagedDiff(trickyPath);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('GIT_ERROR');
      expect(result.error).toContain('dubious ownership');
      expect(result.error).toContain('safe.directory');
      expect(result.error).not.toContain('is not inside a git repository');
    }
  });

  it('P1: the anchored pattern still matches the real "not a git repository" fatal line, verified live against git 2.39.5', async () => {
    // Both git rev-parse --is-inside-work-tree and --verify HEAD print
    // exactly this outside a work tree (re-confirmed live for this fix).
    mockFailure('fatal: not a git repository (or any of the parent directories): .git');

    const result = await getStagedDiff();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('is not inside a git repository');
    }
  });

  it('names the resolved cwd in the not-a-repo message, falling back to process.cwd() when omitted', async () => {
    mockFailure('fatal: not a git repository');
    const result = await getStagedDiff();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(process.cwd());
    }
  });

  it('names an explicit cwd in the not-a-repo message instead of process.cwd()', async () => {
    mockFailure('fatal: not a git repository');
    const result = await getStagedDiff('/some/other/repo');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('/some/other/repo');
    }
  });

  it('returns err containing stderr message when the diff command fails for an unrelated reason (preflight passed)', async () => {
    mockSequence('preflight-ok', { stderr: 'error: pathspec not found' });
    const result = await getStagedDiff();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('GIT_ERROR');
      expect(result.error).toContain('error: pathspec not found');
    }
  });

  it('rewrites the real --no-index "unknown option" failure to the friendly message even if the preflight passed', async () => {
    // Verified live against git 2.39.5 (Apple Git-154): `git diff --cached`
    // outside a work tree fails with exactly this shape — backtick-quoted
    // flag name, followed by the --no-index usage block.
    mockSequence('preflight-ok', {
      stderr:
        "error: unknown option `cached'\nusage: git diff --no-index [<options>] <path> <path>",
    });
    const result = await getStagedDiff();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('is not inside a git repository');
    }
  });

  it('does NOT rewrite an "unknown option" failure that does not name cached (F2: narrowed, not a generic match)', async () => {
    mockSequence('preflight-ok', { stderr: "error: unknown option `bogus-flag'" });
    const result = await getStagedDiff();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('GIT_ERROR');
      expect(result.error).toContain('bogus-flag');
      expect(result.error).not.toContain('is not inside a git repository');
    }
  });

  it('does NOT rewrite "unknown option ... cached" without --no-index context (F2: requires both signals)', async () => {
    mockSequence('preflight-ok', {
      stderr: "error: unknown option `cached' in some unrelated context",
    });
    const result = await getStagedDiff();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('GIT_ERROR');
      expect(result.error).not.toContain('is not inside a git repository');
    }
  });

  it('passes cwd through to the underlying git commands', async () => {
    mockSequence('preflight-ok', { stdout: '' });
    await getStagedDiff('/my/repo');
    expect(mockExec).toHaveBeenCalledTimes(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockExec.mock.calls[0][1] as any).cwd).toBe('/my/repo');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockExec.mock.calls[1][1] as any).cwd).toBe('/my/repo');
  });

  it('omits cwd from exec options when not provided (preserves prior default behavior)', async () => {
    mockSequence('preflight-ok', { stdout: '' });
    await getStagedDiff();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockExec.mock.calls[0][1] as any).cwd).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockExec.mock.calls[1][1] as any).cwd).toBeUndefined();
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

  it('passes cwd through to the underlying git command', async () => {
    mockSuccess('true\n');
    await isGitRepo('/my/repo');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockExec.mock.calls[0][1] as any).cwd).toBe('/my/repo');
  });
});

describe('getWorkingDiff', () => {
  it('returns diff vs HEAD when HEAD exists', async () => {
    // Call 1: preflight (is-inside-work-tree). Call 2: rev-parse --verify HEAD.
    // Call 3: git diff HEAD.
    mockSequence('preflight-ok', { stdout: 'abc123\n' }, { stdout: sampleDiff + '\n' });

    const result = await getWorkingDiff();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(sampleDiff);
    }
  });

  it('returns empty string when HEAD exists but no changes', async () => {
    mockSequence('preflight-ok', { stdout: 'abc123\n' }, { stdout: '' });

    const result = await getWorkingDiff();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe('');
    }
  });

  it('falls back to staged + unstaged when HEAD does not exist', async () => {
    let callCount = 0;
    mockExec.mockImplementation(((
      cmd: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      opts: any,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callCount++;
      if (callCount === 1) {
        cb(null, 'true\n', ''); // preflight: inside a work tree
      } else if (callCount === 2) {
        // rev-parse --verify HEAD fails on unborn repo
        cb(
          Object.assign(new Error('HEAD'), { stderr: 'fatal: Needed a single revision\nHEAD' }),
          '',
          'fatal: Needed a single revision\nHEAD',
        );
      } else if (callCount === 3) {
        cb(null, sampleDiff + '\n', ''); // staged
      } else {
        cb(null, '', ''); // unstaged (empty)
      }
    }) as typeof exec);

    const result = await getWorkingDiff();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(sampleDiff);
    }
  });

  it('F2: the --cached no-index rewrite is scoped to the actual --cached call — a same-shaped failure on the unstaged half of the HEAD-less fallback is NOT rewritten', async () => {
    // Preflight ok, HEAD missing (unborn repo) → falls back to staged +
    // unstaged. The STAGED call succeeds; the UNSTAGED call (git diff
    // --no-color, no --cached) fails with a contrived message that would
    // match looksLikeCachedNoIndexFallback's pattern IF it weren't call-site
    // gated. It must surface as-is, not be rewritten — that call never ran
    // --cached, so the rewrite doesn't apply to it.
    let callCount = 0;
    mockExec.mockImplementation(((
      cmd: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      opts: any,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callCount++;
      if (callCount === 1) {
        cb(null, 'true\n', ''); // preflight
      } else if (callCount === 2) {
        cb(
          Object.assign(new Error('HEAD'), { stderr: 'fatal: Needed a single revision\nHEAD' }),
          '',
          'fatal: Needed a single revision\nHEAD',
        );
      } else if (callCount === 3) {
        cb(null, sampleDiff + '\n', ''); // staged — succeeds
      } else {
        // unstaged — fails with a contrived cached/no-index-shaped message
        cb(
          Object.assign(new Error('contrived'), {
            stderr:
              "error: unknown option `cached'\nusage: git diff --no-index [<options>] <path> <path>",
          }),
          '',
          "error: unknown option `cached'\nusage: git diff --no-index [<options>] <path> <path>",
        );
      }
    }) as typeof exec);

    const result = await getWorkingDiff();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('GIT_ERROR');
      expect(result.error).not.toContain('is not inside a git repository');
    }
  });

  it('returns the friendly not-a-repo error when the preflight check fails', async () => {
    mockFailure('fatal: not a git repository');
    const result = await getWorkingDiff();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('GIT_ERROR');
      expect(result.error).toContain('is not inside a git repository');
      expect(result.error).not.toContain('fatal: not a git repository');
    }
  });

  it('F1: a real, non-repo preflight failure (dubious ownership) surfaces its own text here too — shares checkWorkTreeForCapture with getStagedDiff', async () => {
    const dubiousOwnership =
      "fatal: detected dubious ownership in repository at '/my/repo'\n" +
      'To add an exception for this directory, call:\n\n' +
      '\tgit config --global --add safe.directory /my/repo';
    mockFailure(dubiousOwnership);

    const result = await getWorkingDiff('/my/repo');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('dubious ownership');
      expect(result.error).not.toContain('is not inside a git repository');
    }
  });

  it('passes cwd through to every underlying git command', async () => {
    mockSequence('preflight-ok', { stdout: 'abc123\n' }, { stdout: '' });
    await getWorkingDiff('/my/repo');
    expect(mockExec).toHaveBeenCalledTimes(3);
    for (const call of mockExec.mock.calls) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((call[1] as any).cwd).toBe('/my/repo');
    }
  });
});

describe('command verification', () => {
  it('getStagedDiff runs git diff --cached --no-color (after the preflight)', async () => {
    mockSequence('preflight-ok', { stdout: '' });
    await getStagedDiff();
    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec.mock.calls[0][0]).toBe('git rev-parse --is-inside-work-tree');
    expect(mockExec.mock.calls[1][0]).toBe('git diff --cached --no-color');
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
