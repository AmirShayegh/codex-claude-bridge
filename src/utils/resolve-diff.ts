import { ok, err, ErrorCode } from './errors.js';
import type { Result } from './errors.js';
import { getStagedDiff, getWorkingDiff } from './git.js';
import type { ResolvedWorkspace } from './workspace.js';
import { escapeTerminalControls } from './terminal.js';

export const NO_STAGED_CHANGES = 'NO_STAGED_CHANGES';
export const NO_WORKING_CHANGES = 'NO_WORKING_CHANGES';

// Where a review's diff comes from, decided from the transport arguments alone.
// Normalizing this BEFORE any filesystem work means the explicit-diff paths
// never touch the disk, and a capture path knows exactly what it will ask git
// for before it asks anything.
export type DiffSource =
  | { kind: 'explicit'; diff: string }
  | { kind: 'capture'; target: 'working' | 'staged' };

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
export function normalizeCodeDiffSource(args: {
  diff?: string;
  auto_diff?: boolean;
}): Result<DiffSource> {
  if (args.diff !== undefined && args.diff.trim() !== '') {
    return ok({ kind: 'explicit', diff: args.diff });
  }
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

  const gitResult =
    source.target === 'staged'
      ? await getStagedDiff(capturedFrom)
      : await getWorkingDiff(capturedFrom);

  if (!gitResult.ok) {
    return { ok: false, error: withCaptureLocation(gitResult.error, capturedFrom), capturedFrom };
  }
  if (!gitResult.data) {
    const sentinel = source.target === 'staged' ? NO_STAGED_CHANGES : NO_WORKING_CHANGES;
    const detail =
      source.target === 'staged'
        ? `No staged changes found in ${escapeTerminalControls(capturedFrom)}. Stage files with git add first.`
        : `No changes found vs HEAD in ${escapeTerminalControls(capturedFrom)}.`;
    return { ok: false, error: `${sentinel}: ${detail}`, capturedFrom };
  }
  return { ok: true, data: gitResult.data, capturedFrom };
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
