import { Codex } from '@openai/codex-sdk';
import { toJSONSchema } from 'zod';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import type {
  PlanReviewResult,
  CodeReviewResult,
  PrecommitResult,
  CrossReviewResult,
} from '../review/types.js';
import type { ReviewBridgeConfig } from '../config/types.js';
import { estimateTokens } from '../utils/chunking.js';
import type { CopilotInstructions } from '../config/copilot-instructions.js';
import type { ReviewBackend } from './backend.js';
import {
  runPlanReview,
  runCodeReview,
  runPrecommitReview,
  runCrossReview,
  type TurnParams,
  type TurnRunner,
} from './orchestrator.js';

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
    const modelName = modelErrorMatch[1] ?? context?.model ?? 'your configured model';
    // ChatGPT-subscription Codex auth lags API availability by a few days after
    // OpenAI announces a new flagship model. When that happens the raw error
    // explicitly mentions the ChatGPT account — surface a targeted fallback tip
    // (a different model, the Gemini backend, or API-key auth) instead of
    // leaving the user stuck.
    const isChatGptAccountLimitation = /chatgpt\s+account/i.test(raw);
    // Recommend a model OTHER than the one that just failed. The old tip
    // hardcoded gpt-5.4, so a failing gpt-5.4 was told to "fall back to gpt-5.4"
    // (ISS-009). Also point at the Gemini backend as an out-of-usage escape hatch.
    const altModel = modelName === 'gpt-5.5' ? 'gpt-5.4' : 'gpt-5.5';
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
  if (lower.includes('fetch failed') || lower.includes('econnrefused') || lower.includes('enotfound')) {
    return {
      code: ErrorCode.NETWORK_ERROR,
      message: 'Could not reach OpenAI API. Check your internet connection.',
    };
  }

  return { code: ErrorCode.UNKNOWN_ERROR, message: raw };
}

// Codex's default model, used when neither a per-call override nor config.model
// is set. The backend owns this default — the config schema no longer supplies one.
const CODEX_DEFAULT_MODEL = 'gpt-5.5';

// Thread options shared by the start and resume paths. The model is handled by
// the two wrappers below: a fresh start always sets it (the orchestrator
// resolves a concrete model for every start — see startThreadOpts), while the
// resume path deliberately omits it. The SDK forwards `--model` to `codex exec`
// unconditionally whenever the field is present (see
// @openai/codex-sdk/dist/index.js:170), which would reassert a model on resume
// and either break a thread created with an override or fail auth on
// ChatGPT-tier Codex if the new model isn't available there. A resumed thread
// keeps whatever model it was started with.
function baseThreadOpts(config: ReviewBridgeConfig) {
  return {
    sandboxMode: 'read-only' as const,
    skipGitRepoCheck: true,
    modelReasoningEffort: config.reasoning_effort,
  };
}

// A fresh thread always starts on a resolved model (the orchestrator resolves
// one — an explicit pin, config.model, or CODEX_DEFAULT_MODEL — before every
// start), so it's a required argument here rather than a defaulted fallback.
function startThreadOpts(config: ReviewBridgeConfig, model: string) {
  return { model, ...baseThreadOpts(config) };
}

function resumeThreadOpts(config: ReviewBridgeConfig) {
  return baseThreadOpts(config);
}

// Codex implementation of the orchestrator's TurnRunner: create or resume a
// Codex thread and run one prompt with schema-validated output and one retry.
async function runReview<T extends Record<string, unknown>>(
  params: TurnParams & { codex: Codex; config: ReviewBridgeConfig },
): Promise<Result<T & { session_id: string }>> {
  const { codex, config, prompt, responseSchema, sessionId, model, resolvedModel } = params;

  let thread;
  try {
    thread = sessionId
      ? codex.resumeThread(sessionId, resumeThreadOpts(config))
      : codex.startThread(startThreadOpts(config, model ?? resolvedModel));
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
    if (!resolvedId) {
      return err(`${ErrorCode.RESPONSE_PARSE_ERROR}: missing session ID after successful review`);
    }
    // Single cast justified: safeParse validated result.data matches the schema
    const validated = result.data as T;
    return ok({ ...validated, session_id: resolvedId });
  }

  return err(`${ErrorCode.RESPONSE_PARSE_ERROR}: ${lastError}`);
}

export function createCodexBackend(
  config: ReviewBridgeConfig,
  copilotInstructions?: CopilotInstructions,
): ReviewBackend {
  // Point the SDK at an explicit codex binary when configured (config.codex_path,
  // then the CODEX_PATH env). Escape hatch for a missing/unusable bundled binary
  // — e.g. macOS XProtect quarantining it. Undefined → the SDK's bundled binary.
  const codexPathOverride = config.codex_path ?? process.env.CODEX_PATH;
  let codex: Codex;
  try {
    codex = new Codex({ codexPathOverride });
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

  const turn: TurnRunner = <T extends Record<string, unknown>>(params: TurnParams) =>
    runReview<T>({ ...params, codex, config });
  // Codex's SDK reasserts --model on resume, so the model cannot change
  // mid-session: reject session_id + model and omit the model on resumed chunks.
  const deps = {
    config,
    copilotInstructions,
    allowsModelOverrideOnResume: false,
    // 'latest' (and unset) → the latest model the SDK-PINNED binary supports. We
    // deliberately do NOT chase the newest announced model — that bundled-binary
    // mismatch is the L-008 trap. CODEX_DEFAULT_MODEL moves only when the SDK pin
    // moves. An explicit pin is forwarded unchanged (L-006).
    resolveModel: async (requested: string | undefined) =>
      requested && requested !== 'latest' ? requested : CODEX_DEFAULT_MODEL,
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
