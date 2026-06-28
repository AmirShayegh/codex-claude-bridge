import { Codex } from '@openai/codex-sdk';
import { toJSONSchema } from 'zod';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import type { PlanReviewResult, CodeReviewResult, PrecommitResult } from './types.js';
import type { ReviewBridgeConfig } from '../config/types.js';
import { estimateTokens } from '../utils/chunking.js';
import type { CopilotInstructions } from '../config/copilot-instructions.js';
import type { ReviewBackend } from '../backends/backend.js';
import {
  runPlanReview,
  runCodeReview,
  runPrecommitReview,
  type TurnParams,
  type TurnRunner,
} from '../backends/orchestrator.js';

// `CodexClient` is retained as an alias of the provider-neutral `ReviewBackend`
// seam (src/backends/backend.ts) so existing tool/CLI imports keep working while
// the multi-provider refactor lands incrementally (T-013).
export type CodexClient = ReviewBackend;

// `looksLikeDiff` and `sessionModelConflictMessage` now live in the shared
// orchestrator; re-exported here so existing importers (tools, tests) keep
// resolving them from this module during the incremental refactor.
export { looksLikeDiff, sessionModelConflictMessage } from '../backends/orchestrator.js';

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
    // so Claude Code can auto-set "model": "gpt-5.4" in .reviewbridge.json
    // instead of leaving the user stuck.
    const isChatGptAccountLimitation = /chatgpt\s+account/i.test(raw);
    const tip = isChatGptAccountLimitation
      ? `This model may still be rolling out to ChatGPT-tier Codex. ` +
        `Fall back to gpt-5.4 by setting "model": "gpt-5.4" in .reviewbridge.json, ` +
        `or use an API key (OPENAI_API_KEY) instead of the ChatGPT subscription auth.`
      : `Try gpt-5.5 or gpt-5.4, or configure a different model in .reviewbridge.json.`;
    return {
      code: ErrorCode.MODEL_ERROR,
      message: `Model "${modelName}" is not supported. ${tip} Original error: ${raw}`,
    };
  }

  // Rate limit
  if (lower.includes('429') || lower.includes('rate_limit') || lower.includes('rate limit')) {
    return {
      code: ErrorCode.RATE_LIMITED,
      message: 'Rate limited by OpenAI. Wait a moment and retry.',
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

function threadOpts(config: ReviewBridgeConfig, modelOverride?: string) {
  return {
    model: modelOverride ?? config.model,
    sandboxMode: 'read-only' as const,
    skipGitRepoCheck: true,
    modelReasoningEffort: config.reasoning_effort,
  };
}

// Resume-path options deliberately omit `model`. The SDK forwards `--model`
// to `codex exec` unconditionally whenever the field is present (see
// @openai/codex-sdk/dist/index.js:170), which would reassert a model on
// resume and either break a thread that was created with an override or
// fail auth on ChatGPT-tier Codex if the new model isn't available there.
// The resumed thread keeps whatever model it was started with.
// ESLint config permits `_`-prefixed unused vars (eslint.config.js).
function resumeThreadOpts(config: ReviewBridgeConfig) {
  const { model: _model, ...rest } = threadOpts(config);
  return rest;
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
      : codex.startThread(threadOpts(config, model));
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
        const tokenEst = estimateTokens(prompt);
        return err(
          `${ErrorCode.CODEX_TIMEOUT}: review timed out after ${config.timeout_seconds}s ` +
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
      return err(`${ErrorCode.CODEX_PARSE_ERROR}: missing session ID after successful review`);
    }
    // Single cast justified: safeParse validated result.data matches the schema
    const validated = result.data as T;
    return ok({ ...validated, session_id: resolvedId });
  }

  return err(`${ErrorCode.CODEX_PARSE_ERROR}: ${lastError}`);
}

export function createCodexClient(
  config: ReviewBridgeConfig,
  copilotInstructions?: CopilotInstructions,
): CodexClient {
  let codex: Codex;
  try {
    codex = new Codex();
  } catch (e: unknown) {
    const classified = classifyError(e);
    const errorMsg = `${classified.code}: SDK initialization failed: ${classified.message}`;
    return {
      reviewPlan: () => Promise.resolve(err<PlanReviewResult>(errorMsg)),
      reviewCode: () => Promise.resolve(err<CodeReviewResult>(errorMsg)),
      reviewPrecommit: () => Promise.resolve(err<PrecommitResult>(errorMsg)),
    };
  }

  const turn: TurnRunner = <T extends Record<string, unknown>>(params: TurnParams) =>
    runReview<T>({ ...params, codex, config });
  const deps = { config, copilotInstructions };

  return {
    reviewPlan: (input) => runPlanReview(input, deps, turn),
    reviewCode: (input) => runCodeReview(input, deps, turn),
    reviewPrecommit: (input) => runPrecommitReview(input, deps, turn),
  };
}
