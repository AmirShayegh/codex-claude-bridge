import type { Result } from '../utils/errors.js';
import type {
  PlanReviewResult,
  CodeReviewResult,
  PrecommitResult,
  CrossReviewResult,
} from '../review/types.js';
import type { ReviewProvider } from '../config/types.js';
import type { CopilotInstructions } from '../config/copilot-instructions.js';

// Everything about WHERE a review runs, resolved once per request before any
// provider is contacted (ISS-027). Carrying it on the input rather than baking it
// into the backend at startup is what lets one server review several repositories
// — including git worktrees the server was not launched in.
export interface ReviewExecutionContext {
  // Absolute, already-canonicalized directory this review runs in. Every git
  // command and every provider subprocess uses exactly this value; nothing
  // downstream falls back to process.cwd().
  workingDirectory: string;
  // Repository instruction files read for THIS request's repository. Undefined
  // when instructions are disabled, or when the request needs no provider call.
  copilotInstructions?: CopilotInstructions;
}

// Input shapes accepted by every review backend. Provider-agnostic — these are
// the arguments the tool/CLI layers pass through to whichever backend is active.
export interface PlanReviewInput {
  plan: string;
  execution: ReviewExecutionContext;
  context?: string;
  focus?: string[];
  depth?: 'quick' | 'thorough';
  session_id?: string;
  model?: string;
  // Per-call override of the configured review mode: true forces deliberation
  // (both providers), false forces failover (one provider). Undefined = config
  // default. Ignored by leaf backends; honored by the composite.
  deliberate?: boolean;
}

export interface CodeReviewInput {
  diff: string;
  execution: ReviewExecutionContext;
  context?: string;
  criteria?: string[];
  session_id?: string;
  model?: string;
  // See PlanReviewInput.deliberate.
  deliberate?: boolean;
}

export interface PrecommitReviewInput {
  diff: string;
  execution: ReviewExecutionContext;
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
  execution: ReviewExecutionContext;
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
  // reasserts --model on resume); true for Gemini. Leaf orchestration and the
  // lifecycle's pre-admission validation both consult this capability.
  allowsModelOverrideOnResume: boolean;
  // Composites may serve leaves with different resume capabilities. Resolve
  // against the session's owning provider instead of treating the configured
  // primary's flag as representative of every leaf.
  allowsModelOverrideOnResumeFor?(provider: ReviewProvider): boolean;
  reviewPlan(input: PlanReviewInput): Promise<Result<PlanReviewResult>>;
  reviewCode(input: CodeReviewInput): Promise<Result<CodeReviewResult>>;
  reviewPrecommit(input: PrecommitReviewInput): Promise<Result<PrecommitResult>>;
  // Optional: adjudicate another reviewer's findings against the same subject
  // (deliberate-deep's cross-review round). Leaf backends implement it; composites
  // don't — the deliberation composite calls it on its underlying leaves.
  crossReview?(input: CrossReviewInput): Promise<Result<CrossReviewResult>>;
}

// Resolve a resume capability for one concrete provider. Leaves only expose the
// legacy scalar flag; composites provide the owner-aware callback above.
export function canOverrideModelOnResume(
  backend: ReviewBackend,
  provider: ReviewProvider,
): boolean {
  if (!backend.providers.includes(provider)) return false;
  if (backend.allowsModelOverrideOnResumeFor) {
    return backend.allowsModelOverrideOnResumeFor(provider);
  }
  // The scalar is authoritative for a leaf (and for a composite's presented
  // primary). A hand-built multi-provider backend without an owner-aware
  // callback fails closed for non-primary owners.
  return provider === backend.provider || backend.providers.length === 1
    ? backend.allowsModelOverrideOnResume
    : false;
}
