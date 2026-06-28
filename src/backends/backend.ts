import type { Result } from '../utils/errors.js';
import type { PlanReviewResult, CodeReviewResult, PrecommitResult } from '../codex/types.js';

// Input shapes accepted by every review backend. Provider-agnostic — these are
// the arguments the tool/CLI layers pass through to whichever backend is active.
export interface PlanReviewInput {
  plan: string;
  context?: string;
  focus?: string[];
  depth?: 'quick' | 'thorough';
  session_id?: string;
  model?: string;
}

export interface CodeReviewInput {
  diff: string;
  context?: string;
  criteria?: string[];
  session_id?: string;
  model?: string;
}

export interface PrecommitReviewInput {
  diff: string;
  checklist?: string[];
  session_id?: string;
  model?: string;
}

// The seam every review provider implements (Codex today, Gemini next).
// Method signatures are intentionally identical to the original CodexClient
// interface so the tool and CLI layers are untouched by the multi-provider work.
export interface ReviewBackend {
  reviewPlan(input: PlanReviewInput): Promise<Result<PlanReviewResult>>;
  reviewCode(input: CodeReviewInput): Promise<Result<CodeReviewResult>>;
  reviewPrecommit(input: PrecommitReviewInput): Promise<Result<PrecommitResult>>;
}
