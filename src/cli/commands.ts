import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Command, Option } from 'commander';
import type Database from 'better-sqlite3';
import { loadConfig, formatConfigSource } from '../config/loader.js';
import { createBackend } from '../backends/index.js';
import type { ReviewBackend } from '../backends/backend.js';
import type { ReviewBridgeConfig } from '../config/types.js';
import { makeSessionModelLookup, makeSessionProviderLookup, openReviewDb } from '../storage/db.js';
import { checkSessionProvider } from '../storage/session-tracker.js';
import { loadCopilotInstructions } from '../config/copilot-instructions.js';
import type { CopilotInstructions } from '../config/copilot-instructions.js';
import { readInput, resetStdinGuard } from './stdin.js';
import { NO_STAGED_CHANGES, resolvePrecommitDiff } from '../utils/resolve-diff.js';
import { createHandler } from './handlers.js';
import type { HandlerIO } from './handlers.js';
import {
  formatPlanResult,
  formatCodeResult,
  formatPrecommitResult,
  detectColor,
} from './formatter.js';
import type { PlanReviewResult, CodeReviewResult, PrecommitResult } from '../review/types.js';
import { escapeTerminalControls } from '../utils/terminal.js';
import { ModelSelectorSchema, SessionIdSchema } from '../utils/input-validation.js';
import { err, ErrorCode, ok } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';

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

interface CliClient {
  client: ReviewBackend;
  // Read-only session db, or undefined when none is reachable. Used by the
  // cross-provider resume guard; the guard fails open when it's undefined.
  db: Database.Database | undefined;
  // The resolved config — commands read defaults (e.g. precommit auto_diff) from it.
  config: ReviewBridgeConfig;
}

interface ValidatedSelectors {
  session: string | undefined;
  model: string | undefined;
}

function validateSelectors(
  session: string | undefined,
  model: string | undefined,
): Result<ValidatedSelectors> {
  if (session !== undefined) {
    const parsed = SessionIdSchema.safeParse(session);
    if (!parsed.success) {
      return err(
        `${ErrorCode.INVALID_INPUT}: session must be 1–256 control-free characters without surrounding whitespace`,
      );
    }
  }
  if (model !== undefined) {
    const parsed = ModelSelectorSchema.safeParse(model);
    if (!parsed.success) {
      return err(
        `${ErrorCode.INVALID_INPUT}: model must be 1–200 control-free characters after trimming`,
      );
    }
    return ok({ session, model: parsed.data });
  }
  return ok({ session, model: undefined });
}

function initClient(configDir: string | undefined, deps: CliDeps): CliClient | null {
  const configResult = loadConfig(configDir);
  if (!configResult.ok) {
    deps.stderr.write(`Error: ${escapeTerminalControls(configResult.error)}\n`);
    deps.exit(1);
    return null;
  }
  const { config, source } = configResult.data;
  deps.stderr.write(
    `[codex-bridge] config source: ${escapeTerminalControls(formatConfigSource(source))}\n`,
  );

  let copilotInstr: CopilotInstructions | undefined;
  if (config.copilot_instructions) {
    // When walk-up discovered a project config, anchor copilot-instructions
    // at that project root rather than process.cwd(). For env/user/default,
    // copilot stays tied to the caller-passed dir or process.cwd().
    const instrCwd = source.kind === 'project' ? dirname(source.path) : configDir;
    const instrResult = loadCopilotInstructions(instrCwd);
    if (instrResult.ok) {
      copilotInstr = instrResult.data;
    } else {
      deps.stderr.write(
        `Copilot instructions load failed, skipping: ${escapeTerminalControls(instrResult.error)}\n`,
      );
    }
  }

  // Read-only so the CLI never creates or writes the review db (no recording).
  // Undefined when no shared db is reachable (no reviews.db, or the CLI runs
  // outside the server's cwd — ISS-018). With no db there is nothing to
  // consult, so resume routing and the cross-provider guard fail OPEN: no
  // lookup is passed and the backend routes to its primary as before. A db we
  // have but cannot read still fails closed inside the lookup itself.
  const db = openReviewDb({ readonly: true });
  try {
    const storedModels = makeSessionModelLookup(db);
    const client = createBackend(
      config,
      copilotInstr,
      db ? makeSessionProviderLookup(db) : undefined,
      (sessionId) => {
        const found = storedModels(sessionId);
        return found.status === 'found' && found.value.status === 'recorded'
          ? found.value.model
          : null;
      },
    );
    return { client, db, config };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.stderr.write(
      `Error: Failed to initialize the review backend: ${escapeTerminalControls(msg)}\n`,
    );
    deps.exit(1);
    return null;
  }
}

