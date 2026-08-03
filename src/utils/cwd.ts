import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ok, err, ErrorCode } from './errors.js';
import type { Result } from './errors.js';

// Maps a statSync failure's errno to a clear, actionable INVALID_INPUT
// message. Split out so the mapping itself is directly unit-testable with
// synthetic errno codes, without needing to reproduce real filesystem races
// (a permission-denied directory in particular is fiddly and platform/
// root-dependent to set up reliably in a test) — see cwd.test.ts.
export function classifyStatError(e: unknown, cwd: string, absolute: string): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return `${ErrorCode.INVALID_INPUT}: cwd "${cwd}" does not exist (resolved to "${absolute}")`;
  }
  if (code === 'EACCES') {
    return (
      `${ErrorCode.INVALID_INPUT}: cwd "${cwd}" is not accessible ` +
      `(permission denied; resolved to "${absolute}")`
    );
  }
  const msg = e instanceof Error ? e.message : String(e);
  return `${ErrorCode.INVALID_INPUT}: cwd "${cwd}" could not be checked (resolved to "${absolute}"): ${msg}`;
}

/**
 * Validate and resolve an optional caller-supplied `cwd` (e.g. the review
 * tools' `cwd` param) to an absolute path.
 *
 * `undefined` passes through unchanged — the zero-footprint default, meaning
 * "use the server process's own cwd" everywhere downstream. A blank string
 * (empty or all-whitespace) is treated the same way: `path.resolve('')`
 * would otherwise silently resolve to the server's own cwd, which is a
 * confusing thing to do quietly for what's almost certainly an unset
 * variable on the caller's side rather than an intentional value. Any other
 * defined value must name an existing directory; anything else is a clear,
 * actionable INVALID_INPUT error rather than a crash or a confusing
 * downstream git/fs failure.
 *
 * A single statSync call (never existsSync-then-statSync): checking
 * existence and then separately stat-ing leaves a window where the path can
 * vanish, or its permissions change, between the two calls — and a plain
 * statSync throws on failure, which would have escaped this function's
 * Result contract straight past both tool handlers' try blocks (they call
 * resolveCwd before entering them). One call, wrapped in try/catch, closes
 * that window and guarantees this function never throws.
 */
export function resolveCwd(cwd: string | undefined): Result<string | undefined> {
  if (cwd === undefined || cwd.trim() === '') {
    return ok(undefined);
  }

  const absolute = resolve(cwd);

  let stats;
  try {
    stats = statSync(absolute);
  } catch (e: unknown) {
    return err(classifyStatError(e, cwd, absolute));
  }

  if (!stats.isDirectory()) {
    return err(
      `${ErrorCode.INVALID_INPUT}: cwd "${cwd}" is not a directory (resolved to "${absolute}")`,
    );
  }

  return ok(absolute);
}
