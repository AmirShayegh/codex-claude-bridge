import { Codex } from '@openai/codex-sdk';
import { toJSONSchema } from 'zod';
import { discoverCodexBinary } from './codex-binary.js';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import type {
  PlanReviewResult,
  CodeReviewResult,
  PrecommitResult,
  CrossReviewResult,
  ModelIdentity,
} from '../review/types.js';
import {
  RECOMMENDED_MODELS,
  TIER_MODELS,
  isReviewTier,
  type ReviewBridgeConfig,
} from '../config/types.js';
import { estimateTokens } from '../utils/chunking.js';
import type { ReviewBackend } from './backend.js';
import {
  runPlanReview,
  runCodeReview,
  runPrecommitReview,
  runCrossReview,
  type TurnParams,
  type TurnRunner,
} from './orchestrator.js';
import { createCodexSessionObserver } from './codex-session-observer.js';
import { escapeTerminalControls } from '../utils/terminal.js';
import { subprocessEnv } from '../utils/subprocess-env.js';
import { SessionIdSchema } from '../utils/input-validation.js';

export interface CodexBackendDependencies {
  lookupSessionModel?: (sessionId: string) => ModelIdentity | null;
  observeSessionModel?: (sessionId: string) => Promise<string | undefined>;
}

function isAbortError(e: unknown): boolean {
  if (e instanceof Error) {
    return e.name === 'AbortError' || e.message.toLowerCase().includes('aborted');
  }
  return false;
}

