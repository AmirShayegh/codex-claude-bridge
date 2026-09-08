import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import {
  resolveWorkspace,
  validateWorkspacePath,
  instructionsRootFor,
} from '../utils/workspace.js';
import type { ResolvedWorkspace } from '../utils/workspace.js';
import { captureDiff, NO_STAGED_CHANGES, NO_WORKING_CHANGES } from '../utils/resolve-diff.js';
import type { DiffSource } from '../utils/resolve-diff.js';
import { loadCopilotInstructions } from '../config/copilot-instructions.js';
import type { CopilotInstructions } from '../config/copilot-instructions.js';
import type { ReviewExecutionContext } from '../backends/backend.js';
import type { PreparationLimiter } from './preparation.js';
import { escapeTerminalControls } from '../utils/terminal.js';

// Everything a request needs in order to decide WHERE it runs. Built once at
// startup and shared by every tool and CLI command.
export interface RequestPreparationDeps {
  limiter: PreparationLimiter;
  // The canonical directory a request that names none is served from — the
  // server's launch directory, or the CLI's invocation directory. Captured once
  // at startup so a later process-level change cannot move it mid-session.
  defaultWorkingDirectory: string;
  // config.copilot_instructions. When false, no instruction file is ever read.
  loadInstructions: boolean;
}

// A diff review that is ready to go to a provider, or one that ended before any
// provider was needed because the capture came back empty. The empty case is a
// real, useful answer — but it is NOT a review, so it never reaches a provider
// and never reads an instruction file.
export type PreparedDiffReview =
  | {
      kind: 'ready';
      execution: ReviewExecutionContext;
      diff: string;
      capturedFrom?: string;
    }
  | { kind: 'empty-capture'; capturedFrom: string };

// Syntactic validation runs BEFORE a preparation permit is taken: rejecting a
// malformed path costs nothing and must not be able to exhaust the limiter.
function validateRequestedDirectory(
  deps: RequestPreparationDeps,
  requested: string | undefined,
): Result<string> {
  // The default is validated too: a server or CLI whose own launch directory was
  // unusable must fail with the same clear message a bad `cwd` gets, not slip a
  // blank or relative path through to git.
  return validateWorkspacePath(requested ?? deps.defaultWorkingDirectory);
}

// Read the repository's instruction files for THIS request. A hard limit
// violation fails the request; an ordinary IO failure warns and continues
// without instructions, exactly as the startup load used to.
async function loadInstructionsFor(
  deps: RequestPreparationDeps,
  workspace: ResolvedWorkspace,
): Promise<Result<CopilotInstructions | undefined>> {
  if (!deps.loadInstructions) return ok(undefined);
  // A worktree or a subdirectory still means the whole repository.
  const result = await loadCopilotInstructions(instructionsRootFor(workspace));
  if (result.ok) return ok(result.data);
  if (result.error.startsWith(`${ErrorCode.INVALID_INPUT}:`)) return err(result.error);
  console.error(
    `Copilot instructions load failed, skipping: ${escapeTerminalControls(result.error)}`,
  );
  return ok(undefined);
}

/**
 * Prepare a plan review: resolve the workspace and read instruction files.
 * There is no diff, so the provider is always called and instructions always load.
 */
export function preparePlanReview(
  deps: RequestPreparationDeps,
  args: { cwd?: string },
): Promise<Result<ReviewExecutionContext>> {
  const requested = validateRequestedDirectory(deps, args.cwd);
  if (!requested.ok) return Promise.resolve(err(requested.error));

  return runPrepared(deps, async () => {
    const workspace = await resolveWorkspace(requested.data);
    if (!workspace.ok) return err<ReviewExecutionContext>(workspace.error);
    const instructions = await loadInstructionsFor(deps, workspace.data);
    if (!instructions.ok) return err<ReviewExecutionContext>(instructions.error);
    return ok<ReviewExecutionContext>({
      workingDirectory: workspace.data.workingDirectory,
      copilotInstructions: instructions.data,
    });
  });
}

// Wall-clock bound on one preparation. Git carries its own 30-second timeout,
// so this only has to be longer than that; everything else here is local
// filesystem work that should finish in milliseconds.
const PREPARATION_TIMEOUT_MS = 60_000;

