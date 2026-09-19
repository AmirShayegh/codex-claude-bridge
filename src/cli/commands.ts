import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Command, Option } from 'commander';
import type Database from 'better-sqlite3';
import { loadConfig, formatConfigSource } from '../config/loader.js';
import { createBackend } from '../backends/index.js';
import type { ReviewBackend } from '../backends/backend.js';
import { REVIEW_TIERS, ReviewTierSchema } from '../config/types.js';
import type { ReviewBridgeConfig } from '../config/types.js';
import { makeSessionModelLookup, makeSessionProviderLookup, openReviewDb } from '../storage/db.js';
import { checkSessionProvider } from '../storage/session-tracker.js';
import { canonicalizeStartupDirectory } from '../utils/workspace.js';
import { createPreparationLimiter } from '../review/preparation.js';
import { preparePlanReview, prepareDiffReview } from '../review/request-prep.js';
import type { RequestPreparationDeps } from '../review/request-prep.js';
import { readInput, resetStdinGuard } from './stdin.js';
import {
  normalizeCodeDiffSource,
  normalizePrecommitDiffSource,
  stampCapture,
} from '../utils/resolve-diff.js';
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
import {
  GitRefSchema,
  ModelSelectorSchema,
  SessionIdSchema,
  WorkingDirectorySchema,
} from '../utils/input-validation.js';
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
  // Where reviews run and how instruction files are read for this invocation.
  prep: RequestPreparationDeps;
}

// The directory this CLI process was invoked in, captured and canonicalized ONCE.
// A relative --cwd resolves against THIS value rather than a live process.cwd()
// read, so every command in one invocation agrees on what "." meant.
//
// process.cwd() THROWS when the directory has been deleted out from under the
// shell, and this runs at module scope — an unguarded read would kill the CLI
// with a stack trace before Commander could print anything, including --help.
// An absolute --cwd is still perfectly serviceable in that state, so the failure
// is carried and only reported by the paths that actually need the directory.
const invocation: { directory: string; error?: string } = (() => {
  try {
    return { directory: canonicalizeStartupDirectory(process.cwd()) };
  } catch (e: unknown) {
    return {
      directory: '',
      error:
        `${ErrorCode.INVALID_INPUT}: the current working directory is unavailable ` +
        `(${escapeTerminalControls(e instanceof Error ? e.message : String(e))}). ` +
        `Run from an existing directory, or pass an absolute --cwd.`,
    };
  }
})();
const invocationDirectory = invocation.directory;

function splitCriteria(focus: string | undefined): string[] | undefined {
  return focus
    ? focus
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean)
    : undefined;
}

// --base/--head are validated with the same schema the MCP surface uses, so a
// ref that would be read by git as an option never reaches it (ISS-049).
function validateRangeRefs(base: unknown, head: unknown): Result<{ base: string; head: string }> {
  const parsedBase = GitRefSchema.safeParse(base);
  if (!parsedBase.success) {
    return err(
      `${ErrorCode.INVALID_INPUT}: --base ${parsedBase.error.issues[0]?.message ?? 'is invalid'}`,
    );
  }
  if (head === undefined) return ok({ base: parsedBase.data, head: 'HEAD' });
  const parsedHead = GitRefSchema.safeParse(head);
  if (!parsedHead.success) {
    return err(
      `${ErrorCode.INVALID_INPUT}: --head ${parsedHead.error.issues[0]?.message ?? 'is invalid'}`,
    );
  }
  return ok({ base: parsedBase.data, head: parsedHead.data });
}

const CWD_HELP =
  'Directory to review in — the repository or git worktree whose code is being reviewed ' +
  '(default: the current directory). Relative paths resolve against the current directory. ' +
  'Does NOT affect --plan, --diff, or --config, which stay relative to the current directory.';

// Resolve --cwd to an absolute path. Relative input is allowed here (unlike the
// MCP surface) because a CLI caller has a shell working directory to resolve
// against; existence and readability are checked later by resolveWorkspace.
function resolveCwdOption(raw: string | undefined): Result<string | undefined> {
  if (raw === undefined) return ok(undefined);
  const parsed = WorkingDirectorySchema.safeParse(raw);
  if (!parsed.success) {
    return err(
      `${ErrorCode.INVALID_INPUT}: --cwd must be 1–4096 characters and free of control characters`,
    );
  }
  // An absolute path needs no base, so it still works when the invocation
  // directory is gone. A relative one cannot be resolved without a base.
  if (isAbsolute(parsed.data)) return ok(parsed.data);
  if (invocation.error !== undefined) return err(invocation.error);
  return ok(resolve(invocationDirectory, parsed.data));
}

