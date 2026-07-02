import type { Result } from '../utils/errors.js';
import type {
  PlanReviewResult,
  CodeReviewResult,
  PrecommitResult,
  CrossReviewResult,
} from '../review/types.js';
import type { ReviewProvider } from '../config/types.js';

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

// One finding (from another reviewer) to adjudicate in a cross-review round.
export interface CrossReviewFinding {
  severity: string;
  category: string;
  file: string | null;
  line: number | null;
  description: string;
}

export interface CrossReviewInput {
  // The diff (code) or plan text under review.
  content: string;
  // Findings to adjudicate, in order — the response references them by index.
  findings: CrossReviewFinding[];
  model?: string;
}

// The seam every review provider implements (Codex today, Gemini next).
// Method signatures are intentionally identical to the original CodexClient
// interface so the tool and CLI layers are untouched by the multi-provider work.
export interface ReviewBackend {
  // Which provider this backend is. Lets the tool layer detect a cross-provider
  // session resume (e.g. a gemini session reopened under codex) before reviewing.
  provider: ReviewProvider;
  // Every provider this backend can serve. A leaf lists just its own provider; a
  // composite lists all of its children's. Used by the cross-provider guard
  // (membership check) and by resume routing to find a session's owning leaf.
  providers: readonly ReviewProvider[];
  // Whether a resumed session may change model. False for Codex (its SDK
  // reasserts --model on resume); true for Gemini. The tool layer gates the
  // session_id+model conflict rejection on this so it isn't a Codex-only rule
  // leaking onto every provider.
  allowsModelOverrideOnResume: boolean;
  reviewPlan(input: PlanReviewInput): Promise<Result<PlanReviewResult>>;
  reviewCode(input: CodeReviewInput): Promise<Result<CodeReviewResult>>;
  reviewPrecommit(input: PrecommitReviewInput): Promise<Result<PrecommitResult>>;
  // Optional: adjudicate another reviewer's findings against the same subject
  // (deliberate-deep's cross-review round). Leaf backends implement it; composites
  // don't — the deliberation composite calls it on its underlying leaves.
  crossReview?(input: CrossReviewInput): Promise<Result<CrossReviewResult>>;
}
