import { Codex } from '@openai/codex-sdk';
import { toJSONSchema, type z } from 'zod';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import {
  PlanReviewResultSchema,
  CodeReviewResultSchema,
  PrecommitResultSchema,
  CodeFindingSeveritySchema,
} from './types.js';
import type { PlanReviewResult, CodeReviewResult, PrecommitResult, CodeFinding, CodeFindingSeverity } from './types.js';
import {
  buildPlanReviewPrompt,
  buildCodeReviewPrompt,
  buildPrecommitPrompt,
} from './prompts.js';
import type { ReviewBridgeConfig } from '../config/types.js';
import { chunkDiff, estimateTokens } from '../utils/chunking.js';

// Response schemas omit fields the reviewer doesn't produce
const PlanReviewResponseSchema = PlanReviewResultSchema.omit({ session_id: true });
const CodeReviewResponseSchema = CodeReviewResultSchema.omit({ session_id: true, chunks_reviewed: true });
const PrecommitResponseSchema = PrecommitResultSchema.omit({ session_id: true, chunks_reviewed: true });

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

// Fixed overhead for prompt framing (role, rubric, schema, chunk header)
const PROMPT_OVERHEAD_TOKENS = 2000;

function computeVariableOverhead(parts: string[]): number {
  let total = 0;
  for (const part of parts) {
    if (part) total += estimateTokens(part);
  }
  return total;
}

// Higher rank = more severe. Options are ['critical','major','minor','nitpick'] so reverse index.
const severityRank: Record<CodeFindingSeverity, number> = Object.fromEntries(
  CodeFindingSeveritySchema.options.map((s, i, arr) => [s, arr.length - 1 - i]),
) as Record<CodeFindingSeverity, number>;

function deduplicateFindings(findings: CodeFinding[]): CodeFinding[] {
  const map = new Map<string, CodeFinding>();
  const keyless: CodeFinding[] = [];

  for (const f of findings) {
    if (f.file === null || f.line === null) {
      keyless.push(f);
      continue;
    }
    const key = `${f.file}:${f.line}:${f.category}`;
    const existing = map.get(key);
    if (!existing || severityRank[f.severity] > severityRank[existing.severity]) {
      map.set(key, f);
    }
  }

  return [...map.values(), ...keyless];
}

const codeVerdictRank: Record<string, number> = { approve: 0, request_changes: 1, reject: 2 };

function mergeCodeResults(
  results: Omit<CodeReviewResult, 'chunks_reviewed'>[],
  sessionId: string,
): CodeReviewResult {
  let worstVerdict = results[0].verdict;
  for (const r of results) {
    if (codeVerdictRank[r.verdict] > codeVerdictRank[worstVerdict]) {
      worstVerdict = r.verdict;
    }
  }

  return {
    verdict: worstVerdict,
    summary: results.map((r) => r.summary).join(' '),
    findings: deduplicateFindings(results.flatMap((r) => r.findings)),
    session_id: sessionId,
    chunks_reviewed: results.length,
  };
}

