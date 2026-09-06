import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import {
  PlanReviewResultSchema,
  CodeReviewResultSchema,
  PrecommitResultSchema,
  CrossReviewResponseSchema,
  CodeFindingSeveritySchema,
} from '../review/types.js';
import type {
  PlanReviewResult,
  CodeReviewResult,
  PrecommitResult,
  CrossReviewResult,
  ModelIdentity,
  CodeFinding,
  CodeFindingSeverity,
} from '../review/types.js';
import {
  buildPlanReviewPrompt,
  buildCodeReviewPrompt,
  buildPrecommitPrompt,
  buildCrossReviewPrompt,
} from '../review/prompts.js';
import type { ReviewBridgeConfig } from '../config/types.js';
import { chunkDiff, estimateTokens } from '../utils/chunking.js';
import { filterByFiles, formatForPrompt } from '../config/copilot-instructions.js';
import { extractFilesFromDiff } from '../utils/diff-files.js';
import { ModelSelectorSchema } from '../utils/input-validation.js';
import type { ReviewProvider } from '../config/types.js';
import type {
  PlanReviewInput,
  CodeReviewInput,
  PrecommitReviewInput,
  CrossReviewInput,
} from './backend.js';
import { escapeTerminalControls } from '../utils/terminal.js';

// Provider-agnostic review orchestration shared by every backend. Carries no
// SDK/provider assumptions: the per-turn model call, error classification, and
// session model live in each backend behind the TurnRunner seam below.

export function looksLikeDiff(text: string): boolean {
  const hasDiffGit = /^diff --git /m.test(text);
  const hasHunks = /^@@ /m.test(text);
  const hasFileHeaders = /^--- [ab]\//m.test(text) && /^\+\+\+ [ab]\//m.test(text);
  // Hunk-less but valid git diffs: binary changes and metadata-only changes
  // (mode, rename, copy, empty file add/delete). These carry `diff --git` but no
  // `@@` and no `---/+++`, so they'd be rejected without these markers (ISS-005).
  const hasBinary = /^Binary files .* differ/m.test(text) || /^GIT binary patch/m.test(text);
  const hasMetadata =
    /^(?:new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |index [0-9a-f]{4,}\.\.)/m.test(
      text,
    );
  // Require at least two structural markers to reduce false positives: the binary
  // and metadata markers only count alongside `diff --git`, so prose that merely
  // contains e.g. "rename from ..." is still rejected.
  return (
    (hasDiffGit && (hasHunks || hasFileHeaders || hasBinary || hasMetadata)) ||
    (hasFileHeaders && hasHunks)
  );
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
    // Chunks reviewed independently often repeat the same blocker/warning (e.g. a
    // project-wide concern surfaced per chunk). Drop exact duplicates, preserving
    // first-seen order — mirrors the finding dedup in mergeCodeResults.
    blockers: [...new Set(results.flatMap((r) => r.blockers))],
    warnings: [...new Set(results.flatMap((r) => r.warnings))],
    session_id: sessionId,
    chunks_reviewed: results.length,
  };
}

// Response schemas omit fields the reviewer doesn't produce — session_id and
// chunks_reviewed are set by the backend/flow, and provider is set authoritatively
// by the backend (never trusted from the model's JSON, which could mis-tag).
// review_mode MUST be omitted too: like provider/deliberation it is stamped by the
// backend after the model responds, never produced by the model. It is optional in
// the Result schema, so leaving it in the model-facing schema makes toJSONSchema emit
// it as a non-required property — which OpenAI structured outputs reject outright
// ("'required' ... must include every key in properties. Missing 'review_mode'"),
// breaking every live Codex review. Tests mock the SDK and Gemini does not enforce
// this, so the break is invisible without a live Codex call (ISS-019).
const PlanReviewResponseSchema = PlanReviewResultSchema.omit({
  session_id: true,
  provider: true,
  review_mode: true,
  deliberation: true,
  models: true,
  provenance: true,
});
const CodeReviewResponseSchema = CodeReviewResultSchema.omit({
  session_id: true,
  chunks_reviewed: true,
  // Where the bridge captured the diff is host knowledge, not a review finding:
  // omitted so the reviewer can neither read it nor forge it (ISS-028).
  captured_from: true,
  provider: true,
  review_mode: true,
  deliberation: true,
  models: true,
  provenance: true,
});
const PrecommitResponseSchema = PrecommitResultSchema.omit({
  session_id: true,
  chunks_reviewed: true,
  // See CodeReviewResponseSchema.
  captured_from: true,
  provider: true,
  review_mode: true,
  models: true,
  provenance: true,
});

