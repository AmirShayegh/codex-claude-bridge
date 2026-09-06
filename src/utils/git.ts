import { execFile } from 'node:child_process';
import { ok, err, ErrorCode } from './errors.js';
import type { Result } from './errors.js';
import { subprocessEnv } from './subprocess-env.js';
import { escapeTerminalControls } from './terminal.js';

const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB — default 1 MB is too small for large diffs
const TIMEOUT_MS = 30_000;

const GIT_REF_PATTERN = /^[\w.\-/^~@{}]+$/;

// Options that must sit BETWEEN `git` and the subcommand. `--no-pager` keeps
// git from ever trying to page into a pipe; `core.fsmonitor=false` stops git
// from starting (or trusting) a filesystem-monitor daemon configured by a
// repository we did not choose.
// Pinning the PREFIXES matters as much as the rest: `diff.noprefix`,
// `diff.mnemonicPrefix`, and `diff.srcPrefix`/`dstPrefix` are ordinary repo
// config, and once a caller names the directory, that config belongs to a
// repository we did not choose. Our own chunker and file-path parser read the
// `a/`…`b/` form, so a repository could otherwise change how its diff parses.
const GIT_LEVEL_OPTIONS = [
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

// Options that must sit AFTER the subcommand. `--no-ext-diff` and `--no-textconv`
// are the load-bearing ones: once a caller can name the directory, a repository's
// own `diff.external` or `diff.<driver>.textconv` config would otherwise run an
// arbitrary program inside our process tree during capture.
const DIFF_LEVEL_OPTIONS = ['--no-color', '--no-ext-diff', '--no-textconv'];

// A completed git invocation. A non-zero exit is an OUTCOME, not an error: the
// HEAD probes below read exit codes as answers, which is why this never throws
// and never collapses an exit code into a failure.
type GitOutcome =
  | { kind: 'exit'; code: number; stdout: string; stderr: string }
  | { kind: 'failure'; message: string };

interface ExecFileFailure extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: string | null;
  stderr?: string;
}

// Run git with an argument ARRAY (never a command string), an explicit working
// directory, and a sanitized environment. No shell is involved, so nothing in a
// path or a ref can be interpreted as syntax.
function runGit(args: string[], cwd: string): Promise<GitOutcome> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...GIT_LEVEL_OPTIONS, ...args],
      {
        cwd,
        // Force git's own messages to the C locale. Exit codes carry every
        // classification this module makes EXCEPT one: `--is-inside-work-tree`
        // returns 128 both for "there is no repository here" and for a real
        // failure, so that single case has to read git's words. Under a
        // translated git those words change, and a caller naming a plain
        // directory would get a raw GIT_ERROR instead of the message that tells
        // them how to fix it. Pinning the locale is what makes the one
        // text-based check as reliable as the exit-code ones.
        env: { ...subprocessEnv(), LC_ALL: 'C', LANGUAGE: 'C', LANG: 'C' },
        maxBuffer: MAX_BUFFER,
        timeout: TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ kind: 'exit', code: 0, stdout, stderr });
          return;
        }
        const failure = error as ExecFileFailure;
        // A numeric `code` is git's own exit status. A string code (ENOENT,
        // ERR_CHILD_PROCESS_STDIO_MAXBUFFER) or a kill signal means git never
        // ran to completion — those are failures of the invocation itself.
        if (typeof failure.code === 'number' && !failure.killed) {
          resolve({ kind: 'exit', code: failure.code, stdout, stderr });
          return;
        }
        // Node kills the child on a maxBuffer overflow, so this must be
        // checked BEFORE the killed/signal branch — otherwise an oversized
        // diff is reported as a timeout and sends the reader after the wrong fix.
        if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({
            kind: 'failure',
            message: `git produced more than ${MAX_BUFFER / (1024 * 1024)} MB of output; the diff is too large to review in one call`,
          });
          return;
        }
        if (failure.killed || failure.signal) {
          resolve({
            kind: 'failure',
            message: `git timed out after ${TIMEOUT_MS / 1000}s or was killed (${failure.signal ?? 'no signal'})`,
          });
          return;
        }
        resolve({ kind: 'failure', message: stderr?.trim() || failure.message });
      },
    );
  });
}

