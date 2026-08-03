import { exec } from 'node:child_process';
import { ok, err, ErrorCode } from './errors.js';
import type { Result } from './errors.js';

const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB — default 1 MB is too small for large diffs

const GIT_REF_PATTERN = /^[\w.\-/^~@{}]+$/;

// cwd is undefined by default, which node's exec() treats as "inherit
// process.cwd()" — the pre-existing, zero-footprint default. Auto-capture
// callers (getStagedDiff/getWorkingDiff) pass an explicit cwd when the caller
// (e.g. the MCP tool layer) named a repository directory, so git commands run
// there instead of wherever the server process happened to start.
function execAsync(cmd: string, cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: MAX_BUFFER, timeout: 30_000, cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// git's own, stable fatal message for "there is no repository here"
// (confirmed live against git 2.39.5: `git rev-parse --is-inside-work-tree`
// and `git rev-parse --verify HEAD` outside a work tree both print exactly
// "fatal: not a git repository (or any of the parent directories): .git").
// Used to recognize a GENUINE not-a-repo failure so it — and only it — gets
// rewritten into the friendlier, cwd-naming message. Every other failure (a
// `safe.directory` dubious-ownership refusal, permission errors, a missing
// git binary, a command timeout, ...) must keep its real text: rewriting
// those into "not a repo" would send someone chasing the wrong fix.
//
// Anchored to the start of the fatal line (not a bare substring test): a
// dubious-ownership error can legitimately quote a PATH that itself contains
// the words "not a git repository" (e.g. a directory literally named that),
// and an unanchored match would misclassify it. Requires "fatal: not a git
// repository" right after a line start, followed by a space, colon, paren,
// or end of string — covering both the "(or any of the parent
// directories)" and "(or any parent up to mount point ...)" phrasings.
function looksLikeNotARepoMessage(message: string): boolean {
  return /(?:^|\n)fatal: not a git repository(?:[ :(]|$)/i.test(message);
}

// The --no-index "unknown option" fallback is specific to running `git diff
// --cached` OUTSIDE a work tree — confirmed live: `error: unknown option
// \`cached'` followed by a `usage: git diff --no-index ...` block. That is
// NOT a generic "unknown option" signature: an unrelated bad flag, or
// version-skew usage text, could plausibly contain one of those phrases
// without meaning this fallback. Require both "unknown option" naming
// "cached" AND --no-index context on the same message before treating it as
// this specific fallback. Callers additionally gate this on cachedCommand
// (see gitError) so it can only ever fire for the one command it describes.
function looksLikeCachedNoIndexFallback(message: string): boolean {
  const lower = message.toLowerCase();
  const namesCachedAsUnknownOption = /unknown option[^\n]*cached/.test(lower);
  const noIndexContext = lower.includes('--no-index');
  return namesCachedAsUnknownOption && noIndexContext;
}

function notAGitRepoError(cwd: string | undefined): string {
  const resolved = cwd ?? process.cwd();
  return (
    `${ErrorCode.GIT_ERROR}: "${resolved}" is not inside a git repository (or any parent of it). ` +
    'Auto-capture runs git commands there. If the MCP server started from a different directory, ' +
    'pass the "cwd" parameter with your repository path, or pass an explicit "diff" instead.'
  );
}

// cachedCommand: set ONLY by the call site that just ran `git diff --cached`
// — every other call site omits it, so the no-index rewrite can never fire
// for a command it doesn't describe (e.g. `git rev-parse --verify HEAD`, or
// the unstaged half of getWorkingDiff's HEAD-less fallback).
function gitError<T>(e: unknown, cwd?: string, opts?: { cachedCommand?: boolean }): Result<T> {
  const stderr = (e as { stderr?: string }).stderr;
  const msg = stderr || (e instanceof Error ? e.message : String(e));
  if (opts?.cachedCommand && looksLikeCachedNoIndexFallback(msg)) {
    return err(notAGitRepoError(cwd));
  }
  return err(`${ErrorCode.GIT_ERROR}: ${msg}`);
}

// Inside/outside classification shared by isGitRepo and the auto-capture
// preflight (checkWorkTreeForCapture below). A genuine "not a repository"
// outcome is reported distinctly from every other failure so callers can
// choose not to collapse permission errors, dubious-ownership refusals, a
// missing git binary, or a timeout into a misleading "not a repo" message.
type WorkTreeProbe = { kind: 'inside' } | { kind: 'not-a-repo' } | { kind: 'error'; error: string };

async function probeWorkTree(cwd?: string): Promise<WorkTreeProbe> {
  try {
    const { stdout } = await execAsync('git rev-parse --is-inside-work-tree', cwd);
    // Success with stdout other than 'true' (e.g. 'false' in a bare repo —
    // no work tree to diff against) is "not a repo" for our purposes, same
    // as the classic fatal message below.
    return stdout.trim() === 'true' ? { kind: 'inside' } : { kind: 'not-a-repo' };
  } catch (e: unknown) {
    const stderr = (e as { stderr?: string }).stderr;
    const msg = stderr || (e instanceof Error ? e.message : String(e));
    if (looksLikeNotARepoMessage(msg)) {
      return { kind: 'not-a-repo' };
    }
    // A real failure that has nothing to do with "no repo here" — a
    // safe.directory dubious-ownership refusal, permission denied, git
    // itself missing, a timeout, etc. Preserve it verbatim.
    return { kind: 'error', error: `${ErrorCode.GIT_ERROR}: ${msg}` };
  }
}

// Preflight for getStagedDiff/getWorkingDiff: ok(true) inside a usable work
// tree; the friendly, cwd-naming error for a genuine "no repo here"; the
// real underlying error, untouched, for anything else — so the caller sees
// what actually needs fixing instead of always "pass the cwd param", which
// would be actively wrong advice for e.g. a dubious-ownership refusal.
async function checkWorkTreeForCapture(cwd?: string): Promise<Result<true>> {
  const probe = await probeWorkTree(cwd);
  switch (probe.kind) {
    case 'inside':
      return ok(true);
    case 'not-a-repo':
      return err(notAGitRepoError(cwd));
    case 'error':
      return err(probe.error);
  }
}

export async function getStagedDiff(cwd?: string): Promise<Result<string>> {
  const repoCheck = await checkWorkTreeForCapture(cwd);
  if (!repoCheck.ok) {
    return repoCheck;
  }
  try {
    const { stdout } = await execAsync('git diff --cached --no-color', cwd);
    return ok(stdout.trim());
  } catch (e: unknown) {
    return gitError(e, cwd, { cachedCommand: true });
  }
}

export async function getUnstagedDiff(): Promise<Result<string>> {
  try {
    const { stdout } = await execAsync('git diff --no-color');
    return ok(stdout.trim());
  } catch (e: unknown) {
    return gitError(e);
  }
}

export async function getDiffBetween(base: string, head: string): Promise<Result<string>> {
  if (base.startsWith('-') || head.startsWith('-')) {
    return err(`${ErrorCode.GIT_ERROR}: invalid git ref`);
  }
  if (!GIT_REF_PATTERN.test(base) || !GIT_REF_PATTERN.test(head)) {
    return err(`${ErrorCode.GIT_ERROR}: invalid git ref`);
  }
  try {
    const { stdout } = await execAsync(`git diff --no-color ${base} ${head}`);
    return ok(stdout.trim());
  } catch (e: unknown) {
    return gitError(e);
  }
}

export async function getWorkingDiff(cwd?: string): Promise<Result<string>> {
  // Same preflight rationale as getStagedDiff: fail fast with a clear,
  // cwd-naming message for a genuine "no repo here" — and the real error for
  // anything else — before ever attempting the commands below.
  const repoCheck = await checkWorkTreeForCapture(cwd);
  if (!repoCheck.ok) {
    return repoCheck;
  }
  try {
    // Check if HEAD exists (fails on repos with no commits)
    await execAsync('git rev-parse --verify HEAD', cwd);
    const { stdout } = await execAsync('git diff HEAD --no-color', cwd);
    return ok(stdout.trim());
  } catch (e: unknown) {
    // If HEAD doesn't exist (unborn repo), fall back to staged + unstaged.
    // We're already confirmed inside a work tree (preflight above), so any
    // further failure here is real and reported as-is.
    const stderr = (e as { stderr?: string }).stderr ?? '';
    if (stderr.includes('HEAD')) {
      let staged: { stdout: string };
      try {
        staged = await execAsync('git diff --cached --no-color', cwd);
      } catch (fallbackErr: unknown) {
        return gitError(fallbackErr, cwd, { cachedCommand: true });
      }
      try {
        const unstaged = await execAsync('git diff --no-color', cwd);
        const combined = [staged.stdout.trim(), unstaged.stdout.trim()].filter(Boolean).join('\n');
        return ok(combined);
      } catch (fallbackErr: unknown) {
        return gitError(fallbackErr, cwd);
      }
    }
    return gitError(e, cwd);
  }
}

export async function isGitRepo(cwd?: string): Promise<boolean> {
  const probe = await probeWorkTree(cwd);
  return probe.kind === 'inside';
}