// The exact model-facing schemas handed to the provider SDKs (via toJSONSchema in
// codex.ts). Exported so a regression test can assert every property is `required`
// at every level — OpenAI structured outputs reject any schema whose `required`
// omits a property, and that rejection is only visible against a live provider
// (ISS-019), never against the mocked SDK in unit tests.
export const RESPONSE_SCHEMAS = {
  plan: PlanReviewResponseSchema,
  code: CodeReviewResponseSchema,
  precommit: PrecommitResponseSchema,
  cross: CrossReviewResponseSchema,
} as const;

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
  // The directory this turn's provider call runs in. REQUIRED: a turn that
  // silently defaulted to the server's own directory would review the wrong
  // repository, which is the failure ISS-027 exists to make impossible.
  workingDirectory: string;
  sessionId?: string;
  // Applied only when starting a fresh session; omitted on resume.
  model?: string;
  // The concrete identity retained/selected for the active session, when the
  // bridge knows it. It stays undefined for an unrecorded legacy Codex resume
  // instead of substituting today's default. Used for error context otherwise.
  resolvedModel?: string;
}

export type TurnRunner = <T extends Record<string, unknown>>(
  params: TurnParams,
) => Promise<Result<T & { session_id: string }>>;

export interface ReviewFlowDeps {
  config: ReviewBridgeConfig;
  provider: ReviewProvider;
  // When false (e.g. Codex, whose SDK reasserts --model on resume) the flow
  // rejects session_id + model and omits the model on resumed chunks. When true
  // (e.g. Gemini) the caller may change model on a resumed session.
  allowsModelOverrideOnResume: boolean;
  // Resolve a model spec to a concrete id the backend can run. `requested` is the
  // per-call override or config.model (undefined if neither set). Each backend
  // maps 'latest' (and unset) to its own newest supported model — Codex bounded
  // by the SDK pin, Gemini via `agy models` — and returns an explicit pin
  // unchanged (L-006). Orchestration treats this as an untrusted boundary and
  // validates the returned label before it reaches an SDK or subprocess.
  resolveModel: (requested: string | undefined) => Promise<string>;
  // A resumed Codex turn must retain the conversation's known identity instead
  // of substituting today's configured default. Storage/registry lookups are
  // injected so this provider-neutral module never imports persistence.
  lookupSessionModel?: (sessionId: string) => ModelIdentity | null;
  // Codex can expose stronger control-plane evidence in its local rollout.
  // Gemini intentionally leaves this undefined because agy has no equivalent.
  observeSessionModel?: (sessionId: string) => Promise<string | undefined>;
  // Whether chunks 2..N of one review resume chunk 1's session. Codex resumes
  // (one thread per review); Gemini reviews each chunk independently to avoid
  // O(N²) context growth, so its review session id is chunk 1's.
  resumesAcrossChunks: boolean;
}

interface PreparedModel {
  requested: string | null;
  resolved: string | null;
  turnResolved?: string;
  known: ModelIdentity | null;
}