function mergePrecommitResults(
  results: Omit<PrecommitResult, 'chunks_reviewed'>[],
  sessionId: string,
): PrecommitResult {
  return {
    ready_to_commit: results.every((r) => r.ready_to_commit),
    blockers: results.flatMap((r) => r.blockers),
    warnings: results.flatMap((r) => r.warnings),
    session_id: sessionId,
    chunks_reviewed: results.length,
  };
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

    async reviewCode(input) {
      const criteria = input.criteria ?? config.review_standards.code_review.criteria;
      const variableOverhead = computeVariableOverhead([
        input.context ?? '',
        config.project_context,
        criteria.join(', '),
      ]);
      const diffBudget = Math.max(config.max_chunk_tokens - PROMPT_OVERHEAD_TOKENS - variableOverhead, 500);
      const chunks = chunkDiff(input.diff, diffBudget);

      // Empty diff — synthetic approve
      if (chunks.length === 0) {
        return ok<CodeReviewResult>({
          verdict: 'approve',
          summary: 'No changes to review.',
          findings: [],
          session_id: input.session_id ?? '',
        });
      }

      // Single chunk — standard path (no chunks_reviewed)
      if (chunks.length === 1) {
        const prompt = buildCodeReviewPrompt(input, {
          project_context: config.project_context,
          criteria: config.review_standards.code_review.criteria,
          require_tests: config.review_standards.code_review.require_tests,
        });
        return runReview<Omit<CodeReviewResult, 'session_id' | 'chunks_reviewed'>>({
          codex,
          config,
          prompt,
          responseSchema: CodeReviewResponseSchema,
          sessionId: input.session_id,
        });
      }

      // Multi-chunk — sequential review with per-chunk timeout
      const codeConfig = {
        project_context: config.project_context,
        criteria: config.review_standards.code_review.criteria,
        require_tests: config.review_standards.code_review.require_tests,
      };
      const chunkResults: Omit<CodeReviewResult, 'chunks_reviewed'>[] = [];
      let sessionId = input.session_id;

      for (let i = 0; i < chunks.length; i++) {
        const chunkHeader = `Chunk ${i + 1} of ${chunks.length}: reviewing the following files only.`;
        const prompt = buildCodeReviewPrompt({ ...input, diff: chunks[i], chunkHeader }, codeConfig);
        const result = await runReview<Omit<CodeReviewResult, 'session_id' | 'chunks_reviewed'>>({
          codex,
          config,
          prompt,
          responseSchema: CodeReviewResponseSchema,
          sessionId,
        });

        if (!result.ok) return result;
        chunkResults.push(result.data);
        sessionId = result.data.session_id;
      }

      return ok(mergeCodeResults(chunkResults, sessionId!));
    },

    async reviewPrecommit(input) {
      const checklist = input.checklist ?? [];
      const variableOverhead = computeVariableOverhead([
        config.project_context,
        checklist.join(', '),
      ]);
      const diffBudget = Math.max(config.max_chunk_tokens - PROMPT_OVERHEAD_TOKENS - variableOverhead, 500);
      const chunks = chunkDiff(input.diff, diffBudget);

      // Empty diff — synthetic pass
      if (chunks.length === 0) {
        return ok<PrecommitResult>({
          ready_to_commit: true,
          blockers: [],
          warnings: [],
          session_id: input.session_id ?? '',
        });
      }

      // Single chunk — standard path (no chunks_reviewed)
      if (chunks.length === 1) {
        const prompt = buildPrecommitPrompt(input, {
          project_context: config.project_context,
          block_on: config.review_standards.precommit.block_on,
        });
        return runReview<Omit<PrecommitResult, 'session_id' | 'chunks_reviewed'>>({
          codex,
          config,
          prompt,
          responseSchema: PrecommitResponseSchema,
          sessionId: input.session_id,
        });
      }

      // Multi-chunk — sequential review
      const precommitConfig = {
        project_context: config.project_context,
        block_on: config.review_standards.precommit.block_on,
      };
      const chunkResults: Omit<PrecommitResult, 'chunks_reviewed'>[] = [];
      let sessionId = input.session_id;

      for (let i = 0; i < chunks.length; i++) {
        const chunkHeader = `Chunk ${i + 1} of ${chunks.length}: checking the following files only.`;
        const prompt = buildPrecommitPrompt({ ...input, diff: chunks[i], chunkHeader }, precommitConfig);
        const result = await runReview<Omit<PrecommitResult, 'session_id' | 'chunks_reviewed'>>({
          codex,
          config,
          prompt,
          responseSchema: PrecommitResponseSchema,
          sessionId,
        });

        if (!result.ok) return result;
        chunkResults.push(result.data);
        sessionId = result.data.session_id;
      }

      return ok(mergePrecommitResults(chunkResults, sessionId!));
    },
  };
}
