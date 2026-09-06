import { ok, err, ErrorCode } from './errors.js';
import type { Result } from './errors.js';
import { getStagedDiff, getWorkingDiff } from './git.js';
import { escapeTerminalControls } from './terminal.js';

export const NO_STAGED_CHANGES = 'NO_STAGED_CHANGES';
export const NO_WORKING_CHANGES = 'NO_WORKING_CHANGES';

// A resolver-specific widening of Result<string>: an auto-capture branch also
// reports the absolute directory git actually ran in, so an empty or failed
// capture names where it looked instead of being silent (ISS-028). The global
// Result<T> is deliberately unchanged — only this module's two entry points
// carry the extra field, and only when git was actually run.
export type DiffResolution =
  | { ok: true; data: string; capturedFrom?: string }
  | { ok: false; error: string; capturedFrom?: string };

// THE INVARIANT: `capturedFrom` is the exact directory handed to git for this
// capture. Everything downstream derives its capture metadata from this value —
// nothing re-reads the cwd while formatting a response, because by then the
// process may have been asked to work somewhere else.
function snapshotCaptureDir(): Result<string> {
  try {
    return ok(process.cwd());
  } catch (e: unknown) {
    // An unlinked or unreadable cwd makes process.cwd() throw. There is no
    // directory to capture from and none may be fabricated, so fail before
    // running git rather than reporting a location we never used.
    const msg = e instanceof Error ? e.message : String(e);
    return err(
      `${ErrorCode.GIT_ERROR}: could not determine the current working directory to capture from: ${msg}`,
    );
  }
}

// The path is data, but an error string is display: escape controls so a
// directory name can never forge a terminal or log line.
function withCaptureLocation(error: string, capturedFrom: string): string {
  return `${error} (capture attempted from "${escapeTerminalControls(capturedFrom)}")`;
}

export async function resolvePrecommitDiff(args: {
  diff?: string;
  auto_diff?: boolean;
}): Promise<DiffResolution> {
  // Explicit diff takes precedence (including empty string). No git runs, so
  // there is no capture location to report.
  if (args.diff !== undefined) {
    return ok(args.diff);
  }

  // auto_diff defaults to true (undefined !== false)
  if (args.auto_diff !== false) {
    const captureDir = snapshotCaptureDir();
    if (!captureDir.ok) return err(captureDir.error);
    const capturedFrom = captureDir.data;

    const gitResult = await getStagedDiff(capturedFrom);
    if (!gitResult.ok) {
      return { ok: false, error: withCaptureLocation(gitResult.error, capturedFrom), capturedFrom };
    }
    if (!gitResult.data) {
      return {
        ok: false,
        error:
          `${NO_STAGED_CHANGES}: No staged changes found in ${escapeTerminalControls(capturedFrom)}. ` +
          `Stage files with git add first.`,
        capturedFrom,
      };
    }
    return { ok: true, data: gitResult.data, capturedFrom };
  }

  return err('auto_diff disabled and no diff provided');
}

export async function resolveCodeDiff(args: {
  diff?: string;
  auto_diff?: boolean;
}): Promise<DiffResolution> {
  // Explicit non-empty diff takes precedence
  if (args.diff !== undefined && args.diff.trim() !== '') {
    return ok(args.diff);
  }

  // auto_diff defaults to true (undefined !== false)
  if (args.auto_diff !== false) {
    const captureDir = snapshotCaptureDir();
    if (!captureDir.ok) return err(captureDir.error);
    const capturedFrom = captureDir.data;

    const gitResult = await getWorkingDiff(capturedFrom);
    if (!gitResult.ok) {
      return { ok: false, error: withCaptureLocation(gitResult.error, capturedFrom), capturedFrom };
    }
    if (!gitResult.data) {
      return {
        ok: false,
        error: `${NO_WORKING_CHANGES}: No changes found vs HEAD in ${escapeTerminalControls(capturedFrom)}.`,
        capturedFrom,
      };
    }
    return { ok: true, data: gitResult.data, capturedFrom };
  }

  return err('auto_diff disabled and no diff provided');
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
