import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import type { ReviewBridgeConfig } from '../config/types.js';
import type { CopilotInstructions } from '../config/copilot-instructions.js';
import type { ReviewBackend } from './backend.js';
import {
  runPlanReview,
  runCodeReview,
  runPrecommitReview,
  type TurnParams,
  type TurnRunner,
} from './orchestrator.js';

// Gemini backend (Path A): wraps the Antigravity `agy` CLI in headless print
// mode. agy uses the user's Google AI Pro subscription ($0 marginal) and
// persists conversations natively, so its conversation id maps onto the bridge's
// session_id contract without a local history store. agy is an autonomous agent
// (it will write code if unconstrained — see L-010), so every run is sandboxed
// and read-only with a tight, self-contained review prompt.

// Map a raw agy failure message to a structured, provider-neutral error. agy
// failures arrive as process stderr or a spawn error; we never throw.
export function classifyAgyError(raw: string): { code: ErrorCode; message: string } {
  const text = raw.trim();
  const lower = text.toLowerCase();

  // agy binary missing from PATH
  if (lower.includes('enoent') || lower.includes('spawn agy')) {
    return {
      code: ErrorCode.CONFIG_ERROR,
      message:
        "The 'agy' (Antigravity) CLI was not found on PATH. Install it and sign in with your Google " +
        'account, or set "provider": "codex" in .reviewbridge.json.',
    };
  }

  // Auth / not signed in
  if (
    lower.includes('not authenticated') ||
    lower.includes('unauthenticated') ||
    lower.includes('not logged in') ||
    lower.includes('sign in') ||
    lower.includes('please log in')
  ) {
    return {
      code: ErrorCode.AUTH_ERROR,
      message:
        'agy is not authenticated. Run `agy` once to sign in with your Google account (AI Pro), then retry.',
    };
  }

  // Model not available
  if (
    lower.includes('model') &&
    (lower.includes('not available') ||
      lower.includes('not found') ||
      lower.includes('unknown') ||
      lower.includes('unsupported') ||
      lower.includes('invalid model'))
  ) {
    return {
      code: ErrorCode.MODEL_ERROR,
      message:
        `Model not available in agy. Run \`agy models\` to list options, or set a different "model" ` +
        `in .reviewbridge.json. Original error: ${text}`,
    };
  }

  // Rate limit / quota
  if (
    lower.includes('rate limit') ||
    lower.includes('429') ||
    lower.includes('quota') ||
    lower.includes('resource exhausted')
  ) {
    return {
      code: ErrorCode.RATE_LIMITED,
      message: 'Rate limited or quota exhausted by the Gemini backend. Wait a moment and retry.',
    };
  }

  // Network
  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('etimedout') ||
    lower.includes('network') ||
    lower.includes('connection refused')
  ) {
    return {
      code: ErrorCode.NETWORK_ERROR,
      message: 'Could not reach the Gemini backend. Check your internet connection.',
    };
  }

  return { code: ErrorCode.UNKNOWN_ERROR, message: text || 'agy failed with no output.' };
}

export interface AgyPrintOptions {
  // The full review prompt, piped to agy via stdin (avoids argv length limits
  // for large diffs).
  prompt: string;
  // Resolved agy model string, e.g. "Gemini 3.5 Flash (Medium)".
  model: string;
  // When set, resume this agy conversation instead of starting a fresh one.
  conversationId?: string;
  // Working directory for the run (agy keys conversations by cwd).
  cwd: string;
  timeoutMs: number;
}