// A filesystem call against a caller-named directory can hang indefinitely — a
// dead network mount, an unresponsive FUSE filesystem — and there are only four
// permits. Without a bound, four such requests wedge the server for its whole
// lifetime.
//
// The timeout wraps the work INSIDE the permit rather than racing the permit
// itself: racing outside would resolve this call while `limiter.run` stayed
// forever awaiting the hung work, and the permit — the resource that actually
// matters — would never come back. The hung syscall itself cannot be cancelled;
// releasing the permit is what keeps the server serving.
function withTimeout<T>(work: () => Promise<Result<T>>): () => Promise<Result<T>> {
  return () =>
    new Promise<Result<T>>((resolve) => {
      const timer = setTimeout(() => {
        resolve(
          err(
            `${ErrorCode.GIT_ERROR}: preparing the review workspace timed out after ` +
              `${PREPARATION_TIMEOUT_MS / 1000}s. The directory may be on an unresponsive filesystem.`,
          ),
        );
      }, PREPARATION_TIMEOUT_MS);
      // Do not keep the process alive just to wait for this bound.
      timer.unref?.();
      work().then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (e: unknown) => {
          clearTimeout(timer);
          const detail = e instanceof Error ? e.message : String(e);
          resolve(
            err(
              `${ErrorCode.UNKNOWN_ERROR}: failed to prepare the review workspace: ` +
                escapeTerminalControls(detail),
            ),
          );
        },
      );
    });
}

// Preparation touches the filesystem, git, and a caller-named directory, so an
// unexpected throw is possible however defensively each step is written. Nothing
// downstream is prepared for one: this is the seam where a review turns into a
// Result, and the MCP server must always answer rather than surface a raw
// exception. The permit is released by the limiter's own `finally`.
async function runPrepared<T>(
  deps: RequestPreparationDeps,
  work: () => Promise<Result<T>>,
): Promise<Result<T>> {
  try {
    return await deps.limiter.run(withTimeout(work));
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    return err(
      `${ErrorCode.UNKNOWN_ERROR}: failed to prepare the review workspace: ` +
        escapeTerminalControls(detail),
    );
  }
}

function isEmptyCapture(error: string): boolean {
  return error.startsWith(`${NO_STAGED_CHANGES}:`) || error.startsWith(`${NO_WORKING_CHANGES}:`);
}

/**
 * Prepare a code or precommit review: resolve the workspace, capture the diff,
 * and only then read instruction files.
 *
 * The permit covers exactly this phase. It is released before the caller runs
 * the review, so four slow provider calls can never block a new request.
 */
export function prepareDiffReview(
  deps: RequestPreparationDeps,
  args: { cwd?: string; source: DiffSource },
): Promise<Result<PreparedDiffReview>> {
  const requested = validateRequestedDirectory(deps, args.cwd);
  if (!requested.ok) return Promise.resolve(err(requested.error));

  return runPrepared(deps, async () => {
    const workspace = await resolveWorkspace(requested.data);
    if (!workspace.ok) return err<PreparedDiffReview>(workspace.error);

    const capture = await captureDiff(args.source, workspace.data);
    if (!capture.ok) {
      if (isEmptyCapture(capture.error) && capture.capturedFrom !== undefined) {
        return ok<PreparedDiffReview>({
          kind: 'empty-capture',
          capturedFrom: capture.capturedFrom,
        });
      }
      return err<PreparedDiffReview>(capture.error);
    }

    // An empty explicit diff needs no provider either — the backend answers it
    // synthetically — so skip the instruction read for it too.
    const instructions = capture.data.trim()
      ? await loadInstructionsFor(deps, workspace.data)
      : ok<CopilotInstructions | undefined>(undefined);
    if (!instructions.ok) return err<PreparedDiffReview>(instructions.error);

    return ok<PreparedDiffReview>({
      kind: 'ready',
      execution: {
        workingDirectory: workspace.data.workingDirectory,
        copilotInstructions: instructions.data,
      },
      diff: capture.data,
      capturedFrom: capture.capturedFrom,
    });
  });
}
