import { spawn } from 'node:child_process';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';

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