// Run one `agy --print --sandbox` invocation and return its stdout. Never
// throws: spawn failures, non-zero exits, and timeouts all resolve to a
// structured error Result. An exit-0 empty stdout resolves to ok('') so the
// caller's parse-retry loop treats it like a malformed response.
export function runAgyPrint(opts: AgyPrintOptions): Promise<Result<string>> {
  const args = ['--print', '--sandbox', '--model', opts.model];
  if (opts.conversationId) args.push('--conversation', opts.conversationId);

  return new Promise<Result<string>>((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    let settled = false;
    const finish = (r: Result<string>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timedOut = (): Result<string> =>
      err(
        `${ErrorCode.REVIEW_TIMEOUT}: agy review timed out after ${Math.round(opts.timeoutMs / 1000)}s. ` +
          `Increase timeout_seconds in .reviewbridge.json, or reduce the diff size.`,
      );

    let child;
    try {
      child = spawn('agy', args, { cwd: opts.cwd, signal: controller.signal });
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      const classified = classifyAgyError(raw);
      finish(err(`${classified.code}: ${classified.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (e: Error) => {
      if (controller.signal.aborted) {
        finish(timedOut());
        return;
      }
      const classified = classifyAgyError(e.message);
      finish(err(`${classified.code}: ${classified.message}`));
    });

    child.on('close', (code: number | null) => {
      if (controller.signal.aborted) {
        finish(timedOut());
        return;
      }
      if (code !== 0) {
        const classified = classifyAgyError(stderr || stdout);
        finish(err(`${classified.code}: ${classified.message}`));
        return;
      }
      finish(ok(stdout));
    });

    child.stdin?.write(opts.prompt);
    child.stdin?.end();
  });
}

function conversationCachePath(): string {
  return join(homedir(), '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json');
}

// agy records the most recent conversation id per workspace path. After a fresh
// `--print` run we read it back to capture the new session's id — agy's native
// persistence means no local history store is needed. Returns undefined if the
// cache is missing, malformed, or has no entry for cwd.
export function readConversationId(cwd: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(conversationCachePath(), 'utf-8');
  } catch {
    return undefined;
  }
  try {
    const map = JSON.parse(content) as Record<string, unknown>;
    const id = map[cwd];
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

// last_conversations.json is keyed by workspace path, so two concurrent fresh
// runs in the same cwd would race on id capture. Serialize the run+capture
// critical section through a process-global chain so captures can't interleave.
// Documented limitation: this serializes same-process Gemini reviews; it does
// not guard against a separate agy process writing the same cwd entry.
let serialChain: Promise<unknown> = Promise.resolve();
export function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const result = serialChain.then(fn);
  // Keep the chain alive regardless of outcome so one failure can't wedge it.
  serialChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// agy is prompted to emit raw JSON, but an autonomous agent occasionally wraps
// it in a markdown code fence anyway. Strip one fence defensively before
// parsing; anything still unparseable falls through to the retry loop.
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

// agy's default model. Owned by the backend (the config schema carries no
// default). Effort is part of the model string for agy, so reasoning_effort is
// not applied here. Mirrors RECOMMENDED_MODELS.gemini[0].
const GEMINI_DEFAULT_MODEL = 'Gemini 3.5 Flash (Medium)';

// Gemini implementation of the orchestrator's TurnRunner: run one prompt through
// agy and return the schema-validated result plus the session (conversation) id.
// Mirrors the Codex runReview shape — parse-then-retry on malformed/empty output
// — but the model call is a subprocess and the session id comes from agy's cache.
async function runAgyReview<T extends Record<string, unknown>>(
  params: TurnParams & { config: ReviewBridgeConfig; cwd: string },
): Promise<Result<T & { session_id: string }>> {
  const { prompt, responseSchema, sessionId, resolvedModel, config, cwd } = params;
  const timeoutMs = config.timeout_seconds * 1000;

  // Serialize the whole run+capture so concurrent same-cwd reviews can't race on
  // the id cache.
  return runSerialized(async () => {
    let lastError: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const run = await runAgyPrint({ prompt, model: resolvedModel, conversationId: sessionId, cwd, timeoutMs });
      if (!run.ok) {
        // Process-level failure (auth/model/rate/network/timeout) — already
        // classified, not retryable here.
        return err<T & { session_id: string }>(run.error);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stripCodeFences(run.data));
      } catch {
        lastError = 'malformed or empty JSON in agy response';
        continue;
      }
      const result = responseSchema.safeParse(parsed);
      if (!result.success) {
        lastError = result.error.message;
        continue;
      }

      // Resume → reuse the conversation we resumed; fresh → capture the new id
      // agy just recorded for this cwd.
      const resolvedId = sessionId ?? readConversationId(cwd);
      if (!resolvedId) {
        return err<T & { session_id: string }>(
          `${ErrorCode.RESPONSE_PARSE_ERROR}: agy review succeeded but no conversation id was captured for ${cwd}. ` +
            `Check that ~/.gemini/antigravity-cli is readable.`,
        );
      }
      // Single cast justified: safeParse validated result.data matches the schema.
      return ok({ ...(result.data as T), session_id: resolvedId });
    }
    return err<T & { session_id: string }>(`${ErrorCode.RESPONSE_PARSE_ERROR}: ${lastError}`);
  });
}

export function createGeminiBackend(
  config: ReviewBridgeConfig,
  copilotInstructions?: CopilotInstructions,
): ReviewBackend {
  const turn: TurnRunner = <T extends Record<string, unknown>>(params: TurnParams) =>
    runAgyReview<T>({ ...params, config, cwd: process.cwd() });
  const deps = {
    config,
    copilotInstructions,
    // agy accepts a model on resume (nothing reasserts it), and persists each
    // conversation natively — so chunks review independently (resumesAcrossChunks
    // false) to avoid resending a growing transcript per chunk.
    allowsModelOverrideOnResume: true,
    defaultModel: GEMINI_DEFAULT_MODEL,
    resumesAcrossChunks: false,
  };

  return {
    reviewPlan: (input) => runPlanReview(input, deps, turn),
    reviewCode: (input) => runCodeReview(input, deps, turn),
    reviewPrecommit: (input) => runPrecommitReview(input, deps, turn),
  };
}
