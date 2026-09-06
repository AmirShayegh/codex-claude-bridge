import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyHead,
  getStagedDiff,
  getUnstagedDiff,
  getDiffBetween,
  getWorkingDiff,
  getRepositoryRoot,
  isGitRepo,
} from './git.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'node:child_process';
import { subprocessEnv, isStrippedGitVariable } from './subprocess-env.js';

const mockExecFile = vi.mocked(execFile);

const CWD = '/work/repo-b';

// One programmed git invocation. Exit codes are ANSWERS here (the HEAD probes
// read them), so a non-zero exit is modelled separately from a failure to run.
type Reply =
  | { exit: number; stdout?: string; stderr?: string }
  | { spawnError: string; code: string }
  | { killed: true; signal: string; code?: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExecFileCallback = (error: any, stdout: string, stderr: string) => void;

function program(...replies: Reply[]): void {
  let index = 0;
  mockExecFile.mockImplementation(((
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: ExecFileCallback,
  ) => {
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if ('spawnError' in reply) {
      cb(Object.assign(new Error(reply.spawnError), { code: reply.code }), '', '');
      return;
    }
    if ('killed' in reply) {
      cb(
        Object.assign(new Error('killed'), {
          killed: true,
          signal: reply.signal,
          code: reply.code,
        }),
        '',
        '',
      );
      return;
    }
    const stdout = reply.stdout ?? '';
    const stderr = reply.stderr ?? '';
    if (reply.exit === 0) {
      cb(null, stdout, stderr);
      return;
    }
    cb(Object.assign(new Error(stderr || 'git failed'), { code: reply.exit }), stdout, stderr);
  }) as unknown as typeof execFile);
}

function argvOf(call: number): string[] {
  return mockExecFile.mock.calls[call][1] as string[];
}

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  maxBuffer?: number;
  timeout?: number;
}

