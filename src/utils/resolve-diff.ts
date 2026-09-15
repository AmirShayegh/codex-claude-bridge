import { ok, err, ErrorCode } from './errors.js';
import type { Result } from './errors.js';
import { getDiffBetween, getStagedDiff, getWorkingDiff } from './git.js';
import type { ResolvedWorkspace } from './workspace.js';
import { escapeTerminalControls } from './terminal.js';

export const NO_STAGED_CHANGES = 'NO_STAGED_CHANGES';
export const NO_WORKING_CHANGES = 'NO_WORKING_CHANGES';
export const NO_RANGE_CHANGES = 'NO_RANGE_CHANGES';

// Where a review's diff comes from, decided from the transport arguments alone.
// Normalizing this BEFORE any filesystem work means the explicit-diff paths
// never touch the disk, and a capture path knows exactly what it will ask git
// for before it asks anything.
export type DiffSource =
  | { kind: 'explicit'; diff: string }
  | { kind: 'capture'; target: 'working' | 'staged' }
  // A committed range (ISS-049): `git diff base head` at the repository root.
  | { kind: 'capture'; target: 'range'; base: string; head: string };

// A resolver-specific widening of Result<string>: a capture also reports the
// absolute directory git actually ran in, so an empty or failed capture names
// where it looked instead of being silent (ISS-028). The global Result<T> is
// deliberately unchanged — only a capture carries the extra field.
export type DiffResolution =
  | { ok: true; data: string; capturedFrom?: string }
  | { ok: false; error: string; capturedFrom?: string };

const AUTO_DIFF_DISABLED = 'auto_diff disabled and no diff provided';

// Code review: a defined, NON-BLANK diff is explicit. A missing or
// whitespace-only diff falls through to auto-capture — callers routinely pass
// an empty string meaning "you fetch it".
//
// A `base`/`head` pair names a committed range instead (ISS-049). It is a
// deliberate request, so it does not compete with `auto_diff`; it does compete
// with an explicit diff, and rather than pick one silently the pair is refused.
// `head` alone is refused too: "diff from where?" has no safe default, whereas
// `base` alone means "up to HEAD", which is what a branch review wants.
export function normalizeCodeDiffSource(args: {
  diff?: string;
  auto_diff?: boolean;
  base?: string;
  head?: string;
}): Result<DiffSource> {
  const diff = args.diff ?? '';
  const explicit = diff.trim() !== '';
  if (args.base !== undefined || args.head !== undefined) {
    if (explicit) {
      return err(`${ErrorCode.INVALID_INPUT}: pass either diff or base/head, not both`);
    }
    if (args.base === undefined) {
      return err(`${ErrorCode.INVALID_INPUT}: head requires base (the ref to diff from)`);
    }
    return ok({ kind: 'capture', target: 'range', base: args.base, head: args.head ?? 'HEAD' });
  }
  if (explicit) return ok({ kind: 'explicit', diff });
  // auto_diff defaults to true (undefined !== false)
  if (args.auto_diff !== false) return ok({ kind: 'capture', target: 'working' });
  return err(AUTO_DIFF_DISABLED);
}

// Precommit: ANY defined diff is explicit, including an empty string. Here an
// empty diff is a deliberate "there is nothing to check", not a request to go
// and find something — the two commands differ on this and always have.
export function normalizePrecommitDiffSource(args: {
  diff?: string;
  auto_diff?: boolean;
}): Result<DiffSource> {
  if (args.diff !== undefined) return ok({ kind: 'explicit', diff: args.diff });
  if (args.auto_diff !== false) return ok({ kind: 'capture', target: 'staged' });
  return err(AUTO_DIFF_DISABLED);
}

// The path is data, but an error string is display: escape controls so a
// directory name can never forge a terminal or log line.
function withCaptureLocation(error: string, capturedFrom: string): string {
  return `${error} (capture attempted from "${escapeTerminalControls(capturedFrom)}")`;
}

// Resolve a normalized source into the diff to review.
//
// THE INVARIANT: `capturedFrom` is the exact directory handed to git. Everything
// downstream derives its capture metadata from this value — nothing recomputes a
// directory while formatting a response, because a recomputed value could name a
// directory the diff did not come from, which is worse than saying nothing.
//
// Capture is anchored at the REPOSITORY ROOT, not the caller's own directory: a
// caller standing in a subdirectory still means the whole repository, which is
// what `git diff` from a subdirectory already reports.
export async function captureDiff(
  source: DiffSource,
  workspace: ResolvedWorkspace,
): Promise<DiffResolution> {
  if (source.kind === 'explicit') return ok(source.diff);

  if (workspace.repositoryRoot === null) {
    return err(
      `${ErrorCode.INVALID_INPUT}: cannot auto-capture a diff — ` +
        `"${escapeTerminalControls(workspace.workingDirectory)}" is not inside a git work tree. ` +
        `Pass the diff explicitly, or point cwd at a repository.`,
    );
  }
  const capturedFrom = workspace.repositoryRoot;

  const gitResult = await runCapture(source, capturedFrom);

  if (!gitResult.ok) {
    return { ok: false, error: withCaptureLocation(gitResult.error, capturedFrom), capturedFrom };
  }
  if (!gitResult.data) {
    const [sentinel, detail] = emptyCaptureMessage(source, capturedFrom);
    return { ok: false, error: `${sentinel}: ${detail}`, capturedFrom };
  }
  return { ok: true, data: gitResult.data, capturedFrom };
}

type CaptureSource = Extract<DiffSource, { kind: 'capture' }>;

function runCapture(source: CaptureSource, root: string): Promise<Result<string>> {
  switch (source.target) {
    case 'staged':
      return getStagedDiff(root);
    case 'working':
      return getWorkingDiff(root);
    case 'range':
      return getDiffBetween(source.base, source.head, root);
  }
}

function emptyCaptureMessage(source: CaptureSource, root: string): [string, string] {
  const where = escapeTerminalControls(root);
  switch (source.target) {
    case 'staged':
      return [
        NO_STAGED_CHANGES,
        `No staged changes found in ${where}. Stage files with git add first.`,
      ];
    case 'working':
      return [NO_WORKING_CHANGES, `No changes found vs HEAD in ${where}.`];
    case 'range':
      return [
        NO_RANGE_CHANGES,
        `No changes between ${escapeTerminalControls(source.base)} and ${escapeTerminalControls(source.head)} in ${where}.`,
      ];
  }
}

// Stamp a response with the resolver's capture location. The resolver is the
// only authority on where git ran, so any `captured_from` a backend echoed back
// is dropped first — a reviewer must never be able to name the capture
// directory. An explicit diff passes `undefined` and the field is removed
// entirely rather than emitted as null.
export function withCapturedFrom<T extends object>(result: T, capturedFrom: string | undefined): T {
  const { captured_from: _discarded, ...rest } = result as T & { captured_from?: unknown };
  // Single cast justified: we only ever remove or set `captured_from`, which is
  // an optional field of every result type this is applied to.
  return (capturedFrom === undefined ? rest : { ...rest, captured_from: capturedFrom }) as T;
}

// Result-level form of withCapturedFrom: decorate a success, pass a failure
// through untouched (failures carry their capture location in the message).
export function stampCapture<R extends object>(
  result: Result<R>,
  capturedFrom: string | undefined,
): Result<R> {
  return result.ok ? ok(withCapturedFrom(result.data, capturedFrom)) : result;
}
