import { opendir, realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ok, err, ErrorCode } from './errors.js';
import type { Result } from './errors.js';
import { containsControlCharacters } from './input-validation.js';
import { getRepositoryRoot } from './git.js';

// Which directory a review is ABOUT. Resolved once per request, before any git
// command, provider call, or instruction read.
export interface ResolvedWorkspace {
  // The caller's directory, canonicalized. Provider subprocesses run here.
  workingDirectory: string;
  // The enclosing non-bare work tree's root, canonicalized, or null when the
  // directory is not inside one. Git capture and repository instructions are
  // anchored here, because a caller standing in a subdirectory still means the
  // whole repository.
  repositoryRoot: string | null;
  // Set only when git discovery FAILED, as opposed to reporting no work tree.
  // Reviews that need no repository ignore it; auto-capture reports it rather
  // than claiming the directory simply is not a repository.
  repositoryError?: string;
}

// A path is an argument to a subprocess and a key into a cache, so bound it the
// way every other caller-supplied selector in this codebase is bounded.
export const MAX_WORKSPACE_PATH_LENGTH = 4096;

// One message for every filesystem-level rejection. Naming which check failed —
// or echoing the path back — would turn this into an oracle for probing the
// server's filesystem, and the caller can fix any of these the same way.
const UNUSABLE_DIRECTORY = `${ErrorCode.INVALID_INPUT}: cwd must be an absolute path to an existing, readable directory`;

// Syntactic validation only: no filesystem access, so it is safe to run on a
// value before deciding whether to touch the disk at all. The messages describe
// the RULE, never the value, so nothing caller-controlled reaches a log line.
export function validateWorkspacePath(raw: string): Result<string> {
  if (raw.length === 0) {
    return err(`${ErrorCode.INVALID_INPUT}: cwd must not be empty`);
  }
  if (raw.length > MAX_WORKSPACE_PATH_LENGTH) {
    return err(
      `${ErrorCode.INVALID_INPUT}: cwd must be at most ${MAX_WORKSPACE_PATH_LENGTH} characters`,
    );
  }
  if (containsControlCharacters(raw)) {
    return err(`${ErrorCode.INVALID_INPUT}: cwd must not contain control characters`);
  }
  // `~` is NOT expanded. Expanding it would resolve against the SERVER's home
  // directory, which is precisely the class of mistake this whole change exists
  // to remove — a path that silently means somewhere other than the caller meant.
  if (raw.startsWith('~')) {
    return err(
      `${ErrorCode.INVALID_INPUT}: cwd must not start with "~" — it is not expanded; pass the full absolute path`,
    );
  }
  if (!isAbsolute(raw)) {
    return err(`${ErrorCode.INVALID_INPUT}: cwd must be an absolute path`);
  }
  return ok(raw);
}

// Prove the directory is real and usable, without following a link to somewhere
// that fails the syntactic rules.
//
// `stat` (not `lstat`) is deliberate: a worktree under `.claude/worktrees/` is
// very often reached through a symlink, and refusing those would reject the
// exact case this feature is for. The link is followed by `realpath` first and
// the RESULT is re-validated, so what we accept is always the canonical target.
async function assertUsableDirectory(canonical: string): Promise<Result<void>> {
  try {
    const stats = await stat(canonical);
    if (!stats.isDirectory()) return err(UNUSABLE_DIRECTORY);
  } catch {
    return err(UNUSABLE_DIRECTORY);
  }
  try {
    // stat only proves the directory exists. Opening it proves we may actually
    // traverse and read it — the thing every later git call depends on.
    const handle = await opendir(canonical);
    await handle.close();
  } catch {
    return err(UNUSABLE_DIRECTORY);
  }
  return ok(undefined);
}

// Resolve a caller-supplied (or default) directory into the workspace a review
// runs against. Never throws: every failure is a sanitized INVALID_INPUT.
export async function resolveWorkspace(candidate: string): Promise<Result<ResolvedWorkspace>> {
  const syntactic = validateWorkspacePath(candidate);
  if (!syntactic.ok) return err(syntactic.error);

  let canonical: string;
  try {
    canonical = await realpath(syntactic.data);
  } catch {
    // Missing path, broken symlink, permission denied on a parent, or a symlink
    // loop all land here.
    return err(UNUSABLE_DIRECTORY);
  }

  // Re-validate the CANONICAL result. realpath can land somewhere that would
  // have been rejected as input — a relative-looking target on Windows, or a
  // path that has grown past the length bound through link expansion — and the
  // canonical value is the one every subprocess actually receives.
  const canonicalCheck = validateWorkspacePath(canonical);
  if (!canonicalCheck.ok) return err(UNUSABLE_DIRECTORY);

  const usable = await assertUsableDirectory(canonical);
  if (!usable.ok) return err(usable.error);

  // Not being in a repository is not an error: review_plan needs no repository,
  // and an explicit diff can be reviewed from anywhere. Only auto-capture
  // requires a work tree, and that is enforced where the capture happens.
  // A git discovery FAILURE (dubious ownership, an unreadable object store, git
  // missing) is not an error here either, for the same reason: failing it now
  // would break every review that never needed git. The message is carried
  // instead, and surfaced by the one caller that does need a repository.
  const root = await getRepositoryRoot(canonical);
  if (!root.ok) {
    return ok({ workingDirectory: canonical, repositoryRoot: null, repositoryError: root.error });
  }

  return ok({ workingDirectory: canonical, repositoryRoot: root.data });
}

// Where repository-level instruction files are read from. A caller standing in
// a subdirectory still means the whole repository, so the work-tree root wins
// whenever there is one.
export function instructionsRootFor(workspace: ResolvedWorkspace): string {
  return workspace.repositoryRoot ?? workspace.workingDirectory;
}

/**
 * Canonicalize the directory the process was launched in, once, at startup.
 *
 * Deliberately synchronous: this runs during boot, before any request exists, and
 * keeping it sync leaves the server and CLI construction paths unchanged. It is
 * captured ONCE so a request that names no directory always lands in the same
 * place, even if something later changes the process's own directory.
 *
 * Falls back to the raw value if it cannot be resolved — a server whose own
 * directory is unreadable should still start and let each request report the
 * real problem.
 */
export function canonicalizeStartupDirectory(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}
