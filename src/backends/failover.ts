import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import type { ReviewProvider } from '../config/types.js';
import type {
  ReviewBackend,
  PlanReviewInput,
  CodeReviewInput,
  PrecommitReviewInput,
} from './backend.js';
import { canOverrideModelOnResume } from './backend.js';

function ownerOverrideCapability(
  primary: ReviewBackend,
  secondary: ReviewBackend,
  provider: ReviewProvider,
): boolean {
  const owner = primary.providers.includes(provider)
    ? primary
    : secondary.providers.includes(provider)
      ? secondary
      : null;
  return owner ? canOverrideModelOnResume(owner, provider) : false;
}

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
  // The provider's binary couldn't run at all (missing/killed/quarantined) — the
  // clearest case for trying the other provider instead of hard-failing.
  ErrorCode.PROVIDER_UNAVAILABLE,
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

export type SessionProviderLookupResult =
  | { status: 'found'; value: ReviewProvider | null }
  | { status: 'absent' }
  | { status: 'unavailable' };

// Ownership failures are not equivalent to an unknown legacy session: silently
// routing through the configured primary could resume a provider-incompatible
// conversation. Only an explicit absent/legacy result may use that fallback.
export type SessionProviderLookup = (sessionId: string) => SessionProviderLookupResult;

export function lookupSessionOwner(
  sessionId: string,
  lookup?: SessionProviderLookup,
): Result<ReviewProvider | null> {
  if (!lookup) return ok(null);
  try {
    const result = lookup(sessionId);
    if (result.status === 'unavailable') {
      return err(
        `${ErrorCode.SESSION_ROUTING_UNAVAILABLE}: session ownership could not be established safely`,
      );
    }
    return ok(result.status === 'found' ? result.value : null);
  } catch {
    return err(
      `${ErrorCode.SESSION_ROUTING_UNAVAILABLE}: session ownership could not be established safely`,
    );
  }
}

// Exported for reuse by the deliberation composite, whose precommit path (and
// resumed-session path) is plain failover, not deliberation.
export async function withFailover<
  I extends FailoverInput,
  R extends { provider?: ReviewProvider },
>(
  primary: ReviewBackend,
  secondary: ReviewBackend,
  input: I,
  run: (backend: ReviewBackend, input: I) => Promise<Result<R>>,
  lookup?: SessionProviderLookup,
): Promise<Result<R>> {
  // A resumed session lives in ONE provider's conversation store. Route it to the
  // leaf that owns it (a degraded/failed-over session belongs to the secondary,
  // not the primary — ISS-011). Route by membership so this composes even if a
  // backend ever serves >1 provider. Unknown owner (no lookup / not found) →
  // primary, the historical default.
  if (input.session_id) {
    const ownerResult = lookupSessionOwner(input.session_id, lookup);
    if (!ownerResult.ok) return err<R>(ownerResult.error);
    const owner = ownerResult.data;
    const target = owner && secondary.providers.includes(owner) ? secondary : primary;
    return tag(target.provider, await run(target, input));
  }

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
  return err<R>(`${first.error} (fallback to ${secondary.provider} also failed: ${second.error})`);
}

export function createFailoverBackend(
  primary: ReviewBackend,
  secondary: ReviewBackend,
  lookup?: SessionProviderLookup,
): ReviewBackend {
  return {
    // The composite presents as the primary for tagging new sessions. Resumes
    // and their model capability checks target the OWNING leaf via `lookup`.
    provider: primary.provider,
    providers: [...primary.providers, ...secondary.providers],
    allowsModelOverrideOnResume: primary.allowsModelOverrideOnResume,
    allowsModelOverrideOnResumeFor: (provider) =>
      ownerOverrideCapability(primary, secondary, provider),
    reviewPlan: (input: PlanReviewInput) =>
      withFailover(primary, secondary, input, (b, i) => b.reviewPlan(i), lookup),
    reviewCode: (input: CodeReviewInput) =>
      withFailover(primary, secondary, input, (b, i) => b.reviewCode(i), lookup),
    reviewPrecommit: (input: PrecommitReviewInput) =>
      withFailover(primary, secondary, input, (b, i) => b.reviewPrecommit(i), lookup),
  };
}
