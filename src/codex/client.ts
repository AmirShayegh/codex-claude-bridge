import { Codex } from '@openai/codex-sdk';
import { toJSONSchema, type z } from 'zod';
import { randomUUID } from 'node:crypto';
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
import { filterByFiles, formatForPrompt } from '../config/copilot-instructions.js';
import type { CopilotInstructions } from '../config/copilot-instructions.js';
import { extractFilesFromDiff } from '../utils/diff-files.js';

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
  model?: string;
}

interface CodeReviewInput {
  diff: string;
  context?: string;
  criteria?: string[];
  session_id?: string;
  model?: string;
}

interface PrecommitReviewInput {
  diff: string;
  checklist?: string[];
  session_id?: string;
  model?: string;
}

export interface CodexClient {
  reviewPlan(input: PlanReviewInput): Promise<Result<PlanReviewResult>>;
  reviewCode(input: CodeReviewInput): Promise<Result<CodeReviewResult>>;
  reviewPrecommit(input: PrecommitReviewInput): Promise<Result<PrecommitResult>>;
}

export function looksLikeDiff(text: string): boolean {
  const hasDiffGit = /^diff --git /m.test(text);
  const hasHunks = /^@@ /m.test(text);
  const hasFileHeaders = /^--- [ab]\//m.test(text) && /^\+\+\+ [ab]\//m.test(text);
  // Require at least two structural markers to reduce false positives
  return (hasDiffGit && (hasHunks || hasFileHeaders)) || (hasFileHeaders && hasHunks);
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

export function sessionModelConflictMessage(): string {
  return (
    `${ErrorCode.INVALID_INPUT}: Cannot change model on a resumed session. ` +
    `Omit session_id to start a new thread with a different model.`
  );
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

async function runReview<T extends Record<string, unknown>>(params: {
  codex: Codex;
  config: ReviewBridgeConfig;
  prompt: string;
  responseSchema: z.ZodType;
  sessionId?: string;
  // Sent to startThread on fresh threads. Omitted on resume.
  model?: string;
  // The model the active thread is actually running on. Always set; used
  // for error-context so messages report the correct model even when
  // `model` is intentionally undefined on resumed chunks of a chunked review.
  resolvedModel: string;
}): Promise<Result<T & { session_id: string }>> {
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

  return {
    async reviewPlan(input) {
      if (input.session_id && input.model) {
        return err<PlanReviewResult>(sessionModelConflictMessage());
      }
      const prompt = buildPlanReviewPrompt(input, {
        project_context: config.project_context,
        copilot_instructions: formatForPrompt(copilotInstructions),
        focus: config.review_standards.plan_review.focus,
        depth: config.review_standards.plan_review.depth,
      });
      return runReview<Omit<PlanReviewResult, 'session_id'>>({
        codex,
        config,
        prompt,
        responseSchema: PlanReviewResponseSchema,
        sessionId: input.session_id,
        model: input.model,
        resolvedModel: input.model ?? config.model,
      });
    },

    async reviewCode(input) {
      if (input.session_id && input.model) {
        return err<CodeReviewResult>(sessionModelConflictMessage());
      }
      if (input.diff.length > 20 && !looksLikeDiff(input.diff)) {
        return err<CodeReviewResult>(
          `${ErrorCode.INVALID_INPUT}: Input doesn't look like a git diff. ` +
          `Expected unified diff format (with 'diff --git', '---/+++', or '@@' markers). ` +
          `If reviewing a plan or description, use review_plan instead.`,
        );
      }
      // Match prompt builder logic: empty array falls through to config criteria
      const criteria = input.criteria && input.criteria.length > 0
        ? input.criteria
        : config.review_standards.code_review.criteria;
      const files = extractFilesFromDiff(input.diff);
      const instrText = formatForPrompt(filterByFiles(copilotInstructions, files));
      const variableOverhead = computeVariableOverhead([
        input.context ?? '',
        config.project_context,
        criteria.join(', '),
        instrText,
      ]);
      // Floor of 500 prevents zero/negative budget when overhead exceeds max_chunk_tokens.
      // In practice this means very small max_chunk_tokens values may produce chunks
      // larger than configured — this is preferable to disabling chunking entirely.
      const diffBudget = Math.max(config.max_chunk_tokens - PROMPT_OVERHEAD_TOKENS - variableOverhead, 500);
      const chunks = chunkDiff(input.diff, diffBudget);

      // Empty diff — synthetic approve
      if (chunks.length === 0) {
        return ok<CodeReviewResult>({
          verdict: 'approve',
          summary: 'No changes to review.',
          findings: [],
          session_id: input.session_id ?? randomUUID(),
        });
      }

      // Single chunk — standard path (no chunks_reviewed)
      if (chunks.length === 1) {
        const prompt = buildCodeReviewPrompt(input, {
          project_context: config.project_context,
          copilot_instructions: instrText,
          criteria: config.review_standards.code_review.criteria,
          require_tests: config.review_standards.code_review.require_tests,
        });
        return runReview<Omit<CodeReviewResult, 'session_id' | 'chunks_reviewed'>>({
          codex,
          config,
          prompt,
          responseSchema: CodeReviewResponseSchema,
          sessionId: input.session_id,
          model: input.model,
          resolvedModel: input.model ?? config.model,
        });
      }

      // Multi-chunk — sequential review with per-chunk timeout
      const codeConfig = {
        project_context: config.project_context,
        copilot_instructions: instrText,
        criteria: config.review_standards.code_review.criteria,
        require_tests: config.review_standards.code_review.require_tests,
      };
      const chunkResults: Omit<CodeReviewResult, 'chunks_reviewed'>[] = [];
      let sessionId = input.session_id;
      const codeResolvedModel = input.model ?? config.model;

      for (let i = 0; i < chunks.length; i++) {
        const chunkHeader = `Chunk ${i + 1} of ${chunks.length}: reviewing the following files only.`;
        const prompt = buildCodeReviewPrompt({ ...input, diff: chunks[i], chunkHeader }, codeConfig);
        const result = await runReview<Omit<CodeReviewResult, 'session_id' | 'chunks_reviewed'>>({
          codex,
          config,
          prompt,
          responseSchema: CodeReviewResponseSchema,
          sessionId,
          // Model override applies only to the fresh thread on chunk 1.
          // Chunks 2..N always resume chunk 1's thread, which is already
          // bound to the resolved model.
          model: sessionId ? undefined : input.model,
          // resolvedModel is constant across chunks — the thread is bound to
          // it after chunk 1. Used for error-context so failures on chunks 2..N
          // report the actually-running model instead of falling back to
          // config.model when `model` is intentionally undefined above.
          resolvedModel: codeResolvedModel,
        });

        if (!result.ok) return result;
        chunkResults.push(result.data);
        sessionId = result.data.session_id;
      }

      return ok(mergeCodeResults(chunkResults, sessionId!));
    },

    async reviewPrecommit(input) {
      if (input.session_id && input.model) {
        return err<PrecommitResult>(sessionModelConflictMessage());
      }
      if (input.diff.length > 20 && !looksLikeDiff(input.diff)) {
        return err<PrecommitResult>(
          `${ErrorCode.INVALID_INPUT}: Input doesn't look like a git diff. ` +
          `Expected unified diff format (with 'diff --git', '---/+++', or '@@' markers). ` +
          `If reviewing a plan or description, use review_plan instead.`,
        );
      }
      const checklist = input.checklist ?? [];
      const precommitFiles = extractFilesFromDiff(input.diff);
      const precommitInstrText = formatForPrompt(filterByFiles(copilotInstructions, precommitFiles));
      const variableOverhead = computeVariableOverhead([
        config.project_context,
        checklist.join(', '),
        precommitInstrText,
      ]);
      // Floor of 500 prevents zero/negative budget when overhead exceeds max_chunk_tokens.
      // In practice this means very small max_chunk_tokens values may produce chunks
      // larger than configured — this is preferable to disabling chunking entirely.
      const diffBudget = Math.max(config.max_chunk_tokens - PROMPT_OVERHEAD_TOKENS - variableOverhead, 500);
      const chunks = chunkDiff(input.diff, diffBudget);

      // Empty diff — synthetic pass
      if (chunks.length === 0) {
        return ok<PrecommitResult>({
          ready_to_commit: true,
          blockers: [],
          warnings: [],
          session_id: input.session_id ?? randomUUID(),
        });
      }

      // Single chunk — standard path (no chunks_reviewed)
      if (chunks.length === 1) {
        const prompt = buildPrecommitPrompt(input, {
          project_context: config.project_context,
          copilot_instructions: precommitInstrText,
          block_on: config.review_standards.precommit.block_on,
        });
        return runReview<Omit<PrecommitResult, 'session_id' | 'chunks_reviewed'>>({
          codex,
          config,
          prompt,
          responseSchema: PrecommitResponseSchema,
          sessionId: input.session_id,
          model: input.model,
          resolvedModel: input.model ?? config.model,
        });
      }

      // Multi-chunk — sequential review
      const precommitConfig = {
        project_context: config.project_context,
        copilot_instructions: precommitInstrText,
        block_on: config.review_standards.precommit.block_on,
      };
      const chunkResults: Omit<PrecommitResult, 'chunks_reviewed'>[] = [];
      let sessionId = input.session_id;
      const precommitResolvedModel = input.model ?? config.model;

      for (let i = 0; i < chunks.length; i++) {
        const chunkHeader = `Chunk ${i + 1} of ${chunks.length}: checking the following files only.`;
        const prompt = buildPrecommitPrompt({ ...input, diff: chunks[i], chunkHeader }, precommitConfig);
        const result = await runReview<Omit<PrecommitResult, 'session_id' | 'chunks_reviewed'>>({
          codex,
          config,
          prompt,
          responseSchema: PrecommitResponseSchema,
          sessionId,
          // Chunk 1 may carry the model override; chunks 2..N inherit via resumeThread.
          model: sessionId ? undefined : input.model,
          resolvedModel: precommitResolvedModel,
        });

        if (!result.ok) return result;
        chunkResults.push(result.data);
        sessionId = result.data.session_id;
      }

      return ok(mergePrecommitResults(chunkResults, sessionId!));
    },
  };
}
