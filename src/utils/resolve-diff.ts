import { ok, err } from './errors.js';
import type { Result } from './errors.js';
import { getStagedDiff } from './git.js';

export const NO_STAGED_CHANGES = 'NO_STAGED_CHANGES';

export async function resolvePrecommitDiff(args: {
  diff?: string;
  auto_diff?: boolean;
}): Promise<Result<string>> {
  // Explicit diff takes precedence (including empty string)
  if (args.diff !== undefined) {
    return ok(args.diff);
  }

  // auto_diff defaults to true (undefined !== false)
  if (args.auto_diff !== false) {
    const gitResult = await getStagedDiff();
    if (!gitResult.ok) {
      return gitResult;
    }
    if (!gitResult.data) {
      return err(`${NO_STAGED_CHANGES}: No staged changes found. Stage files with git add first.`);
    }
    return ok(gitResult.data);
  }

  return err('auto_diff disabled and no diff provided');
}
