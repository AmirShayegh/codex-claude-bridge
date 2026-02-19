import { exec } from 'node:child_process';
import { ok, err, ErrorCode } from './errors.js';
import type { Result } from './errors.js';

const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB — default 1 MB is too small for large diffs

const GIT_REF_PATTERN = /^[\w.\-/^~@{}]+$/;

function execAsync(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
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

export async function getStagedDiff(): Promise<Result<string>> {
  try {
    const { stdout } = await execAsync('git diff --cached --no-color');
    return ok(stdout.trim());
  } catch (e: unknown) {
    return gitError(e);
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

export async function isGitRepo(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('git rev-parse --is-inside-work-tree');
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}
