import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import {
  PlanReviewResultSchema,
  CodeReviewResultSchema,
  PrecommitResultSchema,
  CodeFindingSeveritySchema,
} from '../codex/types.js';
import type {
  PlanReviewResult,
  CodeReviewResult,
  PrecommitResult,
  CodeFinding,
  CodeFindingSeverity,
} from '../codex/types.js';
import {
  buildPlanReviewPrompt,
  buildCodeReviewPrompt,
  buildPrecommitPrompt,
} from '../codex/prompts.js';
import type { ReviewBridgeConfig } from '../config/types.js';
import { chunkDiff, estimateTokens } from '../utils/chunking.js';
import { filterByFiles, formatForPrompt } from '../config/copilot-instructions.js';
import type { CopilotInstructions } from '../config/copilot-instructions.js';
import { extractFilesFromDiff } from '../utils/diff-files.js';
import type {
  PlanReviewInput,
  CodeReviewInput,
  PrecommitReviewInput,
} from './backend.js';

// Provider-agnostic review orchestration shared by every backend. Carries no
// SDK/provider assumptions: the per-turn model call, error classification, and
// session model live in each backend behind the TurnRunner seam below.

export function looksLikeDiff(text: string): boolean {
  const hasDiffGit = /^diff --git /m.test(text);
  const hasHunks = /^@@ /m.test(text);
  const hasFileHeaders = /^--- [ab]\//m.test(text) && /^\+\+\+ [ab]\//m.test(text);
  // Require at least two structural markers to reduce false positives
  return (hasDiffGit && (hasHunks || hasFileHeaders)) || (hasFileHeaders && hasHunks);
}

// Fixed overhead for prompt framing (role, rubric, schema, chunk header)
export const PROMPT_OVERHEAD_TOKENS = 2000;

export function computeVariableOverhead(parts: string[]): number {
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

export function deduplicateFindings(findings: CodeFinding[]): CodeFinding[] {
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

export function mergeCodeResults(
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

export function mergePrecommitResults(
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

// Response schemas omit fields the reviewer doesn't produce
const PlanReviewResponseSchema = PlanReviewResultSchema.omit({ session_id: true });
const CodeReviewResponseSchema = CodeReviewResultSchema.omit({ session_id: true, chunks_reviewed: true });
const PrecommitResponseSchema = PrecommitResultSchema.omit({ session_id: true, chunks_reviewed: true });

export function sessionModelConflictMessage(): string {
  return (
    `${ErrorCode.INVALID_INPUT}: Cannot change model on a resumed session. ` +
    `Omit session_id to start a new thread with a different model.`
  );
}

// One backend turn: run a single prompt and return the schema-validated result
// plus the backend's session id. The backend owns session/thread management,
// the per-turn model call, error classification, and the parse-retry loop; the
// orchestrator owns the chunking flow, dedup, and merge below.
export interface TurnParams {
  prompt: string;
  responseSchema: z.ZodType;
  sessionId?: string;
  // Applied only when starting a fresh session; omitted on resume.
  model?: string;
  // The model the active session actually runs on. Always set; used for
  // error-context so messages report the correct model even when `model` is
  // intentionally undefined on resumed chunks of a chunked review.
  resolvedModel: string;
}

export type TurnRunner = <T extends Record<string, unknown>>(
  params: TurnParams,
) => Promise<Result<T & { session_id: string }>>;

export interface ReviewFlowDeps {
  config: ReviewBridgeConfig;
  copilotInstructions?: CopilotInstructions;
  // When false (e.g. Codex, whose SDK reasserts --model on resume) the flow
  // rejects session_id + model and omits the model on resumed chunks. When true
  // (e.g. Gemini) the caller may change model on a resumed session.
  allowsModelOverrideOnResume: boolean;
}

export async function runPlanReview(
  input: PlanReviewInput,
  deps: ReviewFlowDeps,
  turn: TurnRunner,
): Promise<Result<PlanReviewResult>> {
  const { config, copilotInstructions, allowsModelOverrideOnResume } = deps;
  if (!allowsModelOverrideOnResume && input.session_id && input.model) {
    return err<PlanReviewResult>(sessionModelConflictMessage());
  }
  const prompt = buildPlanReviewPrompt(input, {
    project_context: config.project_context,
    copilot_instructions: formatForPrompt(copilotInstructions),
    focus: config.review_standards.plan_review.focus,
    depth: config.review_standards.plan_review.depth,
  });
  return turn<Omit<PlanReviewResult, 'session_id'>>({
    prompt,
    responseSchema: PlanReviewResponseSchema,
    sessionId: input.session_id,
    model: input.model,
    resolvedModel: input.model ?? config.model,
  });
}

export async function runCodeReview(
  input: CodeReviewInput,
  deps: ReviewFlowDeps,
  turn: TurnRunner,
): Promise<Result<CodeReviewResult>> {
  const { config, copilotInstructions, allowsModelOverrideOnResume } = deps;
  if (!allowsModelOverrideOnResume && input.session_id && input.model) {
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
    return turn<Omit<CodeReviewResult, 'session_id' | 'chunks_reviewed'>>({
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
    // Chunk 1 starts the session with the requested model. For chunks 2..N the
    // policy is per-backend: Codex (allowsModelOverrideOnResume=false) omits the
    // model because its SDK reasserts --model on resume; backends that allow a
    // mid-session model change forward it on every chunk.
    let turnModel: string | undefined;
    if (allowsModelOverrideOnResume) {
      turnModel = input.model;
    } else {
      turnModel = sessionId ? undefined : input.model;
    }
    const result = await turn<Omit<CodeReviewResult, 'session_id' | 'chunks_reviewed'>>({
      prompt,
      responseSchema: CodeReviewResponseSchema,
      sessionId,
      model: turnModel,
      resolvedModel: codeResolvedModel,
    });

    if (!result.ok) {
      // Surface the partial session id so the tool layer can mark this session
      // failed (T-001). Falls through to the original result if chunk 1 failed
      // before any session was established.
      return sessionId ? err<CodeReviewResult>(result.error, sessionId) : result;
    }
    chunkResults.push(result.data);
    sessionId = result.data.session_id;
  }

  return ok(mergeCodeResults(chunkResults, sessionId!));
}

export async function runPrecommitReview(
  input: PrecommitReviewInput,
  deps: ReviewFlowDeps,
  turn: TurnRunner,
): Promise<Result<PrecommitResult>> {
  const { config, copilotInstructions, allowsModelOverrideOnResume } = deps;
  if (!allowsModelOverrideOnResume && input.session_id && input.model) {
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
    return turn<Omit<PrecommitResult, 'session_id' | 'chunks_reviewed'>>({
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
    // See runCodeReview chunk loop: chunk 1 carries the model; the resume policy
    // for chunks 2..N is per-backend (Codex omits, override-capable backends forward).
    let turnModel: string | undefined;
    if (allowsModelOverrideOnResume) {
      turnModel = input.model;
    } else {
      turnModel = sessionId ? undefined : input.model;
    }
    const result = await turn<Omit<PrecommitResult, 'session_id' | 'chunks_reviewed'>>({
      prompt,
      responseSchema: PrecommitResponseSchema,
      sessionId,
      model: turnModel,
      resolvedModel: precommitResolvedModel,
    });

    if (!result.ok) {
      // T-001: see runCodeReview chunk loop for rationale.
      return sessionId ? err<PrecommitResult>(result.error, sessionId) : result;
    }
    chunkResults.push(result.data);
    sessionId = result.data.session_id;
  }

  return ok(mergePrecommitResults(chunkResults, sessionId!));
}
