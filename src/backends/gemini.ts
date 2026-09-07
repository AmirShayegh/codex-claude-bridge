import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import type { ReviewBridgeConfig } from '../config/types.js';
import { RECOMMENDED_MODELS, TIER_MODELS, isReviewTier } from '../config/types.js';
import { escapeTerminalControls } from '../utils/terminal.js';
import { subprocessEnv } from '../utils/subprocess-env.js';
import { SessionIdSchema } from '../utils/input-validation.js';
import type { ReviewBackend } from './backend.js';
import {
  runPlanReview,
  runCodeReview,
  runPrecommitReview,
  runCrossReview,
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

// Cap on how much output we buffer from an agy subprocess. Review responses are
// small JSON; a multi-megabyte stream means agy is looping or misbehaving, and
// accumulating it unbounded would grow memory until OOM. Measured in string
// length (chars), which is close enough to bytes for a safety valve.
const MAX_AGY_OUTPUT_CHARS = 10 * 1024 * 1024; // ~10 MB

// agy's --print takes the prompt as its VALUE. Linux caps one argv string at
// 128 KiB (MAX_ARG_STRLEN); a spawn over that fails with an opaque E2BIG, so it
// is checked here with a message that names the cause. Prompts are bounded by
// max_chunk_tokens plus instruction files, and only approach this with very
// large instruction trees.
export const MAX_AGY_PROMPT_BYTES = 120 * 1024;

export interface AgyPrintOptions {
  // The full review prompt. Passed as the value of --print: agy 1.1.27+ binds
  // the prompt to that flag and no longer reads it from stdin.
  prompt: string;
  // Resolved agy model string, e.g. "Gemini 3.5 Flash (Medium)".
  model: string;
  // When set, resume this agy conversation instead of starting a fresh one.
  conversationId?: string;
  // Working directory for the run (agy keys conversations by cwd).
  cwd: string;
  timeoutMs: number;
}

// Run one `agy --sandbox … --print <prompt>` invocation and return its stdout.
// Never throws: spawn failures, non-zero exits, and timeouts all resolve to a
// structured error Result. An exit-0 empty stdout resolves to ok('') so the
// caller's parse-retry loop treats it like a malformed response.
//
// Argument ORDER is load-bearing. `--print` consumes the very next argument as
// the prompt, so it must come last: `--print --sandbox …` made agy take
// "--sandbox" as the prompt and drop the real one, and because this path only
// runs as the failover when the primary is rate-limited, every such review
// failed with no reviewer at all.
export function runAgyPrint(opts: AgyPrintOptions): Promise<Result<string>> {
  const promptBytes = Buffer.byteLength(opts.prompt, 'utf-8');
  if (promptBytes > MAX_AGY_PROMPT_BYTES) {
    return Promise.resolve(
      err(
        `${ErrorCode.INVALID_INPUT}: review prompt is ${promptBytes} bytes, over the ` +
          `${MAX_AGY_PROMPT_BYTES}-byte limit agy accepts on its command line. ` +
          `Lower max_chunk_tokens or trim repository instruction files.`,
      ),
    );
  }
  const args = ['--sandbox', '--model', opts.model];
  if (opts.conversationId) args.push('--conversation', opts.conversationId);
  args.push('--print', opts.prompt);

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
      child = spawn('agy', args, {
        cwd: opts.cwd,
        // A fresh environment per spawn, with the repository-selecting GIT_*
        // variables stripped. PWD is set to match `cwd` because agy keys its
        // conversation cache by workspace path: an inherited PWD naming the
        // SERVER's directory would file this review's id under the wrong key,
        // and the capture below would then miss it.
        env: { ...subprocessEnv(), PWD: opts.cwd },
        signal: controller.signal,
      });
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      const classified = classifyAgyError(raw);
      finish(err(`${classified.code}: ${classified.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    // Abort and fail if the combined output blows past the cap, rather than
    // buffering an unbounded stream into memory. finish() before abort() so this
    // error wins over the AbortError the abort would otherwise surface.
    const overflow = (): void => {
      finish(
        err(
          `${ErrorCode.UNKNOWN_ERROR}: agy produced more than ${MAX_AGY_OUTPUT_CHARS} bytes of output; ` +
            `aborted to bound memory. This usually means agy is looping or emitting non-JSON.`,
        ),
      );
      controller.abort();
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length + stderr.length > MAX_AGY_OUTPUT_CHARS) overflow();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stdout.length + stderr.length > MAX_AGY_OUTPUT_CHARS) overflow();
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

    // The prompt travels on argv, so stdin only needs EOF — agy reads it and
    // would otherwise wait. agy may already have closed its read end (fast-fail
    // paths like a bad model/auth), surfacing EPIPE as an 'error' on the stdin
    // Writable; an unhandled Writable 'error' is an uncaught exception that
    // would crash the MCP server, so it is swallowed — the real failure is
    // reported via the child 'error'/'close'/timeout handlers above.
    child.stdin?.on('error', () => {});
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
    const parsed = SessionIdSchema.safeParse(id);
    return parsed.success ? parsed.data : undefined;
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

// agy's default model, and the SAFE FALLBACK whenever `latest` resolution can't
// produce a concrete id (agy missing, `agy models` unparseable, etc.). Owned by
// the backend (the config schema carries no default). Effort is part of the
// model string for agy, so reasoning_effort is not applied here. Mirrors
// RECOMMENDED_MODELS.gemini[0].
const GEMINI_DEFAULT_MODEL = 'Gemini 3.5 Flash (Medium)';

// `agy models` is a quick metadata call; bound it well under a review timeout so
// a hung query degrades to the fallback fast.
const MODEL_QUERY_TIMEOUT_MS = 15_000;
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
let modelCatalogCache: { output: string | null; expiresAt: number } | undefined;
let modelCatalogInFlight: Promise<string | null> | undefined;

// `latest` for gemini means the newest Flash, at the same effort tier we default
// to where available. Flash is the fast review line; Pro is a heavier, separate
// line, so `latest` stays within Flash (acceptance: "resolves to a current
// Flash"). Tier preference falls back down the list if the newest version omits
// the preferred tier.
const FLASH_LINE_RE = /^Gemini\s+(\d+(?:\.\d+)*)\s+Flash\s*\(([^)]+)\)$/i;
const TIER_PREFERENCE = ['medium', 'high', 'low'];

// Compare dotted version strings numerically component-by-component so 3.10 sorts
// above 3.5 (a naive parseFloat would read 3.10 as 3.1). Returns >0 when a > b.
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Pick the newest Gemini Flash model from raw `agy models` output (one model per
// line). Returns the exact model string agy listed (so it round-trips back as
// --model), or null when no Flash line is present.
export function pickLatestFlashModel(modelsOutput: string): string | null {
  const flashes: { version: string; tier: string; raw: string }[] = [];
  for (const line of modelsOutput.split('\n')) {
    const trimmed = line.trim();
    const m = FLASH_LINE_RE.exec(trimmed);
    if (m) flashes.push({ version: m[1], tier: m[2].trim().toLowerCase(), raw: trimmed });
  }
  if (flashes.length === 0) return null;

  flashes.sort((a, b) => compareVersions(b.version, a.version));
  const newestVersion = flashes[0].version;
  const newest = flashes.filter((f) => compareVersions(f.version, newestVersion) === 0);

  for (const tier of TIER_PREFERENCE) {
    const match = newest.find((f) => f.tier === tier);
    if (match) return match.raw;
  }
  return newest[0].raw;
}

// Query `agy models` for the available model list. Returns raw stdout, or null on
// spawn failure / non-zero exit / timeout / empty output — callers fall back to a
// known-good model. Never throws.
export function runAgyModels(timeoutMs: number = MODEL_QUERY_TIMEOUT_MS): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let settled = false;
    const finish = (r: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    let child;
    try {
      child = spawn('agy', ['models'], { env: subprocessEnv(), signal: controller.signal });
    } catch {
      finish(null);
      return;
    }

    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      // `agy models` output is a short list; a runaway stream degrades to the
      // fallback (null) rather than buffering unbounded.
      if (stdout.length > MAX_AGY_OUTPUT_CHARS) {
        finish(null);
        controller.abort();
      }
    });
    child.on('error', () => finish(null));
    child.on('close', (code: number | null) => {
      finish(code === 0 && stdout.trim() ? stdout : null);
    });

    // agy reads stdin even for `models`; close it so the process gets EOF and
    // exits instead of blocking until the timeout. Swallow any EPIPE on the
    // close (see runAgyPrint) so it can never crash the server.
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
}

async function getAgyModelCatalog(timeoutMs?: number): Promise<string | null> {
  const now = Date.now();
  if (modelCatalogCache && modelCatalogCache.expiresAt > now) {
    return modelCatalogCache.output;
  }
  if (modelCatalogInFlight) return modelCatalogInFlight;

  modelCatalogInFlight = runAgyModels(timeoutMs).then((output) => {
    // Cache unavailable catalogs too. Otherwise a missing or unhealthy agy
    // binary would spawn another bounded metadata process for every review,
    // defeating the process-wide five-minute catalog cache.
    modelCatalogCache = { output, expiresAt: Date.now() + MODEL_CATALOG_TTL_MS };
    return output;
  });
  try {
    return await modelCatalogInFlight;
  } finally {
    modelCatalogInFlight = undefined;
  }
}

export function clearGeminiModelCatalogCache(): void {
  modelCatalogCache = undefined;
  modelCatalogInFlight = undefined;
}

// Resolve gemini's `latest`: the newest Flash from `agy models`, degrading to the
// known-good fallback if the query fails or yields no parseable Flash line.
export async function resolveLatestGeminiModel(timeoutMs?: number): Promise<string> {
  const output = await getAgyModelCatalog(timeoutMs);
  if (!output) return GEMINI_DEFAULT_MODEL;
  return pickLatestFlashModel(output) ?? GEMINI_DEFAULT_MODEL;
}

// agy lists one concrete model per line (e.g. "Gemini 3.5 Flash (Medium)").
export function parseAgyModels(output: string): string[] {
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// Compare model names tolerant of case/whitespace so a warning only fires on a
// genuine mismatch, not a cosmetic one.
function normalizeModelName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isRecommendedGeminiModel(model: string): boolean {
  const norm = normalizeModelName(model);
  return RECOMMENDED_MODELS.gemini.some((m) => normalizeModelName(m) === norm);
}

// agy silently runs a fallback for an unknown `--model` (exit 0, no error) — so a
// typo'd pin would review on the wrong model unnoticed (ISS-006). For an explicit
// pin outside our known-good set, validate it against `agy models` and warn on a
// miss. Non-blocking: we still forward the user's model as-is (L-006). Stays silent
// when the model list is unavailable (can't validate → no false alarm).
export async function warnIfUnknownModel(requested: string): Promise<void> {
  const output = await getAgyModelCatalog();
  if (!output) return;
  const known = parseAgyModels(output).map(normalizeModelName);
  if (!known.includes(normalizeModelName(requested))) {
    console.error(
      `[codex-bridge] warning: model "${escapeTerminalControls(requested)}" is not in agy's model list ` +
        `(run \`agy models\` to see options). agy may silently run a different model.`,
    );
  }
}

// Gemini implementation of the orchestrator's TurnRunner: run one prompt through
// agy and return the schema-validated result plus the session (conversation) id.
// Mirrors the Codex runReview shape — parse-then-retry on malformed/empty output
// — but the model call is a subprocess and the session id comes from agy's cache.
async function runAgyReview<T extends Record<string, unknown>>(
  params: TurnParams & { config: ReviewBridgeConfig; cwd: string },
): Promise<Result<T & { session_id: string }>> {
  const { prompt, responseSchema, sessionId: rawSessionId, resolvedModel, config, cwd } = params;
  let sessionId: string | undefined;
  if (rawSessionId !== undefined) {
    const parsedSessionId = SessionIdSchema.safeParse(rawSessionId);
    if (!parsedSessionId.success) {
      return err<T & { session_id: string }>(`${ErrorCode.INVALID_INPUT}: invalid session ID`);
    }
    sessionId = parsedSessionId.data;
  }
  if (!resolvedModel) {
    return err<T & { session_id: string }>(
      `${ErrorCode.MODEL_ERROR}: no model was resolved for the Gemini review`,
    );
  }
  // One shared deadline across both attempts (total budget), mirroring Codex's
  // single AbortSignal.timeout — a fresh per-attempt timeout would grant up to
  // ~2× timeout_seconds of wall-clock (m2).
  const deadline = Date.now() + config.timeout_seconds * 1000;

  // Serialize the whole run+capture so concurrent same-cwd reviews can't race on
  // the id cache.
  return runSerialized(async () => {
    let lastError: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      // The retry gets only the budget remaining after attempt 1 (floored at 1ms
      // so setTimeout never goes negative — an exhausted budget aborts at once).
      const timeoutMs = Math.max(deadline - Date.now(), 1);
      const run = await runAgyPrint({
        prompt,
        model: resolvedModel,
        conversationId: sessionId,
        cwd,
        timeoutMs,
      });
      if (!run.ok) {
        // A retry that timed out AFTER a prior parse failure: the malformed
        // response — not the clock — is the actionable cause, so surface it as a
        // parse error (m2). Every other process failure (auth/model/rate/network,
        // or a first-attempt timeout with no prior parse failure) is already
        // classified and surfaces as itself.
        if (lastError && run.error.startsWith(`${ErrorCode.REVIEW_TIMEOUT}:`)) {
          return err<T & { session_id: string }>(`${ErrorCode.RESPONSE_PARSE_ERROR}: ${lastError}`);
        }
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
      //
      // Cross-directory resume safety: this cwd-keyed cache lookup is reachable
      // ONLY on the fresh branch — `??` short-circuits it whenever sessionId is
      // present, so a resumed call always returns the caller's OWN id verbatim
      // and the cache can never substitute a different one. A resume can't
      // silently fork through this mechanism, whatever cwd accompanies it.
      // A resume DOES still run agy in whatever directory THIS call names while
      // continuing conversation `sessionId`; if that differs from where the
      // session started, the review's content may be incoherent with the
      // conversation's history — the same caller-coherence concern as passing
      // an unrelated diff to a resumed session, not an identity one. That is
      // why callers must repeat cwd on resume. Analysis from #7.
      const resolvedId = sessionId ?? readConversationId(cwd);
      if (!resolvedId) {
        // The review itself parsed fine — this is a storage read failure (agy's
        // conversation-id cache is missing/unreadable), not a parse error. A
        // STORAGE_ERROR is accurate and actionable; RESPONSE_PARSE_ERROR would
        // wrongly imply a malformed model response the caller should retry.
        return err<T & { session_id: string }>(
          `${ErrorCode.STORAGE_ERROR}: agy review succeeded but no conversation id was captured for ` +
            `"${escapeTerminalControls(cwd)}". ` +
            `Check that ~/.gemini/antigravity-cli is readable.`,
        );
      }
      const parsedSessionId = SessionIdSchema.safeParse(resolvedId);
      if (!parsedSessionId.success) {
        return err<T & { session_id: string }>(
          `${ErrorCode.STORAGE_ERROR}: agy review succeeded but captured an invalid conversation id. ` +
            `Check that ~/.gemini/antigravity-cli is readable.`,
        );
      }
      // Single cast justified: safeParse validated result.data matches the schema.
      return ok({ ...(result.data as T), session_id: parsedSessionId.data });
    }
    return err<T & { session_id: string }>(`${ErrorCode.RESPONSE_PARSE_ERROR}: ${lastError}`);
  });
}

export function createGeminiBackend(config: ReviewBridgeConfig): ReviewBackend {
  // agy carries reasoning effort in the model name (e.g. "... (High)"), so the
  // config's reasoning_effort has no effect here — codex applies it, gemini
  // can't. Surface a one-time startup notice when it's set to a non-default
  // value so the setting isn't silently dropped (m3). Default 'medium' stays
  // quiet to avoid noise on every gemini startup.
  if (config.reasoning_effort !== 'medium') {
    console.error(
      `[codex-bridge] note: reasoning_effort "${escapeTerminalControls(config.reasoning_effort)}" is ignored by the Gemini backend — ` +
        `effort is part of the agy model name (e.g. "Gemini 3.5 Flash (High)"). Pin a higher-effort model instead.`,
    );
  }

  // The run directory comes from the REQUEST, never from the server's own
  // process. agy keys its conversation cache by workspace path, so using
  // process.cwd() here would both review the wrong tree and look the resulting
  // conversation id up under the wrong key.
  const turn: TurnRunner = <T extends Record<string, unknown>>(params: TurnParams) =>
    runAgyReview<T>({ ...params, config, cwd: params.workingDirectory });
  const deps = {
    config,
    provider: 'gemini' as const,
    // agy accepts a model on resume (nothing reasserts it), and persists each
    // conversation natively — so chunks review independently (resumesAcrossChunks
    // false) to avoid resending a growing transcript per chunk.
    allowsModelOverrideOnResume: true,
    // 'latest' (and unset) → the newest Flash from `agy models`, with a safe
    // fallback to the known-good default. An explicit pin is forwarded unchanged
    // (L-006); if it's outside our known-good set we validate it against
    // `agy models` and warn on a miss, since agy silently substitutes for an
    // unknown model (ISS-006). Recommended pins are known-good → skip the query.
    resolveModel: async (requested: string | undefined) => {
      if (isReviewTier(requested)) return TIER_MODELS.gemini[requested];
      if (!requested || requested === 'latest') return resolveLatestGeminiModel();
      if (!isRecommendedGeminiModel(requested)) await warnIfUnknownModel(requested);
      return requested;
    },
    resumesAcrossChunks: false,
  };

  return {
    provider: 'gemini',
    providers: ['gemini'],
    allowsModelOverrideOnResume: deps.allowsModelOverrideOnResume,
    reviewPlan: (input) => runPlanReview(input, deps, turn),
    reviewCode: (input) => runCodeReview(input, deps, turn),
    reviewPrecommit: (input) => runPrecommitReview(input, deps, turn),
    crossReview: (input) => runCrossReview(input, deps, turn),
  };
}
