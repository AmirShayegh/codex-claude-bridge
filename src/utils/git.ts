import { exec } from 'node:child_process';
import { ok, err, ErrorCode } from './errors.js';
import type { Result } from './errors.js';

const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB — default 1 MB is too small for large diffs

const GIT_REF_PATTERN = /^[\w.\-/^~@{}]+$/;

// `cwd` is the directory git runs in. Undefined inherits the process cwd, which
// is the historical behavior; every auto-capture path now passes an explicit
// snapshot so the directory git used is the same one reported back (ISS-028).
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

function gitError(e: unknown): Result<string> {
  const stderr = (e as { stderr?: string }).stderr;
  const msg = stderr || (e instanceof Error ? e.message : String(e));
  return err(`${ErrorCode.GIT_ERROR}: ${msg}`);
}

export async function getStagedDiff(cwd?: string): Promise<Result<string>> {
  try {
    const { stdout } = await execAsync('git diff --cached --no-color', cwd);
    return ok(stdout.trim());
  } catch (e: unknown) {
    return gitError(e);
  }
}

export async function getUnstagedDiff(cwd?: string): Promise<Result<string>> {
  try {
    const { stdout } = await execAsync('git diff --no-color', cwd);
    return ok(stdout.trim());
  } catch (e: unknown) {
    return gitError(e);
  }
}

export async function getDiffBetween(
  base: string,
  head: string,
  cwd?: string,
): Promise<Result<string>> {
  if (base.startsWith('-') || head.startsWith('-')) {
    return err(`${ErrorCode.GIT_ERROR}: invalid git ref`);
  }
  if (!GIT_REF_PATTERN.test(base) || !GIT_REF_PATTERN.test(head)) {
    return err(`${ErrorCode.GIT_ERROR}: invalid git ref`);
  }
  try {
    const { stdout } = await execAsync(`git diff --no-color ${base} ${head}`, cwd);
    return ok(stdout.trim());
  } catch (e: unknown) {
    return gitError(e);
  }
}

export async function getWorkingDiff(cwd?: string): Promise<Result<string>> {
  try {
    // Check if HEAD exists (fails on repos with no commits). Every child
    // command in this function — including the HEAD check and the unborn-HEAD
    // fallback below — must run in the SAME directory, or the reported capture
    // location would not describe the diff we returned.
    await execAsync('git rev-parse --verify HEAD', cwd);
    const { stdout } = await execAsync('git diff HEAD --no-color', cwd);
    return ok(stdout.trim());
  } catch (e: unknown) {
    // If HEAD doesn't exist (unborn repo), fall back to staged + unstaged
    const stderr = (e as { stderr?: string }).stderr ?? '';
    if (stderr.includes('HEAD')) {
      try {
        const staged = await execAsync('git diff --cached --no-color', cwd);
        const unstaged = await execAsync('git diff --no-color', cwd);
        const combined = [staged.stdout.trim(), unstaged.stdout.trim()].filter(Boolean).join('\n');
        return ok(combined);
      } catch (fallbackErr: unknown) {
        return gitError(fallbackErr);
      }
    }
    return gitError(e);
  }
}

export async function isGitRepo(cwd?: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync('git rev-parse --is-inside-work-tree', cwd);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}