interface ValidatedSelectors {
  session: string | undefined;
  model: string | undefined;
}

function validateSelectors(
  session: string | undefined,
  model: string | undefined,
  tier: string | undefined,
): Result<ValidatedSelectors> {
  if (session !== undefined) {
    const parsed = SessionIdSchema.safeParse(session);
    if (!parsed.success) {
      return err(
        `${ErrorCode.INVALID_INPUT}: session must be 1–256 control-free characters without surrounding whitespace`,
      );
    }
  }
  // --tier is the same selector as --model, by capability (ISS-054); the backends
  // take one, so both at once is a contradiction rather than a precedence call.
  if (model !== undefined && tier !== undefined) {
    return err(`${ErrorCode.INVALID_INPUT}: pass either --model or --tier, not both`);
  }
  if (tier !== undefined) {
    const parsed = ReviewTierSchema.safeParse(tier);
    if (!parsed.success) {
      return err(`${ErrorCode.INVALID_INPUT}: tier must be one of ${REVIEW_TIERS.join(', ')}`);
    }
    return ok({ session, model: parsed.data });
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

  // Instruction files are now read per review, anchored at the REVIEWED
  // repository's root — so `--cwd` picks them up without a config reload.
  const prep: RequestPreparationDeps = {
    limiter: createPreparationLimiter(),
    defaultWorkingDirectory: invocationDirectory,
    loadInstructions: config.copilot_instructions,
  };

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
      db ? makeSessionProviderLookup(db) : undefined,
      (sessionId) => {
        const found = storedModels(sessionId);
        return found.status === 'found' && found.value.status === 'recorded'
          ? found.value.model
          : null;
      },
    );
    return { client, db, config, prep };
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
    .option('--cwd <path>', CWD_HELP)
    .option(
      '--model <name>',
      'Override the configured default model by id (e.g., gpt-5.6-sol) or "latest"',
    )
    .option(
      '--tier <name>',
      'Pick the reviewing model by capability tier: max | balanced | fast (not with --model)',
    )
    .option('--deliberate', 'Force deliberation (both providers) for this call')
    .option('--no-deliberate', 'Force single-provider failover for this call')
    .option('--config <path>', 'Path to .reviewbridge.json directory')
    .option('--json', 'Raw JSON output')
    .action(async (opts) => {
      resetStdinGuard();
      const json = opts.json ?? false;
      const io = buildIO(deps, json);
      const selectors = validateSelectors(opts.session, opts.model, opts.tier);
      if (!selectors.ok) {
        io.stderr.write(`Error: ${escapeTerminalControls(selectors.error)}\n`);
        deps.exit(1);
        return;
      }

      const requestedCwd = resolveCwdOption(opts.cwd);
      if (!requestedCwd.ok) {
        io.stderr.write(`Error: ${escapeTerminalControls(requestedCwd.error)}\n`);
        deps.exit(1);
        return;
      }

      const init = initClient(opts.config, deps);
      if (!init) return;
      const { client } = init;
      if (!guardSession(init, selectors.data.session, io, deps)) return;

      // --plan is read relative to the CURRENT directory, never rebased onto
      // --cwd: the file the user typed is the file they meant.
      const inputResult = await readInput(opts.plan);
      if (!inputResult.ok) {
        io.stderr.write(`Error: ${escapeTerminalControls(inputResult.error)}\n`);
        deps.exit(1);
        return;
      }

      const prepared = await preparePlanReview(init.prep, { cwd: requestedCwd.data });
      if (!prepared.ok) {
        io.stderr.write(`Error: ${escapeTerminalControls(prepared.error)}\n`);
        deps.exit(1);
        return;
      }

      const handler = createHandler<PlanReviewResult>({
        execute: () =>
          client.reviewPlan({
            plan: inputResult.data,
            execution: prepared.data,
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
    .option('--diff <path>', 'File path or "-" for stdin')
    .option(
      '--base <ref>',
      'Review a committed range instead of --diff: the ref to diff from (e.g. main, origin/main, HEAD~1)',
    )
    .option('--head <ref>', 'The ref to diff to when --base is given (default: HEAD)')
    .option('--focus <items>', 'Comma-separated review criteria')
    .option('--session <id>', 'Resume session')
    .option('--cwd <path>', CWD_HELP)
    .option(
      '--model <name>',
      'Override the configured default model by id (e.g., gpt-5.6-sol) or "latest"',
    )
    .option(
      '--tier <name>',
      'Pick the reviewing model by capability tier: max | balanced | fast (not with --model)',
    )
    .option('--deliberate', 'Force deliberation (both providers) for this call')
    .option('--no-deliberate', 'Force single-provider failover for this call')
    .option('--config <path>', 'Path to .reviewbridge.json directory')
    .option('--json', 'Raw JSON output')
    .action(async (opts) => {
      resetStdinGuard();
      const json = opts.json ?? false;
      const io = buildIO(deps, json);
      const selectors = validateSelectors(opts.session, opts.model, opts.tier);
      if (!selectors.ok) {
        io.stderr.write(`Error: ${escapeTerminalControls(selectors.error)}\n`);
        deps.exit(1);
        return;
      }

      const requestedCwd = resolveCwdOption(opts.cwd);
      if (!requestedCwd.ok) {
        io.stderr.write(`Error: ${escapeTerminalControls(requestedCwd.error)}\n`);
        deps.exit(1);
        return;
      }

      if (opts.diff === undefined && opts.base === undefined) {
        io.stderr.write(
          `Error: ${ErrorCode.INVALID_INPUT}: pass --diff <path|-> or --base <ref> (optionally --head <ref>)\n`,
        );
        deps.exit(1);
        return;
      }

      const init = initClient(opts.config, deps);
      if (!init) return;
      const { client } = init;

      // A committed range (ISS-049): git runs in --cwd, exactly as precommit's
      // auto-capture does, and an empty range is answered without a reviewer.
      if (opts.diff === undefined) {
        const refs = validateRangeRefs(opts.base, opts.head);
        if (!refs.ok) {
          io.stderr.write(`Error: ${escapeTerminalControls(refs.error)}\n`);
          deps.exit(1);
          return;
        }
        if (!guardSession(init, selectors.data.session, io, deps)) return;
        const source = normalizeCodeDiffSource(refs.data);
        if (!source.ok) {
          io.stderr.write(`Error: ${escapeTerminalControls(source.error)}\n`);
          deps.exit(1);
          return;
        }
        const prepared = await prepareDiffReview(init.prep, {
          cwd: requestedCwd.data,
          source: source.data,
        });
        if (!prepared.ok) {
          io.stderr.write(`Error: ${escapeTerminalControls(prepared.error)}\n`);
          deps.exit(1);
          return;
        }
        if (prepared.data.kind === 'empty-capture') {
          const emptyFrom = prepared.data.capturedFrom;
          const syntheticHandler = createHandler<CodeReviewResult>({
            execute: () =>
              Promise.resolve(
                stampCapture(
                  ok<CodeReviewResult>({
                    verdict: 'approve',
                    summary: `No changes between ${refs.data.base} and ${refs.data.head} in ${escapeTerminalControls(emptyFrom)}.`,
                    findings: [],
                    session_id: selectors.data.session ?? randomUUID(),
                    models: [],
                  }),
                  emptyFrom,
                ),
              ),
            format: formatCodeResult,
            exitCode: () => 0,
          });
          await syntheticHandler(io);
          return;
        }
        const { diff, capturedFrom, execution } = prepared.data;
        const handler = createHandler<CodeReviewResult>({
          execute: async () => {
            const result = await client.reviewCode({
              diff,
              execution,
              criteria: splitCriteria(opts.focus),
              session_id: selectors.data.session,
              model: selectors.data.model,
              deliberate: opts.deliberate,
            });
            return stampCapture(result, capturedFrom);
          },
          format: formatCodeResult,
          exitCode: () => 0,
        });
        await handler(io);
        return;
      }

      // --diff is read relative to the CURRENT directory, never rebased onto --cwd.
      const inputResult = await readInput(opts.diff);
      if (!inputResult.ok) {
        io.stderr.write(`Error: ${escapeTerminalControls(inputResult.error)}\n`);
        deps.exit(1);
        return;
      }
      // An empty diff is answered without a reviewer, so it needs no workspace at
      // all — and returning here keeps the reviewed path from having to carry an
      // "execution might be missing" branch that could answer "no changes" for
      // the wrong reason.
      if (inputResult.data.trim().length === 0) {
        const syntheticHandler = createHandler<CodeReviewResult>({
          execute: () =>
            Promise.resolve(
              ok<CodeReviewResult>({
                verdict: 'approve',
                summary: 'No changes to review.',
                findings: [],
                session_id: selectors.data.session ?? randomUUID(),
                models: [],
              }),
            ),
          format: formatCodeResult,
          exitCode: () => 0,
        });
        await syntheticHandler(io);
        return;
      }
      if (!guardSession(init, selectors.data.session, io, deps)) return;

      const prepared = await prepareDiffReview(init.prep, {
        cwd: requestedCwd.data,
        source: { kind: 'explicit', diff: inputResult.data },
      });
      if (!prepared.ok) {
        io.stderr.write(`Error: ${escapeTerminalControls(prepared.error)}\n`);
        deps.exit(1);
        return;
      }
      if (prepared.data.kind !== 'ready') {
        // Unreachable: an explicit diff never auto-captures, so there is no empty
        // capture to report. Fail loudly rather than answering "no changes".
        io.stderr.write(`Error: ${ErrorCode.UNKNOWN_ERROR}: explicit diff resolved to a capture\n`);
        deps.exit(1);
        return;
      }
      const { execution } = prepared.data;

      const handler = createHandler<CodeReviewResult>({
        execute: async () => {
          const result = await client.reviewCode({
            diff: inputResult.data,
            execution,
            criteria: splitCriteria(opts.focus),
            session_id: selectors.data.session,
            model: selectors.data.model,
            deliberate: opts.deliberate,
          });
          // An explicit --diff never touches git, so there is no capture
          // location to report, and a backend-supplied one is discarded (ISS-028).
          return stampCapture(result, undefined);
        },
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
    .option('--cwd <path>', CWD_HELP)
    .option(
      '--model <name>',
      'Override the configured default model by id (e.g., gpt-5.6-sol) or "latest"',
    )
    .option(
      '--tier <name>',
      'Pick the reviewing model by capability tier: max | balanced | fast (not with --model)',
    )
    .option('--auto-diff', 'Force auto-capture of staged changes for this call')
    .option('--no-auto-diff', 'Skip auto-capture for this call')
    .option('--config <path>', 'Path to .reviewbridge.json directory')
    .option('--json', 'Raw JSON output')
    .action(async (opts) => {
      resetStdinGuard();
      const json = opts.json ?? false;
      const io = buildIO(deps, json);
      const selectors = validateSelectors(opts.session, opts.model, opts.tier);
      if (!selectors.ok) {
        io.stderr.write(`Error: ${escapeTerminalControls(selectors.error)}\n`);
        deps.exit(1);
        return;
      }

      const requestedCwd = resolveCwdOption(opts.cwd);
      if (!requestedCwd.ok) {
        io.stderr.write(`Error: ${escapeTerminalControls(requestedCwd.error)}\n`);
        deps.exit(1);
        return;
      }

      const init = initClient(opts.config, deps);
      if (!init) return;
      const { client, config } = init;

      // --diff is read relative to the CURRENT directory, never rebased onto --cwd.
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

      const source = normalizePrecommitDiffSource({ diff: explicitDiff, auto_diff: autoDiff });
      if (!source.ok) {
        io.stderr.write(`Error: ${escapeTerminalControls(source.error)}\n`);
        deps.exit(1);
        return;
      }

      const prepared = await prepareDiffReview(init.prep, {
        cwd: requestedCwd.data,
        source: source.data,
      });
      if (!prepared.ok) {
        io.stderr.write(`Error: ${escapeTerminalControls(prepared.error)}\n`);
        deps.exit(1);
        return;
      }
      if (prepared.data.kind === 'empty-capture') {
        const emptyFrom = prepared.data.capturedFrom;
        const syntheticHandler = createHandler<PrecommitResult>({
          execute: () =>
            Promise.resolve(
              stampCapture(
                ok<PrecommitResult>({
                  ready_to_commit: false,
                  blockers: [],
                  warnings: [`No staged changes found in ${escapeTerminalControls(emptyFrom)}`],
                  session_id: selectors.data.session ?? randomUUID(),
                  models: [],
                }),
                emptyFrom,
              ),
            ),
          format: formatPrecommitResult,
          exitCode: () => 2,
        });
        await syntheticHandler(io);
        return;
      }
      // Set only when git actually ran (omitted for an explicit --diff).
      const { diff, capturedFrom, execution } = prepared.data;
      if (!guardSession(init, selectors.data.session, io, deps)) return;

      const handler = createHandler<PrecommitResult>({
        execute: async () =>
          stampCapture(
            await client.reviewPrecommit({
              diff,
              execution,
              session_id: selectors.data.session,
              model: selectors.data.model,
            }),
            capturedFrom,
          ),
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
