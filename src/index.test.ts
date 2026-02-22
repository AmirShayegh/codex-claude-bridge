import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const execAsync = promisify(execFile);
const dist = join(process.cwd(), 'dist', 'index.js');
const hasDist = existsSync(dist);

async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execAsync('node', [dist, ...args], {
      timeout: 5000,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    return { stdout, stderr, code: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
  }
}

describe.skipIf(!hasDist)('index.ts router (requires build)', () => {
  it('routes --help to CLI (shows subcommands)', async () => {
    const { stdout, code } = await run(['--help']);
    expect(stdout).toContain('review-plan');
    expect(stdout).toContain('review-code');
    expect(stdout).toContain('review-precommit');
    expect(code).toBe(0);
  });

  it('routes --version to CLI', async () => {
    const { stdout, code } = await run(['--version']);
    expect(stdout).toMatch(/\d+\.\d+\.\d+/);
    expect(code).toBe(0);
  });

  it('routes "help" (Commander built-in) to CLI', async () => {
    const { stdout, code } = await run(['help']);
    expect(stdout).toContain('review-plan');
    expect(code).toBe(0);
  });

  it('routes unknown command to CLI (Commander shows error)', async () => {
    const { stderr, code } = await run(['nonsense']);
    expect(stderr).toContain('unknown command');
    expect(code).not.toBe(0);
  });

  it('routes known subcommand to CLI', async () => {
    const { stdout, code } = await run(['review-precommit', '--help']);
    expect(stdout).toContain('--diff');
    expect(stdout).toContain('--json');
    expect(code).toBe(0);
  });
});