// Cross-provider resume guard, shared by all three CLI commands. Returns true to
// proceed, false when a foreign session was rejected (message printed, exit set).
function guardSession(
  init: CliClient,
  sessionId: string | undefined,
  io: HandlerIO,
  deps: CliDeps,
): boolean {
  const guard = checkSessionProvider(init.db, sessionId, init.client.providers);
  if (!guard.ok) {
    io.stderr.write(`Error: ${escapeTerminalControls(guard.error)}\n`);
    deps.exit(1);
    return false;
  }
  return true;
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
    .description('Automated code review')
    .version(version);

  // Prevent Commander from calling process.exit on its own
  program.exitOverride();
  program.configureOutput({
    writeOut: (str) => deps.stdout.write(str),
    writeErr: (str) => {
      const finalNewline = str.endsWith('\n');
      const body = finalNewline ? str.slice(0, -1) : str;
      return deps.stderr.write(`${escapeTerminalControls(body)}${finalNewline ? '\n' : ''}`);
    },
  });

  program
    .command('review-plan')
    .description('Send an implementation plan for architectural review')
    .requiredOption('--plan <path>', 'File path or "-" for stdin')
    .option('--focus <items>', 'Comma-separated focus areas')
    .addOption(new Option('--depth <level>', 'Review depth').choices(['quick', 'thorough']))
    .option('--session <id>', 'Resume session')
    .option('--model <name>', 'Override the configured default model (e.g., gpt-5.5)')
    .option('--deliberate', 'Force deliberation (both providers) for this call')
    .option('--no-deliberate', 'Force single-provider failover for this call')
    .option('--config <path>', 'Path to .reviewbridge.json directory')
    .option('--json', 'Raw JSON output')
    .action(async (opts) => {
      resetStdinGuard();
      const json = opts.json ?? false;
      const io = buildIO(deps, json);
      const selectors = validateSelectors(opts.session, opts.model);
      if (!selectors.ok) {
        io.stderr.write(`Error: ${escapeTerminalControls(selectors.error)}\n`);
        deps.exit(1);
        return;
      }

      const init = initClient(opts.config, deps);
      if (!init) return;
      const { client } = init;
      if (!guardSession(init, selectors.data.session, io, deps)) return;

      const inputResult = await readInput(opts.plan);
      if (!inputResult.ok) {
        io.stderr.write(`Error: ${escapeTerminalControls(inputResult.error)}\n`);
        deps.exit(1);
        return;
      }

      const handler = createHandler<PlanReviewResult>({
        execute: () =>
          client.reviewPlan({
            plan: inputResult.data,
            focus: opts.focus
              ? opts.focus
                  .split(',')
                  .map((s: string) => s.trim())
                  .filter(Boolean)
              : undefined,
            depth: opts.depth,
            session_id: selectors.data.session,
            model: selectors.data.model,
            deliberate: opts.deliberate,
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
    .option('--model <name>', 'Override the configured default model (e.g., gpt-5.5)')
    .option('--deliberate', 'Force deliberation (both providers) for this call')
    .option('--no-deliberate', 'Force single-provider failover for this call')
    .option('--config <path>', 'Path to .reviewbridge.json directory')
    .option('--json', 'Raw JSON output')
    .action(async (opts) => {
      resetStdinGuard();
      const json = opts.json ?? false;
      const io = buildIO(deps, json);
      const selectors = validateSelectors(opts.session, opts.model);
      if (!selectors.ok) {
        io.stderr.write(`Error: ${escapeTerminalControls(selectors.error)}\n`);
        deps.exit(1);
        return;
      }

      const init = initClient(opts.config, deps);
      if (!init) return;
      const { client } = init;

      const inputResult = await readInput(opts.diff);
      if (!inputResult.ok) {
        io.stderr.write(`Error: ${escapeTerminalControls(inputResult.error)}\n`);
        deps.exit(1);
        return;
      }
      const synthetic = inputResult.data.trim().length === 0;
      if (!synthetic && !guardSession(init, selectors.data.session, io, deps)) return;

      const handler = createHandler<CodeReviewResult>({
        execute: () =>
          synthetic
            ? Promise.resolve(
                ok<CodeReviewResult>({
                  verdict: 'approve',
                  summary: 'No changes to review.',
                  findings: [],
                  session_id: selectors.data.session ?? randomUUID(),
                  models: [],
                }),
              )
            : client.reviewCode({
                diff: inputResult.data,
                criteria: opts.focus
                  ? opts.focus
                      .split(',')
                      .map((s: string) => s.trim())
                      .filter(Boolean)
                  : undefined,
                session_id: selectors.data.session,
                model: selectors.data.model,
                deliberate: opts.deliberate,
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
    .option('--model <name>', 'Override the configured default model (e.g., gpt-5.5)')
    .option('--auto-diff', 'Force auto-capture of staged changes for this call')
    .option('--no-auto-diff', 'Skip auto-capture for this call')
    .option('--config <path>', 'Path to .reviewbridge.json directory')
    .option('--json', 'Raw JSON output')
    .action(async (opts) => {
      resetStdinGuard();
      const json = opts.json ?? false;
      const io = buildIO(deps, json);
      const selectors = validateSelectors(opts.session, opts.model);
      if (!selectors.ok) {
        io.stderr.write(`Error: ${escapeTerminalControls(selectors.error)}\n`);
        deps.exit(1);
        return;
      }

      const init = initClient(opts.config, deps);
      if (!init) return;
      const { client, config } = init;

      // Read explicit diff if provided via file/stdin
      let explicitDiff: string | undefined;
      if (opts.diff) {
        const inputResult = await readInput(opts.diff);
        if (!inputResult.ok) {
          io.stderr.write(`Error: ${escapeTerminalControls(inputResult.error)}\n`);
          deps.exit(1);
          return;
        }
        explicitDiff = inputResult.data;
      }

      // Precedence: an explicit --diff means "use this, don't auto-capture";
      // otherwise the --auto-diff/--no-auto-diff flag wins; otherwise the config
      // default (review_standards.precommit.auto_diff).
      const autoDiff = opts.diff
        ? false
        : (opts.autoDiff ?? config.review_standards.precommit.auto_diff);

      const diffResult = await resolvePrecommitDiff({
        diff: explicitDiff,
        auto_diff: autoDiff,
      });
      if (!diffResult.ok) {
        if (!diffResult.error.startsWith(NO_STAGED_CHANGES)) {
          io.stderr.write(`Error: ${escapeTerminalControls(diffResult.error)}\n`);
          deps.exit(1);
          return;
        }
        const syntheticHandler = createHandler<PrecommitResult>({
          execute: () =>
            Promise.resolve(
              ok<PrecommitResult>({
                ready_to_commit: false,
                blockers: [],
                warnings: ['No staged changes found'],
                session_id: selectors.data.session ?? randomUUID(),
                models: [],
              }),
            ),
          format: formatPrecommitResult,
          exitCode: () => 2,
        });
        await syntheticHandler(io);
        return;
      }
      if (!guardSession(init, selectors.data.session, io, deps)) return;

      const handler = createHandler<PrecommitResult>({
        execute: () =>
          client.reviewPrecommit({
            diff: diffResult.data,
            session_id: selectors.data.session,
            model: selectors.data.model,
          }),
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
