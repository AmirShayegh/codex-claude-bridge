import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import type { ReviewBridgeConfig, ReviewProvider } from '../config/types.js';
import type { PlanReviewResult, CodeReviewResult } from '../review/types.js';
import { withFailover } from './failover.js';
import type { SessionProviderLookup } from './failover.js';
import { deliberatePlan, deliberateCode } from './deliberation.js';
import type {
  ReviewBackend,
  PlanReviewInput,
  CodeReviewInput,
  PrecommitReviewInput,
} from './backend.js';

// The mode a review actually runs in. 'single-deliberate-conflict' is a sentinel
// the single-mode decorator turns into an INVALID_INPUT error (deliberation asked
// for, but there's only one provider).
export type EffectiveMode =
  | 'single'
  | 'failover'
  | 'deliberate'
  | 'deliberate-deep'
  | 'single-deliberate-conflict';

// The mode stamped on a result (the sentinel never reaches a result).
type ReviewMode = 'single' | 'failover' | 'deliberate' | 'deliberate-deep';

// Config-level mode, before any per-call override.
function configMode(config: ReviewBridgeConfig): 'single' | 'failover' | 'deliberate' | 'deliberate-deep' {
  return config.mode ?? (config.fallback ? 'failover' : 'single');
}

// Resolve the effective mode for a single call. A per-call `deliberate` toggle
// overrides the config mode: true → deliberation (deep if configured), false →
// failover. In single-provider config, `deliberate:true` is a conflict (no second
// provider); `deliberate:false`/undefined stay single.
export function resolveMode(
  cfgMode: 'single' | 'failover' | 'deliberate' | 'deliberate-deep',
  deliberate: boolean | undefined,
): EffectiveMode {
  if (cfgMode === 'single') {
    return deliberate === true ? 'single-deliberate-conflict' : 'single';
  }
  if (deliberate === true) return cfgMode === 'deliberate-deep' ? 'deliberate-deep' : 'deliberate';
  if (deliberate === false) return 'failover';
  return cfgMode;
}

function singleModeConflictError(): string {
  return (
    `${ErrorCode.INVALID_INPUT}: deliberate was requested but the provider mode is 'single'. ` +
    `Deliberation needs a second provider — set "mode" to "failover", "deliberate", or ` +
    `"deliberate-deep" in .reviewbridge.json.`
  );
}

// Stamp the effective mode onto a successful result so the caller can always tell
// which composition ran (even when there's no deliberation block). When `provider`
// is given (single mode, where no downstream composite tags it), stamp that too so
// every mode reports the serving provider (ISS-023).
function stamp<R extends { review_mode?: ReviewMode; provider?: ReviewProvider }>(
  mode: ReviewMode,
  result: Result<R>,
  provider?: ReviewProvider,
): Result<R> {
  if (!result.ok) return result;
  return ok({ ...result.data, review_mode: mode, ...(provider ? { provider } : {}) });
}

// Single-provider decorator: stamps review_mode:'single' and rejects a per-call
// deliberate:true (no second provider to deliberate with).
export function withSingleMode(primary: ReviewBackend): ReviewBackend {
  return {
    provider: primary.provider,
    providers: primary.providers,
    allowsModelOverrideOnResume: primary.allowsModelOverrideOnResume,
    reviewPlan: async (input: PlanReviewInput) => {
      if (input.deliberate === true) return err<PlanReviewResult>(singleModeConflictError());
      return stamp('single', await primary.reviewPlan(input), primary.provider);
    },
    reviewCode: async (input: CodeReviewInput) => {
      if (input.deliberate === true) return err<CodeReviewResult>(singleModeConflictError());
      return stamp('single', await primary.reviewCode(input), primary.provider);
    },
    reviewPrecommit: async (input: PrecommitReviewInput) =>
      stamp('single', await primary.reviewPrecommit(input), primary.provider),
    ...(primary.crossReview ? { crossReview: primary.crossReview.bind(primary) } : {}),
  };
}

// The two-provider composite. Picks failover vs deliberation PER CALL from the
// per-call `deliberate` toggle + config mode, so a single call can override the
// configured mode. Precommit always runs failover (latency-sensitive). Resumes
// route to the owning leaf via `lookup` (T-027); deliberation resumes deliberate
// (owner resumes + other reviews fresh).
export function createCompositeBackend(
  primary: ReviewBackend,
  secondary: ReviewBackend,
  config: ReviewBridgeConfig,
  lookup?: SessionProviderLookup,
): ReviewBackend {
  const cfgMode = configMode(config);
  return {
    provider: primary.provider,
    providers: [...primary.providers, ...secondary.providers],
    allowsModelOverrideOnResume: primary.allowsModelOverrideOnResume,
    reviewPlan: async (input: PlanReviewInput) => {
      const mode = resolveMode(cfgMode, input.deliberate);
      // cfgMode is never 'single' when this composite is built (createBackend
      // returns withSingleMode instead), but handle those returns defensively so
      // the exported factory is correct in isolation.
      if (mode === 'single-deliberate-conflict') return err<PlanReviewResult>(singleModeConflictError());
      if (mode === 'single') return stamp('single', await primary.reviewPlan(input), primary.provider);
      if (mode === 'deliberate' || mode === 'deliberate-deep') {
        return stamp(mode, await deliberatePlan(primary, secondary, input, mode === 'deliberate-deep', lookup, config.max_chunk_tokens));
      }
      return stamp('failover', await withFailover(primary, secondary, input, (b, i) => b.reviewPlan(i), lookup));
    },
    reviewCode: async (input: CodeReviewInput) => {
      const mode = resolveMode(cfgMode, input.deliberate);
      if (mode === 'single-deliberate-conflict') return err<CodeReviewResult>(singleModeConflictError());
      if (mode === 'single') return stamp('single', await primary.reviewCode(input), primary.provider);
      if (mode === 'deliberate' || mode === 'deliberate-deep') {
        return stamp(mode, await deliberateCode(primary, secondary, input, mode === 'deliberate-deep', lookup, config.max_chunk_tokens));
      }
      return stamp('failover', await withFailover(primary, secondary, input, (b, i) => b.reviewCode(i), lookup));
    },
    // Precommit is always failover — it runs constantly and is latency-sensitive.
    reviewPrecommit: async (input: PrecommitReviewInput) =>
      stamp('failover', await withFailover(primary, secondary, input, (b, i) => b.reviewPrecommit(i), lookup)),
  };
}
