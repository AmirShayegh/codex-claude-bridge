import { Codex } from '@openai/codex-sdk';
import { toJSONSchema } from 'zod';
import type { z } from 'zod';
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
    return e.name === 'AbortError' || e.message.includes('aborted');
  }
  return false;
}

function threadOpts(config: ReviewBridgeConfig) {
  return {
    model: config.model,
    sandboxMode: 'read-only' as const,
    skipGitRepoCheck: true,
    modelReasoningEffort: config.reasoning_effort,
  };
}

async function runReview<T>(params: {
  codex: Codex;
  config: ReviewBridgeConfig;
  prompt: string;
  responseSchema: z.ZodType;
  sessionId?: string;
}): Promise<Result<T & { session_id: string }>> {
  const { codex, config, prompt, responseSchema, sessionId } = params;

  // Get or create thread
  let thread;
  try {
    thread = sessionId
      ? codex.resumeThread(sessionId, threadOpts(config))
      : codex.startThread(threadOpts(config));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`${ErrorCode.SESSION_NOT_FOUND}: ${msg}`);
  }

  const outputSchema = toJSONSchema(responseSchema);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout_seconds * 1000);

  let lastError: string | undefined;

  // Attempt up to 2 times (initial + 1 retry)
  for (let attempt = 0; attempt < 2; attempt++) {
    let turn;
    try {
      turn = await thread.run(prompt, { outputSchema, signal: controller.signal });
    } catch (e: unknown) {
      clearTimeout(timeout);
      if (isAbortError(e)) {
        return err(`${ErrorCode.CODEX_TIMEOUT}: review timed out after ${config.timeout_seconds}s`);
      }
      const msg = e instanceof Error ? e.message : String(e);
      return err(`${ErrorCode.UNKNOWN_ERROR}: ${msg}`);
    }

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(turn.finalResponse);
    } catch {
      lastError = 'malformed JSON in response';
      continue;
    }

    // Validate with Zod
    const result = responseSchema.safeParse(parsed);
    if (!result.success) {
      lastError = result.error.message;
      continue;
    }

    clearTimeout(timeout);
    const resolvedId = thread.id ?? sessionId;
    if (!resolvedId) {
      return err(`${ErrorCode.CODEX_PARSE_ERROR}: missing session ID after successful review`);
    }
    const data = result.data as Record<string, unknown>;
    return ok({ ...data, session_id: resolvedId } as T & { session_id: string });
  }

  clearTimeout(timeout);
  return err(`${ErrorCode.CODEX_PARSE_ERROR}: ${lastError}`);
}

export function createCodexClient(config: ReviewBridgeConfig): CodexClient {
  const codex = new Codex();

  return {
    reviewPlan(input) {
      const prompt = buildPlanReviewPrompt(input);
      return runReview<Omit<PlanReviewResult, 'session_id'>>({
        codex,
        config,
        prompt,
        responseSchema: PlanReviewResponseSchema,
        sessionId: input.session_id,
      });
    },

    reviewCode(input) {
      const prompt = buildCodeReviewPrompt(input);
      return runReview<Omit<CodeReviewResult, 'session_id'>>({
        codex,
        config,
        prompt,
        responseSchema: CodeReviewResponseSchema,
        sessionId: input.session_id,
      });
    },

    reviewPrecommit(input) {
      const prompt = buildPrecommitPrompt(input);
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