function optsOf(call: number): RunOptions {
  return mockExecFile.mock.calls[call][2] as RunOptions;
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

// Git-level options must sit between `git` and the subcommand; diff-level
// options after it. Verified against real git 2.50.1.
const GIT_LEVEL = [
  '--no-pager',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
  '-c',
  'diff.srcPrefix=a/',
  '-c',
  'diff.dstPrefix=b/',
];
const DIFF_LEVEL = ['--no-color', '--no-ext-diff', '--no-textconv'];

describe('invocation shape', () => {
  it('never builds a command string — git is always spawned with an argv array', async () => {
    program({ exit: 0, stdout: '' });
    await getStagedDiff(CWD);
    expect(mockExecFile.mock.calls[0][0]).toBe('git');
    expect(Array.isArray(argvOf(0))).toBe(true);
  });

  it('runs in the supplied directory with a sanitized environment', async () => {
    program({ exit: 0, stdout: '' });
    await getStagedDiff(CWD);
    const opts = optsOf(0);
    expect(opts.cwd).toBe(CWD);
    // A GIT_DIR or GIT_WORK_TREE inherited from the launching shell would
    // override the cwd we just resolved and capture the wrong repository.
    expect(opts.env).toBeDefined();
    expect(Object.keys(opts.env ?? {})).not.toContain('GIT_DIR');
    expect(Object.keys(opts.env ?? {})).not.toContain('GIT_WORK_TREE');
    expect(opts.env?.PATH).toBe(process.env.PATH);
  });

  it('bounds output and wall-clock the same way it always has', async () => {
    program({ exit: 0, stdout: '' });
    await getStagedDiff(CWD);
    expect(optsOf(0).maxBuffer).toBe(10 * 1024 * 1024);
    expect(optsOf(0).timeout).toBe(30_000);
  });

  it.each([
    ['staged', () => getStagedDiff(CWD), ['diff', '--cached', ...DIFF_LEVEL]],
    ['unstaged', () => getUnstagedDiff(CWD), ['diff', ...DIFF_LEVEL]],
  ])('%s capture uses the hardened argv', async (_name, run, expected) => {
    program({ exit: 0, stdout: '' });
    await run();
    expect(argvOf(0)).toEqual([...GIT_LEVEL, ...expected]);
  });

  it('ref-to-ref capture uses the hardened argv', async () => {
    program({ exit: 0, stdout: '' });
    await getDiffBetween('main', 'HEAD', CWD);
    expect(argvOf(0)).toEqual([...GIT_LEVEL, 'diff', ...DIFF_LEVEL, 'main', 'HEAD']);
  });

  it('disables external diff and textconv on every capture', async () => {
    // A repository the caller named — not one we chose — can configure
    // diff.external, which git would otherwise execute during capture.
    program({ exit: 0, stdout: 'abc' }, { exit: 0, stdout: '' });
    await getWorkingDiff(CWD);
    for (const call of mockExecFile.mock.calls) {
      const argv = call[1] as string[];
      if (argv.includes('diff')) {
        expect(argv).toContain('--no-ext-diff');
        expect(argv).toContain('--no-textconv');
      }
      expect(argv.slice(0, GIT_LEVEL.length)).toEqual(GIT_LEVEL);
    }
  });

  // Our chunker and file-path parser both read the `a/`…`b/` form, and prefix
  // shape is ordinary repository config in a repository the caller named.
  it('pins the diff prefixes so a repository cannot change how its diff parses', async () => {
    program({ exit: 0, stdout: 'abc' }, { exit: 0, stdout: '' });
    await getWorkingDiff(CWD);
    for (const call of mockExecFile.mock.calls) {
      const argv = call[1] as string[];
      expect(argv).toContain('diff.noprefix=false');
      expect(argv).toContain('diff.mnemonicPrefix=false');
      expect(argv).toContain('diff.srcPrefix=a/');
      expect(argv).toContain('diff.dstPrefix=b/');
    }
  });
});

describe('getStagedDiff', () => {
  it('returns the trimmed diff', async () => {
    program({ exit: 0, stdout: sampleDiff + '\n' });
    const result = await getStagedDiff(CWD);
    expect(result).toEqual({ ok: true, data: sampleDiff });
  });

  it('returns an empty string when nothing is staged', async () => {
    program({ exit: 0, stdout: '' });
    expect(await getStagedDiff(CWD)).toEqual({ ok: true, data: '' });
  });

  it('surfaces git stderr on a non-zero exit', async () => {
    program({ exit: 128, stderr: 'fatal: not a git repository' });
    const result = await getStagedDiff(CWD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('GIT_ERROR: fatal: not a git repository');
  });

  it('reports a missing git binary as a failure to run, not a repository verdict', async () => {
    program({ spawnError: 'spawn git ENOENT', code: 'ENOENT' });
    const result = await getStagedDiff(CWD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('spawn git ENOENT');
  });

  it('reports a timeout as a timeout', async () => {
    program({ killed: true, signal: 'SIGTERM' });
    const result = await getStagedDiff(CWD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('timed out');
  });

  // `--is-inside-work-tree` exits 128 both for "no repository here" and for a
  // real failure, so that one case must read git's words — which means git's
  // words must not be translated.
  it('pins the C locale so the one message-based check cannot be localized away', async () => {
    program({ exit: 0, stdout: 'true' }, { exit: 0, stdout: '/work/repo' });
    await getRepositoryRoot(CWD);
    for (const call of mockExecFile.mock.calls) {
      const options = call[2] as { env: Record<string, string> };
      expect(options.env.LC_ALL).toBe('C');
      expect(options.env.LANG).toBe('C');
      expect(options.env.LANGUAGE).toBe('C');
    }
  });

  it('still strips repository-selecting variables while pinning the locale', async () => {
    program({ exit: 0, stdout: '' });
    await getStagedDiff(CWD);
    const options = mockExecFile.mock.calls[0][2] as { env: Record<string, string> };
    // Only the repository-selecting and config-injecting names go; benign ones
    // like GIT_ASKPASS are deliberately preserved, so check the rule itself.
    expect(Object.keys(options.env).filter(isStrippedGitVariable)).toEqual([]);
    expect(options.env.PATH).toBe(subprocessEnv().PATH);
  });

  // Node kills the child on a maxBuffer overflow, which otherwise looks exactly
  // like a timeout — and "git timed out" would send the reader after the wrong fix.
  it('reports an output-size overflow as an overflow, not a timeout', async () => {
    program({ killed: true, signal: 'SIGTERM', code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    const result = await getStagedDiff(CWD);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('too large');
      expect(result.error).toContain('10 MB');
      expect(result.error).not.toContain('timed out');
    }
  });

  it('escapes terminal controls in git output before it reaches an error string', async () => {
    program({ exit: 128, stderr: 'fatal: [31mred' });
    const result = await getStagedDiff(CWD);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('\\x1B');
      expect(result.error).not.toContain('');
    }
  });
});

describe('getDiffBetween ref validation', () => {
  it.each([
    ['--upload-pack=evil', 'HEAD'],
    ['HEAD', '-x'],
    ['main;rm -rf /', 'HEAD'],
    ['main', 'HEAD$(whoami)'],
  ])('rejects %s..%s without running git', async (base, head) => {
    program({ exit: 0, stdout: '' });
    const result = await getDiffBetween(base, head, CWD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('GIT_ERROR: invalid git ref');
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

// The old implementation asked `git rev-parse --verify HEAD` and treated any
// stderr containing "HEAD" as an unborn repository. Real git says
// "fatal: Needed a single revision" — no "HEAD" — so the fallback never fired.
// These cases are keyed on EXIT CODES, which are stable across locales.
describe('classifyHead', () => {
  it('resolves when HEAD names a commit', async () => {
    program({ exit: 0, stdout: 'abc123\n' });
    expect(await classifyHead(CWD)).toEqual({ ok: true, data: 'resolved' });
    expect(argvOf(0)).toEqual([...GIT_LEVEL, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  });

  it('resolves for a detached HEAD that points at a real commit', async () => {
    program({ exit: 0, stdout: 'abc123\n' });
    expect(await classifyHead(CWD)).toEqual({ ok: true, data: 'resolved' });
  });

  it('reports unborn for a fresh repository with no commits', async () => {
    program(
      { exit: 1 }, // rev-parse --quiet: did not resolve, no stderr
      { exit: 0, stdout: 'refs/heads/main\n' }, // HEAD is a valid symbolic ref
      { exit: 1 }, // the branch does not exist yet
    );
    expect(await classifyHead(CWD)).toEqual({ ok: true, data: 'unborn' });
    expect(argvOf(1)).toEqual([...GIT_LEVEL, 'symbolic-ref', '--quiet', 'HEAD']);
    expect(argvOf(2)).toEqual([...GIT_LEVEL, 'show-ref', '--verify', '--quiet', 'refs/heads/main']);
  });

  it('reports unborn when HEAD points at a branch that was deleted', async () => {
    // Indistinguishable from a fresh repo by design: in both, nothing is
    // reachable from HEAD, and index+work-tree is the right answer.
    program({ exit: 1 }, { exit: 0, stdout: 'refs/heads/gone\n' }, { exit: 1 });
    expect(await classifyHead(CWD)).toEqual({ ok: true, data: 'unborn' });
  });

  it('errors when HEAD is detached at an object that cannot be resolved', async () => {
    program({ exit: 1 }, { exit: 1 }); // not a symbolic ref either
    const result = await classifyHead(CWD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not a branch reference');
  });

  it('errors when the branch exists but HEAD still will not resolve', async () => {
    program(
      { exit: 1 },
      { exit: 0, stdout: 'refs/heads/main\n' },
      { exit: 0 }, // the branch DOES exist — the object store is inconsistent
    );
    const result = await classifyHead(CWD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('inconsistent');
  });

  it('errors on a repository-level failure rather than guessing unborn', async () => {
    program({ exit: 128, stderr: 'fatal: detected dubious ownership' });
    const result = await classifyHead(CWD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('dubious ownership');
  });

  it('errors on an empty symbolic HEAD rather than probing an empty ref', async () => {
    program({ exit: 1 }, { exit: 0, stdout: '\n' });
    const result = await classifyHead(CWD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('empty symbolic HEAD');
  });
});

describe('getWorkingDiff', () => {
  it('diffs against HEAD when HEAD resolves', async () => {
    program({ exit: 0, stdout: 'abc\n' }, { exit: 0, stdout: sampleDiff + '\n' });
    const result = await getWorkingDiff(CWD);
    expect(result).toEqual({ ok: true, data: sampleDiff });
    expect(argvOf(1)).toEqual([...GIT_LEVEL, 'diff', ...DIFF_LEVEL, 'HEAD']);
  });

  it('combines staged and unstaged in an unborn repository', async () => {
    program(
      { exit: 1 },
      { exit: 0, stdout: 'refs/heads/main\n' },
      { exit: 1 },
      { exit: 0, stdout: sampleDiff + '\n' }, // staged
      { exit: 0, stdout: '' }, // unstaged
    );
    const result = await getWorkingDiff(CWD);
    expect(result).toEqual({ ok: true, data: sampleDiff });
    expect(argvOf(3)).toEqual([...GIT_LEVEL, 'diff', '--cached', ...DIFF_LEVEL]);
    expect(argvOf(4)).toEqual([...GIT_LEVEL, 'diff', ...DIFF_LEVEL]);
  });

  it('runs EVERY child command — probes and both fallback captures — in the same directory', async () => {
    program(
      { exit: 1 },
      { exit: 0, stdout: 'refs/heads/main\n' },
      { exit: 1 },
      { exit: 0, stdout: '' },
      { exit: 0, stdout: '' },
    );
    await getWorkingDiff(CWD);
    expect(mockExecFile).toHaveBeenCalledTimes(5);
    for (let call = 0; call < 5; call++) {
      expect(optsOf(call).cwd).toBe(CWD);
    }
  });

  it('propagates a failure from the unborn fallback capture', async () => {
    program(
      { exit: 1 },
      { exit: 0, stdout: 'refs/heads/main\n' },
      { exit: 1 },
      { exit: 128, stderr: 'fatal: index is corrupt' },
    );
    const result = await getWorkingDiff(CWD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('index is corrupt');
  });

  it('never reaches a capture when HEAD classification fails', async () => {
    program({ exit: 128, stderr: 'fatal: not a git repository' });
    const result = await getWorkingDiff(CWD);
    expect(result.ok).toBe(false);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });
});

describe('getRepositoryRoot', () => {
  // The adversarial case: a dubious-ownership error naming a directory that
  // happens to be called "not a git repository". An unanchored substring test
  // matches it and answers "no repository here" — actively wrong, since the fix
  // is `git config --global --add safe.directory`, not a different cwd.
  it('does not misclassify a real error whose PATH contains "not a git repository"', async () => {
    const trickyPath = '/tmp/not a git repository/repo';
    program({
      exit: 128,
      stderr:
        `fatal: detected dubious ownership in repository at '${trickyPath}'\n` +
        'To add an exception for this directory, call:\n\n' +
        `\tgit config --global --add safe.directory '${trickyPath}'`,
    });

    const result = await getRepositoryRoot(trickyPath);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^GIT_ERROR:/);
      expect(result.error).toContain('dubious ownership');
      expect(result.error).toContain('safe.directory');
    }
  });

  it('still recognizes the real "not a git repository" fatal line', async () => {
    program({
      exit: 128,
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    });

    const result = await getRepositoryRoot(CWD);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeNull();
  });

  it('returns the canonical work-tree root', async () => {
    program({ exit: 0, stdout: 'true\n' }, { exit: 0, stdout: '/work/repo-b\n' });
    expect(await getRepositoryRoot(CWD)).toEqual({ ok: true, data: '/work/repo-b' });
    expect(argvOf(0)).toEqual([...GIT_LEVEL, 'rev-parse', '--is-inside-work-tree']);
    expect(argvOf(1)).toEqual([...GIT_LEVEL, 'rev-parse', '--show-toplevel']);
  });

  it('returns null for a bare repository, which answers false with exit 0', async () => {
    program({ exit: 0, stdout: 'false\n' });
    expect(await getRepositoryRoot(CWD)).toEqual({ ok: true, data: null });
    // No point asking for a toplevel that cannot exist.
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('returns null outside any repository', async () => {
    program({
      exit: 128,
      stderr: 'fatal: not a git repository (or any of the parent directories)',
    });
    expect(await getRepositoryRoot(CWD)).toEqual({ ok: true, data: null });
  });

  it('reports dubious ownership as itself, NOT as "no repository"', async () => {
    // Collapsing this into "not a repository" sends the reader after the wrong
    // fix — the actual remedy is git config --global --add safe.directory.
    program({
      exit: 128,
      stderr: "fatal: detected dubious ownership in repository at '/work/repo-b'",
    });
    const result = await getRepositoryRoot(CWD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('dubious ownership');
  });

  it('reports a missing git binary as a failure', async () => {
    program({ spawnError: 'spawn git ENOENT', code: 'ENOENT' });
    const result = await getRepositoryRoot(CWD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('ENOENT');
  });

  it('errors on an empty toplevel rather than returning a blank directory', async () => {
    program({ exit: 0, stdout: 'true\n' }, { exit: 0, stdout: '\n' });
    const result = await getRepositoryRoot(CWD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('empty repository root');
  });
});

describe('isGitRepo', () => {
  it('is true inside a work tree', async () => {
    program({ exit: 0, stdout: 'true\n' }, { exit: 0, stdout: '/work/repo-b\n' });
    expect(await isGitRepo(CWD)).toBe(true);
  });

  it('is false for a bare repository', async () => {
    program({ exit: 0, stdout: 'false\n' });
    expect(await isGitRepo(CWD)).toBe(false);
  });

  it('is false when git cannot run', async () => {
    program({ spawnError: 'spawn git ENOENT', code: 'ENOENT' });
    expect(await isGitRepo(CWD)).toBe(false);
  });
});
