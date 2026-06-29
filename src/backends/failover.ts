import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import type { ReviewProvider } from '../config/types.js';
import type {
  ReviewBackend,
  PlanReviewInput,
  CodeReviewInput,
  PrecommitReviewInput,
} from './backend.js';

// Provider failover: wrap a primary + secondary backend so a review that fails
// because the primary is out of usage / unavailable is transparently retried
// through the other provider. The composite IS a ReviewBackend, so the tool/CLI
// layers are untouched.

// Errors that mean "the primary is unavailable right now" — retryable on the
// other provider. NOT eligible: INVALID_INPUT / RESPONSE_PARSE_ERROR (the model
// worked) or REVIEW_TIMEOUT (ambiguous). Detection is by the `${ErrorCode}: `
// prefix convention every classifier follows (no structured code on Result).
const FAILOVER_ELIGIBLE: ErrorCode[] = [
  ErrorCode.RATE_LIMITED,
  ErrorCode.MODEL_ERROR,
  ErrorCode.AUTH_ERROR,
];

export function isFailoverEligible(error: string): boolean {
  return FAILOVER_ELIGIBLE.some((code) => error.startsWith(`${code}:`));
}

// Stamp a successful result with the provider that produced it; pass failures
// through untouched. The cast is sound: every result type's `provider` field is
// exactly `ReviewProvider | undefined`, and we set it to a concrete provider.
function tag<R extends { provider?: ReviewProvider }>(
  provider: ReviewProvider,
  result: Result<R>,
): Result<R> {
  if (!result.ok) return result;
  return ok({ ...result.data, provider } as R);
}

type FailoverInput = { session_id?: string; model?: string };

async function withFailover<I extends FailoverInput, R extends { provider?: ReviewProvider }>(
  primary: ReviewBackend,
  secondary: ReviewBackend,
  input: I,
  run: (backend: ReviewBackend, input: I) => Promise<Result<R>>,
): Promise<Result<R>> {
  // A resumed session lives in the primary's own conversation store; the
  // secondary can't continue it. Delegate to the primary with no failover.
  if (input.session_id) return tag(primary.provider, await run(primary, input));

  const first = await run(primary, input);
  if (first.ok || !isFailoverEligible(first.error)) return tag(primary.provider, first);

  const code = first.error.split(':')[0];
  console.error(
    `[codex-bridge] ${primary.provider} unavailable (${code}); falling back to ${secondary.provider}`,
  );
  // Drop any per-call model override — a model chosen for the primary is
  // meaningless for the secondary, which resolves its own default.
  const second = await run(secondary, { ...input, model: undefined });
  if (second.ok) return tag(secondary.provider, second);

  // Both failed: lead with the primary's error (its code/prefix), note the
  // fallback outcome so the failure is diagnosable.
  return err<R>(
    `${first.error} (fallback to ${secondary.provider} also failed: ${second.error})`,
  );
}

export function createFailoverBackend(
  primary: ReviewBackend,
  secondary: ReviewBackend,
): ReviewBackend {
  return {
    // The composite presents as the primary: resumes route to the primary, and
    // the tool's cross-provider guard + session_id/model gate key off these.
    provider: primary.provider,
    allowsModelOverrideOnResume: primary.allowsModelOverrideOnResume,
    reviewPlan: (input: PlanReviewInput) =>
      withFailover(primary, secondary, input, (b, i) => b.reviewPlan(i)),
    reviewCode: (input: CodeReviewInput) =>
      withFailover(primary, secondary, input, (b, i) => b.reviewCode(i)),
    reviewPrecommit: (input: PrecommitReviewInput) =>
      withFailover(primary, secondary, input, (b, i) => b.reviewPrecommit(i)),
  };
}