export function classifyError(
  error: unknown,
  context?: { model?: string },
): { code: ErrorCode; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();

  // Auth: missing or invalid API key
  if (lower.includes('api_key') || lower.includes('authentication') || lower.includes('401')) {
    return {
      code: ErrorCode.AUTH_ERROR,
      message: 'No OpenAI API key found. Set OPENAI_API_KEY or run: codex login --api-key YOUR_KEY',
    };
  }

  // Model: unsupported or not found.
  // The "not (supported|found|exist)" phrase must follow "model" directly (optionally
  // with a quoted name in between). A loose substring check matched unrelated error
  // bodies that happened to contain both words, and grabbed the first quoted token
  // anywhere in the raw text as the "model name" — see ISS-001.
  const modelErrorMatch = raw.match(
    /\bmodel\b(?:\s+["'`]([^"'`]+)["'`])?\s+(?:is\s+|does\s+)?not\s+(?:supported|found|exist)/i,
  );
  if (modelErrorMatch) {
    const extracted = modelErrorMatch[1]; // the rejected model name, or undefined
    const sent = context?.model; // resolvedModel — the model this review actually sent

    // ISS-003: Codex rejected a model whose name differs from the one we sent, so
    // the failure came from a Codex-internal call (e.g. the CLI's memory-writing
    // agent, which hardcodes its own model like gpt-5.1-codex-mini), not the
    // caller's model setting. The usual model-config tips cannot fix it. Only fires
    // when both names are known AND differ; model ids are case-insensitive, so a
    // casing-only difference is the SAME model, not a mismatch.
    if (extracted && sent && extracted.toLowerCase() !== sent.toLowerCase()) {
      return {
        code: ErrorCode.MODEL_ERROR,
        message:
          `Model "${extracted}" was rejected, but the review ran with "${sent}" — ` +
          `the failure came from a Codex-internal call (e.g. the CLI's memory agent), ` +
          `not your model setting. Changing "model" in .reviewbridge.json will not fix this. ` +
          `Try updating the Codex CLI/SDK, using API-key auth (OPENAI_API_KEY) instead of ` +
          `ChatGPT-subscription auth, or the Gemini backend ("provider": "gemini"). ` +
          `Original error: ${raw}`,
      };
    }

    const modelName = extracted ?? context?.model ?? 'your configured model';
    // ChatGPT-subscription Codex auth lags API availability by a few days after
    // OpenAI announces a new flagship model. When that happens the raw error
    // explicitly mentions the ChatGPT account — surface a targeted fallback tip
    // (a different model, the Gemini backend, or API-key auth) instead of
    // leaving the user stuck.
    const isChatGptAccountLimitation = /chatgpt\s+account/i.test(raw);
    // Recommend the highest-ranked documented model OTHER than the one that
    // just failed (ISS-009). Also point at the Gemini backend as an
    // out-of-usage escape hatch.
    const altModel =
      RECOMMENDED_MODELS.codex.find(
        (candidate) => candidate.toLowerCase() !== modelName.toLowerCase(),
      ) ?? RECOMMENDED_MODELS.codex[0];
    const tip = isChatGptAccountLimitation
      ? `This model may still be rolling out to ChatGPT-tier Codex. ` +
        `Try "model": "${altModel}" in .reviewbridge.json, switch to the Gemini backend ` +
        `("provider": "gemini"), or use an API key (OPENAI_API_KEY) instead of ChatGPT subscription auth.`
      : `Try "model": "${altModel}", switch to the Gemini backend ("provider": "gemini"), ` +
        `or configure a different model in .reviewbridge.json.`;
    return {
      code: ErrorCode.MODEL_ERROR,
      message: `Model "${modelName}" is not supported. ${tip} Original error: ${raw}`,
    };
  }

  // Rate limit / usage cap. ChatGPT-tier Codex reports a hit monthly cap as
  // "You've hit your usage limit ... try again at <date>" — not a 429 — so match
  // the usage/quota wording too. Accurate classification also lets provider
  // failover treat an out-of-usage primary as retryable (ISS-008).
  if (
    lower.includes('429') ||
    lower.includes('rate_limit') ||
    lower.includes('rate limit') ||
    lower.includes('usage limit') ||
    lower.includes('quota')
  ) {
    return {
      code: ErrorCode.RATE_LIMITED,
      message: 'Rate limited or usage limit reached on the Codex provider. Wait and retry.',
    };
  }

  // Binary/process couldn't run: missing (ENOENT / "spawn codex" / findCodexPath's
  // "Unable to locate Codex CLI binaries") or killed on spawn (SIGKILL/signal) —
  // e.g. macOS XProtect quarantining the bundled binary. Not a model/auth/rate
  // fault; the provider never started, so this is failover-eligible.
  if (
    lower.includes('enoent') ||
    lower.includes('spawn codex') ||
    lower.includes('unable to locate codex') ||
    lower.includes('sigkill') ||
    lower.includes('was killed') ||
    lower.includes('killed with signal')
  ) {
    return {
      code: ErrorCode.PROVIDER_UNAVAILABLE,
      message:
        'The codex binary could not be run — it is missing, was killed, or was quarantined ' +
        '(macOS may flag it as malware and move it to Trash). Set "codex_path" (or the CODEX_PATH env) ' +
        'to a working codex, reinstall it, or switch to the Gemini backend ("provider": "gemini").',
    };
  }

  // Network
  if (
    lower.includes('fetch failed') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound')
  ) {
    return {
      code: ErrorCode.NETWORK_ERROR,
      message: 'Could not reach OpenAI API. Check your internet connection.',
    };
  }

  return { code: ErrorCode.UNKNOWN_ERROR, message: raw };
}

// Codex's default model, used when neither a per-call override nor config.model
// is set. The backend owns this default — the config schema no longer supplies one.
const CODEX_DEFAULT_MODEL = RECOMMENDED_MODELS.codex[0];

// Thread options shared by the start and resume paths. The model is handled by
// the two wrappers below: a fresh start always sets it (the orchestrator
// resolves a concrete model for every start — see startThreadOpts), while the
// resume path deliberately omits it. The SDK forwards `--model` to `codex exec`
// unconditionally whenever the field is present (see
// @openai/codex-sdk/dist/index.js:170), which would turn a resume into an
// explicit model override and may fail auth on ChatGPT-tier Codex. The bridge
// retains the prior resolved identity separately and reports any different
// runtime-observed label instead of hiding the mismatch.
//
// `workingDirectory` becomes `--cd <dir>` for the codex process and applies to a
// RESUME as well as a start, so both wrappers take it from one place: a resume
// that kept the server's directory would read a different repository than the
// start did, on the same thread.
//
// Verified against the SDK's compiled output (@openai/codex-sdk/dist/index.js),
// not assumed: `--cd <dir>` is forwarded unconditionally whenever set, built into
// the command args independently of whether a `resume <id>` subcommand is also
// appended, and `ThreadOptions` — the one type both startThread and resumeThread
// accept — draws no start/resume distinction for it. `codex exec resume --help`
// does not list --cd as a resume-specific option at all; it is a top-level
// `codex exec` flag governing where the whole invocation runs, not a server-side
// session parameter. That is structurally unlike `model`, which the SDK ALSO
// forwards unconditionally and which therefore must be omitted on resume (see
// resumeThreadOpts). Re-verify both on an SDK bump. Analysis from #7.
function baseThreadOpts(config: ReviewBridgeConfig, workingDirectory: string) {
  return {
    sandboxMode: 'read-only' as const,
    skipGitRepoCheck: true,
    modelReasoningEffort: config.reasoning_effort,
    workingDirectory,
  };
}

// A fresh thread always starts on a resolved model (the orchestrator resolves
// one — an explicit pin, config.model, or CODEX_DEFAULT_MODEL — before every
// start), so it's a required argument here rather than a defaulted fallback.
function startThreadOpts(config: ReviewBridgeConfig, model: string, workingDirectory: string) {
  return { model, ...baseThreadOpts(config, workingDirectory) };
}

function resumeThreadOpts(config: ReviewBridgeConfig, workingDirectory: string) {
  return baseThreadOpts(config, workingDirectory);
}

// Codex implementation of the orchestrator's TurnRunner: create or resume a
// Codex thread and run one prompt with schema-validated output and one retry.
async function runReview<T extends Record<string, unknown>>(
  params: TurnParams & { codex: Codex; config: ReviewBridgeConfig },
): Promise<Result<T & { session_id: string }>> {
  const {
    codex,
    config,
    prompt,
    responseSchema,
    sessionId: rawSessionId,
    model,
    resolvedModel,
    workingDirectory,
  } = params;
  let sessionId: string | undefined;
  if (rawSessionId !== undefined) {
    const parsedSessionId = SessionIdSchema.safeParse(rawSessionId);
    if (!parsedSessionId.success) {
      return err(`${ErrorCode.INVALID_INPUT}: invalid session ID`);
    }
    sessionId = parsedSessionId.data;
  }
  const startModel = model ?? resolvedModel;
  if (!sessionId && !startModel) {
    return err(`${ErrorCode.MODEL_ERROR}: no model was resolved for a fresh Codex session`);
  }

  let thread;
  try {
    if (sessionId) {
      thread = codex.resumeThread(sessionId, resumeThreadOpts(config, workingDirectory));
    } else {
      if (!startModel) return err(`${ErrorCode.MODEL_ERROR}: no model was resolved`);
      thread = codex.startThread(startThreadOpts(config, startModel, workingDirectory));
    }
  } catch (e: unknown) {
    if (sessionId) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`${ErrorCode.SESSION_NOT_FOUND}: ${msg}`);
    }
    const classified = classifyError(e, { model: resolvedModel });
    return err(`${classified.code}: ${classified.message}`);
  }

  const outputSchema = toJSONSchema(responseSchema);
  const signal = AbortSignal.timeout(config.timeout_seconds * 1000);
  let lastError: string | undefined;

  // Attempt up to 2 times (initial + 1 retry)
  for (let attempt = 0; attempt < 2; attempt++) {
    let turn;
    try {
      turn = await thread.run(prompt, { outputSchema, signal });
    } catch (e: unknown) {
      if (isAbortError(e)) {
        // If a prior attempt already produced unparseable output, the malformed
        // response — not the clock — is the actionable cause. Don't mask it as a
        // timeout (m2). A first-attempt timeout has no lastError and still
        // reports REVIEW_TIMEOUT.
        if (lastError) {
          return err(`${ErrorCode.RESPONSE_PARSE_ERROR}: ${lastError}`);
        }
        const tokenEst = estimateTokens(prompt);
        return err(
          `${ErrorCode.REVIEW_TIMEOUT}: review timed out after ${config.timeout_seconds}s ` +
            `(prompt ~${tokenEst} tokens). ` +
            `Try: increase timeout_seconds in .reviewbridge.json, reduce diff size, or check input format.`,
        );
      }
      const classified = classifyError(e, { model: resolvedModel });
      return err(`${classified.code}: ${classified.message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(turn.finalResponse);
    } catch {
      lastError = 'malformed JSON in response';
      continue;
    }

    const result = responseSchema.safeParse(parsed);
    if (!result.success) {
      lastError = result.error.message;
      continue;
    }

    const resolvedId = thread.id ?? sessionId;
    if (resolvedId === undefined || resolvedId === null) {
      return err(`${ErrorCode.RESPONSE_PARSE_ERROR}: missing session ID after successful review`);
    }
    const parsedSessionId = SessionIdSchema.safeParse(resolvedId);
    if (!parsedSessionId.success) {
      return err(
        `${ErrorCode.RESPONSE_PARSE_ERROR}: provider returned an invalid session ID after successful review`,
      );
    }
    // Single cast justified: safeParse validated result.data matches the schema
    const validated = result.data as T;
    return ok({ ...validated, session_id: parsedSessionId.data });
  }

  return err(`${ErrorCode.RESPONSE_PARSE_ERROR}: ${lastError}`);
}

export function createCodexBackend(
  config: ReviewBridgeConfig,
  runtime: CodexBackendDependencies = {},
): ReviewBackend {
  // Point the SDK at an explicit codex binary when configured (config.codex_path,
  // then the CODEX_PATH env). Escape hatch for a missing/unusable bundled binary
  // — e.g. macOS XProtect quarantining it. Undefined → the SDK's bundled binary.
  const codexPathOverride = config.codex_path ?? process.env.CODEX_PATH;
  // The codex process must not inherit the repository-selecting GIT_* variables
  // that may be set in the server's own environment: with a caller-chosen
  // directory in play, a stray GIT_DIR would silently point the reviewer at a
  // different repository than the one it was asked about. The SDK REPLACES the
  // environment when `env` is given rather than merging, so this snapshot is the
  // whole environment the child sees — PATH and credentials included.
  const env = subprocessEnv();
  let codex: Codex;
  try {
    codex = new Codex({ codexPathOverride, env });
  } catch (e: unknown) {
    const classified = classifyError(e);
    const errorMsg = `${classified.code}: SDK initialization failed: ${classified.message}`;
    return {
      provider: 'codex',
      providers: ['codex'],
      allowsModelOverrideOnResume: false,
      reviewPlan: () => Promise.resolve(err<PlanReviewResult>(errorMsg)),
      reviewCode: () => Promise.resolve(err<CodeReviewResult>(errorMsg)),
      reviewPrecommit: () => Promise.resolve(err<PrecommitResult>(errorMsg)),
      crossReview: () => Promise.resolve(err<CrossReviewResult>(errorMsg)),
    };
  }

  // ISS-021: the SDK spawns its OWN bundled codex binary, which macOS XProtect
  // false-positively quarantines — so a fresh install fails PROVIDER_UNAVAILABLE
  // even when a working system codex exists. When the caller set NO explicit
  // override, discover that system binary once and retry through the SDK's
  // codexPathOverride. An explicit codex_path/CODEX_PATH always wins and fully
  // disables discovery — never second-guess the user's pin.
  // Memoized as a shared promise so concurrent reviews that all hit the dead
  // binary await ONE discovery and all benefit from the swap, instead of the
  // losers bailing out while the winner recovers. Never rejects: any unexpected
  // throw inside discovery resolves to 'not-found' so the Result contract holds.
  let recovery: Promise<'recovered' | 'not-found'> | undefined;
  const recoverWithSystemCodex = (): Promise<'recovered' | 'not-found' | 'skipped'> => {
    if (codexPathOverride) return Promise.resolve('skipped');
    recovery ??= (async () => {
      try {
        const found = await discoverCodexBinary();
        if (!found) return 'not-found';
        // A FRESH snapshot: the SDK mutates the env object it is handed, so
        // reusing the failed client's object would carry its mutations over.
        codex = new Codex({ codexPathOverride: found, env: subprocessEnv() });
        console.error(
          `[codex-bridge] bundled codex binary is unusable (macOS XProtect may have quarantined it); ` +
            `using discovered ${escapeTerminalControls(found)}. Pin it explicitly with "codex_path" in .reviewbridge.json to silence this.`,
        );
        return 'recovered';
      } catch {
        return 'not-found';
      }
    })();
    return recovery;
  };

  const turn: TurnRunner = async <T extends Record<string, unknown>>(params: TurnParams) => {
    const result = await runReview<T>({ ...params, codex, config });
    if (result.ok || !result.error.startsWith(ErrorCode.PROVIDER_UNAVAILABLE)) return result;
    const outcome = await recoverWithSystemCodex();
    // `codex` was rebound to the discovered binary — rebuild params from it.
    if (outcome === 'recovered') return runReview<T>({ ...params, codex, config });
    if (outcome === 'not-found') {
      return err(
        `${result.error} (auto-discovery: no working system codex found on PATH or in known install locations)`,
      );
    }
    return result;
  };
  // Codex's SDK reasserts --model when supplied on resume, so callers cannot
  // request a model change mid-session. Omit it and let evidence metadata expose
  // whether the runtime actually retained or changed the recorded label.
  const sessionObserver = createCodexSessionObserver();
  const deps = {
    config,
    provider: 'codex' as const,
    allowsModelOverrideOnResume: false,
    // 'latest' (and unset) → the latest model the SDK-PINNED binary supports. We
    // deliberately do NOT chase the newest announced model — that bundled-binary
    // mismatch is the L-008 trap. CODEX_DEFAULT_MODEL moves only when the SDK pin
    // moves. An explicit pin is forwarded unchanged (L-006).
    resolveModel: async (requested: string | undefined) => {
      if (isReviewTier(requested)) return TIER_MODELS.codex[requested];
      return requested && requested !== 'latest' ? requested : CODEX_DEFAULT_MODEL;
    },
    lookupSessionModel: runtime.lookupSessionModel,
    observeSessionModel:
      runtime.observeSessionModel ??
      (async (sessionId: string) => (await sessionObserver.observe(sessionId))?.model),
    // One Codex thread per review: chunks 2..N resume chunk 1's thread.
    resumesAcrossChunks: true,
  };

  return {
    provider: 'codex',
    providers: ['codex'],
    allowsModelOverrideOnResume: deps.allowsModelOverrideOnResume,
    reviewPlan: (input) => runPlanReview(input, deps, turn),
    reviewCode: (input) => runCodeReview(input, deps, turn),
    reviewPrecommit: (input) => runPrecommitReview(input, deps, turn),
    crossReview: (input) => runCrossReview(input, deps, turn),
  };
}
