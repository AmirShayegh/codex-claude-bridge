import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Command, Option } from 'commander';
import { loadConfig } from '../config/loader.js';
import { DEFAULT_CONFIG } from '../config/types.js';
import { createCodexClient } from '../codex/client.js';
import type { CodexClient } from '../codex/client.js';
import { readInput, resetStdinGuard } from './stdin.js';
import { resolvePrecommitDiff } from '../utils/resolve-diff.js';
import { createHandler } from './handlers.js';
import type { HandlerIO } from './handlers.js';
import {
  formatPlanResult,
  formatCodeResult,
  formatPrecommitResult,
  detectColor,
} from './formatter.js';
import type { PlanReviewResult, CodeReviewResult, PrecommitResult } from '../codex/types.js';

export interface CliDeps {
  stdout: HandlerIO['stdout'];
  stderr: HandlerIO['stderr'];
  exit: (code: number) => void;
  env: Record<string, string | undefined>;
  isTTY: boolean;
}

const DEFAULT_DEPS: CliDeps = {
  stdout: process.stdout,
  stderr: process.stderr,
  exit: process.exit,
  env: process.env,
  isTTY: process.stdout.isTTY ?? false,
};

function buildIO(deps: CliDeps, json: boolean): HandlerIO {
  return {
    stdout: deps.stdout,
    stderr: deps.stderr,
    exit: deps.exit,
    color: detectColor(deps.env, deps.isTTY),
    json,
  };
}

function initClient(configDir: string | undefined, deps: CliDeps): CodexClient | null {
  const configResult = loadConfig(configDir);
  if (!configResult.ok) {
    deps.stderr.write(`Config error: ${configResult.error}\n`);
  }
  const config = configResult.ok ? configResult.data : DEFAULT_CONFIG;

  try {
    return createCodexClient(config);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.stderr.write(`Error: Failed to initialize Codex client: ${msg}\n`);
    deps.exit(1);
    return null;
  }
}

async function readVersion(): Promise<string> {
  const dir = dirname(fileURLToPath(import.meta.url));
  // Walk up to find package.json (works from both src/ and dist/)
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const raw = await readFile(join(dir, rel), 'utf-8');
      const pkg = JSON.parse(raw) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try next path
    }
  }
  return '0.0.0';
}

export async function runCli(argv?: string[], deps: CliDeps = DEFAULT_DEPS): Promise<void> {
  const version = await readVersion();

  const program = new Command()
    .name('codex-claude-bridge')
    .description('Code review powered by OpenAI Codex')
    .version(version);

  // Prevent Commander from calling process.exit on its own
  program.exitOverride();
  program.configureOutput({
    writeOut: (str) => deps.stdout.write(str),
    writeErr: (str) => deps.stderr.write(str),
  });

  program
    .command('review-plan')
    .description('Send an implementation plan for architectural review')
    .requiredOption('--plan <path>', 'File path or "-" for stdin')
    .option('--focus <items>', 'Comma-separated focus areas')
    .addOption(new Option('--depth <level>', 'Review depth').choices(['quick', 'thorough']))
    .option('--session <id>', 'Resume session')
    .option('--config <path>', 'Path to .reviewbridge.json directory')
    .option('--json', 'Raw JSON output')
    .action(async (opts) => {
      resetStdinGuard();
      const json = opts.json ?? false;
      const io = buildIO(deps, json);

      const client = initClient(opts.config, deps);
      if (!client) return;

      const inputResult = await readInput(opts.plan);
      if (!inputResult.ok) {
        io.stderr.write(`Error: ${inputResult.error}\n`);
        deps.exit(1);
        return;
      }

      const handler = createHandler<PlanReviewResult>({
        execute: () =>
          client.reviewPlan({
            plan: inputResult.data,
            focus: opts.focus ? opts.focus.split(',').map((s: string) => s.trim()) : undefined,
            depth: opts.depth,
            session_id: opts.session,
          }),
        format: formatPlanResult,
        exitCode: () => 0,
      });

      await handler(io);
    });

  program
    .command('review-code')
    .description('Send a code diff for review')
    .requiredOption('--diff <path>', 'File path or "-" for stdin')
    .option('--focus <items>', 'Comma-separated review criteria')
    .option('--session <id>', 'Resume session')
    .option('--config <path>', 'Path to .reviewbridge.json directory')
    .option('--json', 'Raw JSON output')
    .action(async (opts) => {
      resetStdinGuard();
      const json = opts.json ?? false;
      const io = buildIO(deps, json);

      const client = initClient(opts.config, deps);
      if (!client) return;

      const inputResult = await readInput(opts.diff);
      if (!inputResult.ok) {
        io.stderr.write(`Error: ${inputResult.error}\n`);
        deps.exit(1);
        return;
      }

      const handler = createHandler<CodeReviewResult>({
        execute: () =>
          client.reviewCode({
            diff: inputResult.data,
            criteria: opts.focus ? opts.focus.split(',').map((s: string) => s.trim()) : undefined,
            session_id: opts.session,
          }),
        format: formatCodeResult,
        exitCode: () => 0,
      });

      await handler(io);
    });

  program
    .command('review-precommit')
    .description('Quick pre-commit sanity check on staged changes')
    .option('--diff <path>', 'Override auto-capture (path or "-" for stdin)')
    .option('--session <id>', 'Resume session')
    .option('--config <path>', 'Path to .reviewbridge.json directory')
    .option('--json', 'Raw JSON output')
    .action(async (opts) => {
      resetStdinGuard();
      const json = opts.json ?? false;
      const io = buildIO(deps, json);

      const client = initClient(opts.config, deps);
      if (!client) return;

      // Read explicit diff if provided via file/stdin
      let explicitDiff: string | undefined;
      if (opts.diff) {
        const inputResult = await readInput(opts.diff);
        if (!inputResult.ok) {
          io.stderr.write(`Error: ${inputResult.error}\n`);
          deps.exit(1);
          return;
        }
        explicitDiff = inputResult.data;
      }

      const handler = createHandler<PrecommitResult>({
        execute: async () => {
          const diffResult = await resolvePrecommitDiff({
            diff: explicitDiff,
            auto_diff: !opts.diff, // auto when no explicit diff
          });
          if (!diffResult.ok) {
            return diffResult;
          }
          return client.reviewPrecommit({
            diff: diffResult.data,
            session_id: opts.session,
          });
        },
        format: formatPrecommitResult,
        exitCode: (result) => (result.ready_to_commit ? 0 : 2),
      });

      await handler(io);
    });

  try {
    await program.parseAsync(argv ?? process.argv);
  } catch (e) {
    // Commander's exitOverride throws on --help, --version, and errors
    // Only re-throw if it's not a Commander exit
    if (e instanceof Error && 'exitCode' in e) {
      const code = (e as { exitCode: number }).exitCode;
      deps.exit(code);
    } else {
      throw e;
    }
  }
}