function gitFailure<T>(message: string): Result<T> {
  return err(`${ErrorCode.GIT_ERROR}: ${escapeTerminalControls(message)}`);
}

// Turn a non-zero exit into an error, preferring git's own stderr.
function gitExitError<T>(outcome: { code: number; stderr: string }, fallback: string): Result<T> {
  return gitFailure<T>(outcome.stderr.trim() || `${fallback} (git exited ${outcome.code})`);
}

// git's own words for "there is no repository here". Everything else — dubious
// ownership, a permission error, a corrupt object store — is a real failure
// whose text IS the actionable part, and must never be flattened into
// "not a repository", which would send the reader after the wrong fix.
// Reliable ONLY because runGit pins LC_ALL=C — see the note there.
//
// Anchored to the start of a `fatal:` line. A bare substring test would also
// match a REAL failure that merely quotes a path containing these words — a
// dubious-ownership refusal naming a directory called "not a git repository"
// — and rewrite it into "no repository here", which is actively wrong advice.
function meansNoRepository(stderr: string): boolean {
  return /(?:^|\n)fatal: not a git repository(?:[ :(]|$)/i.test(stderr);
}

async function capture(args: string[], cwd: string): Promise<Result<string>> {
  const outcome = await runGit(args, cwd);
  if (outcome.kind === 'failure') return gitFailure(outcome.message);
  if (outcome.code !== 0) return gitExitError(outcome, 'git diff failed');
  return ok(outcome.stdout.trim());
}

export async function getStagedDiff(cwd: string): Promise<Result<string>> {
  return capture(['diff', '--cached', ...DIFF_LEVEL_OPTIONS], cwd);
}

export async function getUnstagedDiff(cwd: string): Promise<Result<string>> {
  return capture(['diff', ...DIFF_LEVEL_OPTIONS], cwd);
}

export async function getDiffBetween(
  base: string,
  head: string,
  cwd: string,
): Promise<Result<string>> {
  // No shell is involved any more, but a ref beginning with `-` would still be
  // read by git itself as an option, so both checks stay.
  if (base.startsWith('-') || head.startsWith('-')) {
    return err(`${ErrorCode.GIT_ERROR}: invalid git ref`);
  }
  if (!GIT_REF_PATTERN.test(base) || !GIT_REF_PATTERN.test(head)) {
    return err(`${ErrorCode.GIT_ERROR}: invalid git ref`);
  }
  return capture(['diff', ...DIFF_LEVEL_OPTIONS, base, head], cwd);
}

// Whether HEAD names a commit yet. `unborn` is the freshly-initialized case (and
// its equivalent: HEAD pointing at a branch that does not exist), where there is
// nothing to diff against and the index plus work tree ARE the change.
export type HeadState = 'resolved' | 'unborn';

// Classify HEAD by EXIT CODE, never by message text.
//
// The previous implementation asked `git rev-parse --verify HEAD` and treated
// any stderr containing "HEAD" as an unborn repository. Real git says
// `fatal: Needed a single revision` — no "HEAD" anywhere — so that fallback
// never actually fired, and it would have been locale-dependent even if the
// wording had matched.
export async function classifyHead(cwd: string): Promise<Result<HeadState>> {
  // `--quiet` suppresses stderr and makes exit 1 mean exactly "did not resolve".
  const resolved = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd);
  if (resolved.kind === 'failure') return gitFailure(resolved.message);
  if (resolved.code === 0) return ok('resolved');
  if (resolved.code !== 1) {
    // 128 and friends are repository-level failures (missing repo, dubious
    // ownership, unreadable object store) — not "no commits yet".
    return gitExitError(resolved, 'could not resolve HEAD');
  }

  // HEAD did not resolve. That is only an unborn branch when HEAD is a valid
  // symbolic reference whose target simply does not exist yet.
  const symbolic = await runGit(['symbolic-ref', '--quiet', 'HEAD'], cwd);
  if (symbolic.kind === 'failure') return gitFailure(symbolic.message);
  if (symbolic.code !== 0) {
    // Detached at something unresolvable, or HEAD is not a symbolic ref at all.
    return err(
      `${ErrorCode.GIT_ERROR}: HEAD does not resolve to a commit and is not a branch reference ` +
        `(detached at a missing object, or a damaged HEAD).`,
    );
  }
  const target = symbolic.stdout.trim();
  if (!target) {
    return err(`${ErrorCode.GIT_ERROR}: git reported an empty symbolic HEAD`);
  }

  const branch = await runGit(['show-ref', '--verify', '--quiet', target], cwd);
  if (branch.kind === 'failure') return gitFailure(branch.message);
  // Absent target → nothing committed on this branch yet: genuinely unborn.
  if (branch.code === 1) return ok('unborn');
  if (branch.code === 0) {
    // The branch exists but HEAD^{commit} would not resolve — the ref points at
    // an object the repository cannot read. Diffing would fail confusingly.
    return err(
      `${ErrorCode.GIT_ERROR}: HEAD points at ${escapeTerminalControls(target)}, which exists but ` +
        `cannot be resolved to a commit; the repository's object store is inconsistent.`,
    );
  }
  return gitExitError(branch, 'could not verify the branch HEAD points at');
}

