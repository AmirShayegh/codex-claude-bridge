import { Codex } from '@openai/codex-sdk';
import { toJSONSchema, type z } from 'zod';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import {
  PlanReviewResultSchema,
  CodeReviewResultSchema,
  PrecommitResultSchema,
} from './types.js';
import type { PlanReviewResult, CodeReviewResult, PrecommitResult } from './types.js';
import {
  buildPlanReviewPrompt,
  buildCodeReviewPrompt,
  buildPrecommitPrompt,
} from './prompts.js';
import type { ReviewBridgeConfig } from '../config/types.js';

// Response schemas omit session_id — the reviewer doesn't know our session concept
const PlanReviewResponseSchema = PlanReviewResultSchema.omit({ session_id: true });
const CodeReviewResponseSchema = CodeReviewResultSchema.omit({ session_id: true });
const PrecommitResponseSchema = PrecommitResultSchema.omit({ session_id: true });

interface PlanReviewInput {
  plan: string;
  context?: string;
  focus?: string[];
  depth?: 'quick' | 'thorough';
  session_id?: string;
}

interface CodeReviewInput {
  diff: string;
  context?: string;
  criteria?: string[];
  session_id?: string;
}

interface PrecommitReviewInput {
  diff: string;
  checklist?: string[];
  session_id?: string;
}

export interface CodexClient {
  reviewPlan(input: PlanReviewInput): Promise<Result<PlanReviewResult>>;
  reviewCode(input: CodeReviewInput): Promise<Result<CodeReviewResult>>;
  reviewPrecommit(input: PrecommitReviewInput): Promise<Result<PrecommitResult>>;
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

  // Model: unsupported or not found
  if (lower.includes('model') && (lower.includes('not supported') || lower.includes('not found'))) {
    const quoted = raw.match(/["']([^"']+)["']/);
    const modelName = quoted?.[1] ?? context?.model ?? 'your configured model';
    return {
      code: ErrorCode.MODEL_ERROR,
      message: `Model "${modelName}" is not supported. Try gpt-5.2-codex or configure a different model in .reviewbridge.json.`,
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

function threadOpts(config: ReviewBridgeConfig) {
  return {
    model: config.model,
    sandboxMode: 'read-only' as const,
    skipGitRepoCheck: true,
    modelReasoningEffort: config.reasoning_effort,
  };
}

async function runReview<T extends Record<string, unknown>>(params: {
  codex: Codex;
  config: ReviewBridgeConfig;
  prompt: string;
  responseSchema: z.ZodType;
  sessionId?: string;
}): Promise<Result<T & { session_id: string }>> {
  const { codex, config, prompt, responseSchema, sessionId } = params;

  let thread;
  try {
    thread = sessionId
      ? codex.resumeThread(sessionId, threadOpts(config))
      : codex.startThread(threadOpts(config));
  } catch (e: unknown) {
    if (sessionId) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`${ErrorCode.SESSION_NOT_FOUND}: ${msg}`);
    }
    const classified = classifyError(e, { model: config.model });
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
        return err(`${ErrorCode.CODEX_TIMEOUT}: review timed out after ${config.timeout_seconds}s`);
      }
      const classified = classifyError(e, { model: config.model });
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

export function createCodexClient(config: ReviewBridgeConfig): CodexClient {
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

  return {
    reviewPlan(input) {
      const prompt = buildPlanReviewPrompt(input, {
        project_context: config.project_context,
        focus: config.review_standards.plan_review.focus,
        depth: config.review_standards.plan_review.depth,
      });
      return runReview<Omit<PlanReviewResult, 'session_id'>>({
        codex,
        config,
        prompt,
        responseSchema: PlanReviewResponseSchema,
        sessionId: input.session_id,
      });
    },

    reviewCode(input) {
      const prompt = buildCodeReviewPrompt(input, {
        project_context: config.project_context,
        criteria: config.review_standards.code_review.criteria,
        require_tests: config.review_standards.code_review.require_tests,
      });
      return runReview<Omit<CodeReviewResult, 'session_id'>>({
        codex,
        config,
        prompt,
        responseSchema: CodeReviewResponseSchema,
        sessionId: input.session_id,
      });
    },

    reviewPrecommit(input) {
      const prompt = buildPrecommitPrompt(input, {
        project_context: config.project_context,
        block_on: config.review_standards.precommit.block_on,
      });
      return runReview<Omit<PrecommitResult, 'session_id'>>({
        codex,
        config,
        prompt,
        responseSchema: PrecommitResponseSchema,
        sessionId: input.session_id,
      });
    },
  };
}