function safeModel(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = ModelSelectorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function lookupKnownModel(deps: ReviewFlowDeps, sessionId: string): ModelIdentity | null {
  try {
    return deps.lookupSessionModel?.(sessionId) ?? null;
  } catch {
    return null;
  }
}

async function prepareModel(
  input: { session_id?: string; model?: string },
  deps: ReviewFlowDeps,
  quiet = false,
): Promise<Result<PreparedModel>> {
  // A Codex resume must retain the bridge's prior identity rather than replacing
  // it with today's configured default. Fresh runtime observation may disagree;
  // that mismatch is reported after the successful turn.
  if (input.session_id && !deps.allowsModelOverrideOnResume) {
    const known = lookupKnownModel(deps, input.session_id);
    const resolved = safeModel(known?.resolved);
    const observed = safeModel(known?.observed);
    return ok({
      requested: null,
      resolved,
      turnResolved: resolved ?? observed ?? undefined,
      known,
    });
  }

  const requestedRaw = input.model ?? deps.config.model;
  const resolvedResult = await resolveModelValidated(deps.resolveModel, requestedRaw, quiet);
  if (!resolvedResult.ok) return resolvedResult;
  return ok({
    requested: safeModel(requestedRaw),
    resolved: resolvedResult.data,
    turnResolved: resolvedResult.data,
    known: null,
  });
}

function normalizedModel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function deduplicateModelIdentities(models: readonly ModelIdentity[]): ModelIdentity[] {
  const seen = new Set<string>();
  const out: ModelIdentity[] = [];
  for (const model of models) {
    const key = JSON.stringify([
      model.provider,
      model.role,
      model.requested,
      model.resolved,
      model.observed,
      model.evidence,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}

async function enrichModelIdentity<R extends { session_id: string; models?: ModelIdentity[] }>(
  result: Result<R>,
  deps: ReviewFlowDeps,
  prepared: PreparedModel,
  role: ModelIdentity['role'],
): Promise<Result<R>> {
  if (!result.ok) return result;

  let observed = safeModel(prepared.known?.observed);
  if (deps.observeSessionModel) {
    try {
      observed = safeModel(await deps.observeSessionModel(result.data.session_id)) ?? observed;
    } catch {
      // Observation is optional evidence. The provider result remains valid.
    }
  }

  const resolved = prepared.resolved ?? safeModel(prepared.known?.resolved);
  const evidence: ModelIdentity['evidence'] = observed
    ? 'runtime_session_record'
    : resolved
      ? 'bridge_selection'
      : 'unavailable';
  const identity: ModelIdentity = {
    provider: deps.provider,
    role,
    requested: prepared.requested,
    resolved,
    observed,
    evidence,
  };

  if (resolved && observed && normalizedModel(resolved) !== normalizedModel(observed)) {
    console.error(
      `[codex-bridge] warning: model identity mismatch for ${deps.provider}: ` +
        `bridge selected "${escapeTerminalControls(resolved)}" but runtime recorded "${escapeTerminalControls(observed)}"`,
    );
  }

  return ok({ ...result.data, models: [identity] });
}

export async function runPlanReview(
  input: PlanReviewInput,
  deps: ReviewFlowDeps,
  turn: TurnRunner,
): Promise<Result<PlanReviewResult>> {
  const { config, allowsModelOverrideOnResume } = deps;
  const { workingDirectory, copilotInstructions } = input.execution;
  if (!allowsModelOverrideOnResume && input.session_id && input.model) {
    return err<PlanReviewResult>(sessionModelConflictMessage());
  }
  const prompt = buildPlanReviewPrompt(input, {
    project_context: config.project_context,
    copilot_instructions: formatForPrompt(copilotInstructions),
    focus: config.review_standards.plan_review.focus,
    depth: config.review_standards.plan_review.depth,
  });
  const preparedResult = await prepareModel(input, deps);
  if (!preparedResult.ok) return preparedResult;
  const prepared = preparedResult.data;
  const result = await turn<Omit<PlanReviewResult, 'session_id'>>({
    prompt,
    responseSchema: PlanReviewResponseSchema,
    workingDirectory,
    sessionId: input.session_id,
    model: perTurnModel(prepared.turnResolved, input.session_id, allowsModelOverrideOnResume),
    resolvedModel: prepared.turnResolved,
  });
  return enrichModelIdentity(result, deps, prepared, 'review');
}

// Resolve the model and, when the caller didn't pin one, narrate what
// 'latest'/unset resolved to. The result schema is fixed, so stderr is the
// surfacing point for "which model actually ran" (T-019). An explicit pin is
// self-evident and stays quiet.
async function resolveModelValidated(
  resolveModel: (requested: string | undefined) => Promise<string>,
  requested: string | undefined,
  quiet: boolean,
): Promise<Result<string>> {
  let resolvedRaw: string;
  try {
    resolvedRaw = await resolveModel(requested);
  } catch {
    return err(`${ErrorCode.MODEL_ERROR}: model resolver failed`);
  }

  // Treat the resolver as an untrusted provider boundary too. Its result is used
  // as an SDK/subprocess argument, so normalize and validate it before the first
  // turn instead of merely nulling the response metadata after the raw value ran.
  const resolved = ModelSelectorSchema.safeParse(resolvedRaw);
  if (!resolved.success) {
    return err(`${ErrorCode.MODEL_ERROR}: model resolver returned an invalid model label`);
  }

  if (!quiet && (requested === undefined || requested === 'latest')) {
    console.error(
      `[codex-bridge] resolved model: ${escapeTerminalControls(resolved.data)} ` +
        `(requested: ${escapeTerminalControls(requested ?? 'default')})`,
    );
  }
  return ok(resolved.data);
}

// The model to apply on a given turn. Backends that reassert model on resume
// (Codex) must omit it when resuming an existing session — the thread keeps the
// model it was created with. Backends that allow a mid-session model change
// (Gemini) always send the resolved model.
function perTurnModel(
  resolved: string | undefined,
  sessionId: string | undefined,
  allowsModelOverrideOnResume: boolean,
): string | undefined {
  if (allowsModelOverrideOnResume) return resolved;
  return sessionId ? undefined : resolved;
}

// Session id to run a given chunk against. When resumesAcrossChunks is true
// (Codex) every chunk after the first resumes the threaded session id; when
// false (Gemini) only chunk 1 may resume a cross-phase input session and later
// chunks run independently, avoiding O(N²) context growth.
function chunkSessionFor(
  index: number,
  resumesAcrossChunks: boolean,
  threaded: string | undefined,
  inputSessionId: string | undefined,
): string | undefined {
  if (resumesAcrossChunks) return threaded;
  return index === 0 ? inputSessionId : undefined;
}

export async function runCodeReview(
  input: CodeReviewInput,
  deps: ReviewFlowDeps,
  turn: TurnRunner,
): Promise<Result<CodeReviewResult>> {
  const { config, allowsModelOverrideOnResume, resumesAcrossChunks } = deps;
  const { workingDirectory, copilotInstructions } = input.execution;
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
  const criteria =
    input.criteria && input.criteria.length > 0
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
  const diffBudget = Math.max(
    config.max_chunk_tokens - PROMPT_OVERHEAD_TOKENS - variableOverhead,
    500,
  );
  const chunks = chunkDiff(input.diff, diffBudget);

  // Empty diff — synthetic approve (no model resolution needed)
  if (chunks.length === 0) {
    return ok<CodeReviewResult>({
      verdict: 'approve',
      summary: 'No changes to review.',
      findings: [],
      session_id: input.session_id ?? randomUUID(),
      models: [],
    });
  }

  const preparedResult = await prepareModel(input, deps);
  if (!preparedResult.ok) return preparedResult;
  const prepared = preparedResult.data;

  // Single chunk — standard path (no chunks_reviewed)
  if (chunks.length === 1) {
    const prompt = buildCodeReviewPrompt(input, {
      project_context: config.project_context,
      copilot_instructions: instrText,
      criteria: config.review_standards.code_review.criteria,
      require_tests: config.review_standards.code_review.require_tests,
    });
    const result = await turn<Omit<CodeReviewResult, 'session_id' | 'chunks_reviewed'>>({
      prompt,
      responseSchema: CodeReviewResponseSchema,
      workingDirectory,
      sessionId: input.session_id,
      model: perTurnModel(prepared.turnResolved, input.session_id, allowsModelOverrideOnResume),
      resolvedModel: prepared.turnResolved,
    });
    return enrichModelIdentity(result, deps, prepared, 'review');
  }

  // Multi-chunk — sequential review with per-chunk timeout
  const codeConfig = {
    project_context: config.project_context,
    copilot_instructions: instrText,
    criteria: config.review_standards.code_review.criteria,
    require_tests: config.review_standards.code_review.require_tests,
  };
  const chunkResults: Omit<CodeReviewResult, 'chunks_reviewed'>[] = [];
  // `threaded` carries chunk 1's session forward only when the backend resumes
  // across chunks; `reviewSessionId` is the id reported for the whole review —
  // always chunk 1's, regardless of mode.
  let threaded = input.session_id;
  let reviewSessionId: string | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const chunkHeader = `Chunk ${i + 1} of ${chunks.length}: reviewing the following files only.`;
    const prompt = buildCodeReviewPrompt({ ...input, diff: chunks[i], chunkHeader }, codeConfig);
    const chunkSession = chunkSessionFor(i, resumesAcrossChunks, threaded, input.session_id);
    const result = await turn<Omit<CodeReviewResult, 'session_id' | 'chunks_reviewed'>>({
      prompt,
      responseSchema: CodeReviewResponseSchema,
      workingDirectory,
      sessionId: chunkSession,
      model: perTurnModel(prepared.turnResolved, chunkSession, allowsModelOverrideOnResume),
      resolvedModel: prepared.turnResolved,
    });

    if (!result.ok) {
      // Surface the partial session id so the tool layer can mark this session
      // failed (T-001): the threaded session when resuming, else chunk 1's id
      // (or a cross-phase input session if chunk 1 itself failed).
      let established: string | undefined;
      if (resumesAcrossChunks) {
        established = threaded;
      } else {
        established = reviewSessionId ?? input.session_id;
      }
      return established ? err<CodeReviewResult>(result.error, established) : result;
    }
    chunkResults.push(result.data);
    if (i === 0) reviewSessionId = result.data.session_id;
    if (resumesAcrossChunks) threaded = result.data.session_id;
  }

  const finalSessionId = resumesAcrossChunks ? threaded : reviewSessionId;
  return enrichModelIdentity(
    ok(mergeCodeResults(chunkResults, finalSessionId!)),
    deps,
    prepared,
    'review',
  );
}

export async function runPrecommitReview(
  input: PrecommitReviewInput,
  deps: ReviewFlowDeps,
  turn: TurnRunner,
): Promise<Result<PrecommitResult>> {
  const { config, allowsModelOverrideOnResume, resumesAcrossChunks } = deps;
  const { workingDirectory, copilotInstructions } = input.execution;
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
  const diffBudget = Math.max(
    config.max_chunk_tokens - PROMPT_OVERHEAD_TOKENS - variableOverhead,
    500,
  );
  const chunks = chunkDiff(input.diff, diffBudget);

  // Empty diff — synthetic pass (no model resolution needed)
  if (chunks.length === 0) {
    return ok<PrecommitResult>({
      ready_to_commit: true,
      blockers: [],
      warnings: [],
      session_id: input.session_id ?? randomUUID(),
      models: [],
    });
  }

  const preparedResult = await prepareModel(input, deps);
  if (!preparedResult.ok) return preparedResult;
  const prepared = preparedResult.data;

  // Single chunk — standard path (no chunks_reviewed)
  if (chunks.length === 1) {
    const prompt = buildPrecommitPrompt(input, {
      project_context: config.project_context,
      copilot_instructions: precommitInstrText,
      block_on: config.review_standards.precommit.block_on,
    });
    const result = await turn<Omit<PrecommitResult, 'session_id' | 'chunks_reviewed'>>({
      prompt,
      responseSchema: PrecommitResponseSchema,
      workingDirectory,
      sessionId: input.session_id,
      model: perTurnModel(prepared.turnResolved, input.session_id, allowsModelOverrideOnResume),
      resolvedModel: prepared.turnResolved,
    });
    return enrichModelIdentity(result, deps, prepared, 'review');
  }

  // Multi-chunk — sequential review
  const precommitConfig = {
    project_context: config.project_context,
    copilot_instructions: precommitInstrText,
    block_on: config.review_standards.precommit.block_on,
  };
  const chunkResults: Omit<PrecommitResult, 'chunks_reviewed'>[] = [];
  let threaded = input.session_id;
  let reviewSessionId: string | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const chunkHeader = `Chunk ${i + 1} of ${chunks.length}: checking the following files only.`;
    const prompt = buildPrecommitPrompt(
      { ...input, diff: chunks[i], chunkHeader },
      precommitConfig,
    );
    const chunkSession = chunkSessionFor(i, resumesAcrossChunks, threaded, input.session_id);
    const result = await turn<Omit<PrecommitResult, 'session_id' | 'chunks_reviewed'>>({
      prompt,
      responseSchema: PrecommitResponseSchema,
      workingDirectory,
      sessionId: chunkSession,
      model: perTurnModel(prepared.turnResolved, chunkSession, allowsModelOverrideOnResume),
      resolvedModel: prepared.turnResolved,
    });

    if (!result.ok) {
      // T-001: see runCodeReview chunk loop for rationale.
      let established: string | undefined;
      if (resumesAcrossChunks) {
        established = threaded;
      } else {
        established = reviewSessionId ?? input.session_id;
      }
      return established ? err<PrecommitResult>(result.error, established) : result;
    }
    chunkResults.push(result.data);
    if (i === 0) reviewSessionId = result.data.session_id;
    if (resumesAcrossChunks) threaded = result.data.session_id;
  }

  const finalSessionId = resumesAcrossChunks ? threaded : reviewSessionId;
  return enrichModelIdentity(
    ok(mergePrecommitResults(chunkResults, finalSessionId!)),
    deps,
    prepared,
    'review',
  );
}

// Cross-review (deliberate-deep): adjudicate another reviewer's findings in a
// single stateless structured-output turn. Returns just the adjudications — the
// session id the turn produces is irrelevant for a one-shot cross-review.
export async function runCrossReview(
  input: CrossReviewInput,
  deps: ReviewFlowDeps,
  turn: TurnRunner,
): Promise<Result<CrossReviewResult>> {
  // Resolve quietly: cross-review only runs after this provider's primary review
  // already narrated the same resolution, so logging again just duplicates stderr.
  const preparedResult = await prepareModel({ model: input.model }, deps, true);
  if (!preparedResult.ok) return preparedResult;
  const prepared = preparedResult.data;
  const result = await turn<{ adjudications: CrossReviewResult['adjudications'] }>({
    prompt: buildCrossReviewPrompt(input, {
      // Match what the primary review of the same subject saw: code is scoped
      // to the diff's files, a plan gets everything (it has no files to scope by).
      copilot_instructions: formatForPrompt(
        input.subject === 'code'
          ? filterByFiles(input.execution.copilotInstructions, extractFilesFromDiff(input.content))
          : input.execution.copilotInstructions,
      ),
    }),
    responseSchema: CrossReviewResponseSchema,
    workingDirectory: input.execution.workingDirectory,
    model: perTurnModel(prepared.turnResolved, undefined, deps.allowsModelOverrideOnResume),
    resolvedModel: prepared.turnResolved,
  });
  const enriched = await enrichModelIdentity(result, deps, prepared, 'adjudication');
  if (!enriched.ok) return enriched;
  const { session_id: _sessionId, ...data } = enriched.data;
  return ok(data);
}