export async function getWorkingDiff(cwd: string): Promise<Result<string>> {
  const head = await classifyHead(cwd);
  if (!head.ok) return err(head.error);

  if (head.data === 'resolved') {
    return capture(['diff', ...DIFF_LEVEL_OPTIONS, 'HEAD'], cwd);
  }

  // Unborn: there is no commit to diff against, so the change is the index plus
  // the work tree. Untracked files stay excluded, exactly as `git diff HEAD` would.
  const staged = await capture(['diff', '--cached', ...DIFF_LEVEL_OPTIONS], cwd);
  if (!staged.ok) return staged;
  const unstaged = await capture(['diff', ...DIFF_LEVEL_OPTIONS], cwd);
  if (!unstaged.ok) return unstaged;
  return ok([staged.data, unstaged.data].filter(Boolean).join('\n'));
}

// The canonical root of the non-bare work tree containing `cwd`, or null when
// there is no usable work tree there.
//
// Three outcomes are deliberately kept apart: a real work tree (its root), an
// ordinary directory or a BARE repository (null — nothing to capture, but not a
// failure), and git failing to run at all (an error carrying git's own text).
export async function getRepositoryRoot(cwd: string): Promise<Result<string | null>> {
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside.kind === 'failure') return gitFailure(inside.message);
  if (inside.code !== 0) {
    if (meansNoRepository(inside.stderr)) return ok(null);
    return gitExitError(inside, 'could not determine whether this is a git work tree');
  }
  // A bare repository answers `false` with exit 0 — it has no work tree to
  // capture from, which is a "no", not a failure.
  if (inside.stdout.trim() !== 'true') return ok(null);

  const toplevel = await runGit(['rev-parse', '--show-toplevel'], cwd);
  if (toplevel.kind === 'failure') return gitFailure(toplevel.message);
  if (toplevel.code !== 0) {
    return gitExitError(toplevel, 'could not determine the repository root');
  }
  const root = toplevel.stdout.trim();
  if (!root) return err(`${ErrorCode.GIT_ERROR}: git reported an empty repository root`);
  return ok(root);
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const root = await getRepositoryRoot(cwd);
  return root.ok && root.data !== null;
}
