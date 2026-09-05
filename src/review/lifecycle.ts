import type Database from 'better-sqlite3';
import type {
  CodeReviewInput,
  PlanReviewInput,
  PrecommitReviewInput,
  ReviewBackend,
} from '../backends/backend.js';
import { canOverrideModelOnResume } from '../backends/backend.js';
import { sessionModelConflictMessage } from '../backends/orchestrator.js';
import type { SessionProviderLookup, SessionProviderLookupResult } from '../backends/failover.js';
import type { ReviewProvider } from '../config/types.js';
import type {
  CodeReviewResult,
  ModelIdentity,
  PlanReviewResult,
  PrecommitResult,
  ReviewProvenance,
} from './types.js';
import type { RecordReviewOutcomeInput } from '../storage/review-outcome.js';
import { recordReviewOutcomeWithRetry } from '../storage/review-outcome.js';
import type { SessionRegistry } from '../storage/session-registry.js';
import type { StorageDurability } from '../storage/db.js';
import { err, ErrorCode, ok } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';

type ReviewResult = PlanReviewResult | CodeReviewResult | PrecommitResult;
type ReviewInput = PlanReviewInput | CodeReviewInput | PrecommitReviewInput;
type ReviewType = 'plan' | 'code' | 'precommit';

export interface ReviewLifecycleStorage {
  db: Database.Database;
  durability: StorageDurability;
  warning: string | null;
}

export interface ReviewLifecycleOptions {
  backend: ReviewBackend;
  registry: SessionRegistry;
  lookupSessionProvider?: SessionProviderLookup;
  lookupResultSession?: SessionProviderLookup;
  storage?: ReviewLifecycleStorage;
  recordOutcome?: (db: Database.Database, input: RecordReviewOutcomeInput) => Promise<Result<void>>;
  onOutcomePersistenceFailure?: (sessionId: string) => void;
  onOutcomePersisted?: (sessionId: string) => void;
}

export interface ReviewLifecycle {
  reviewPlan(input: PlanReviewInput): Promise<Result<PlanReviewResult>>;
  reviewCode(input: CodeReviewInput): Promise<Result<CodeReviewResult>>;
  reviewPrecommit(input: PrecommitReviewInput): Promise<Result<PrecommitResult>>;
}

const MEMORY_ONLY_WARNING =
  'Durable review history is unavailable; session state is being kept in memory only.';
const OUTCOME_WRITE_WARNING =
  'Review succeeded, but its history could not be saved durably; session routing is memory-only.';
const UNEXPECTED_REVIEW_ERROR = `${ErrorCode.UNKNOWN_ERROR}: review failed unexpectedly`;

function notRecorded<R extends ReviewResult>(result: R): R {
  return {
    ...result,
    models: result.models ?? [],
    provenance: { persistence: 'not_recorded', warning: null },
  };
}

function lookupOwner(
  sessionId: string | undefined,
  lookup: SessionProviderLookup | undefined,
  providers: readonly ReviewProvider[],
): Result<ReviewProvider | null> {
  if (!sessionId || !lookup) return ok(null);
  let found: SessionProviderLookupResult;
  try {
    found = lookup(sessionId);
  } catch {
    found = { status: 'unavailable' };
  }
  if (found.status === 'unavailable') {
    return err(
      `${ErrorCode.SESSION_ROUTING_UNAVAILABLE}: session ownership could not be established safely`,
    );
  }
  const owner = found.status === 'found' ? found.value : null;
  if (owner && !providers.includes(owner)) {
    return err(
      `${ErrorCode.PROVIDER_MISMATCH}: the session belongs to a provider that is not active`,
    );
  }
  return ok(owner);
}

function reviewSnapshot(
  type: ReviewType,
  result: ReviewResult,
): RecordReviewOutcomeInput['review'] {
  if (type === 'precommit') {
    const precommit = result as PrecommitResult;
    return {
      session_id: precommit.session_id,
      type,
      verdict: precommit.ready_to_commit ? 'approve' : 'reject',
      summary: precommit.warnings.join('; ') || precommit.blockers.join('; ') || 'Clean',
      findings_json: JSON.stringify(precommit.blockers),
      models: precommit.models ?? [],
    };
  }
  const review = result as PlanReviewResult | CodeReviewResult;
  return {
    session_id: review.session_id,
    type,
    verdict: review.verdict,
    summary: review.summary,
    findings_json: JSON.stringify(review.findings),
    models: review.models ?? [],
  };
}

function ownerModel(result: ReviewResult, provider: ReviewProvider): ModelIdentity | null {
  return (
    (result.models ?? []).find(
      (identity) => identity.provider === provider && identity.role === 'review',
    ) ?? null
  );
}

const ROUTING_UNAVAILABLE_MESSAGE = `${ErrorCode.SESSION_ROUTING_UNAVAILABLE}: session ownership could not be established safely`;

function ensureFreshResultSession(
  inputSessionId: string | undefined,
  resultSessionId: string,
  registry: SessionRegistry,
  lookup: SessionProviderLookup | undefined,
  storage: ReviewLifecycleStorage | undefined,
): Result<void> {
  if (inputSessionId === resultSessionId) return ok(undefined);
  if (registry.getStatus(resultSessionId)) return err(ROUTING_UNAVAILABLE_MESSAGE);

  // The fallback database is intentionally hidden behind an unavailable
  // routing lookup: its process registry is the ownership source of truth.
  if (!storage || storage.durability === 'memory_only') return ok(undefined);
  if (!lookup) return err(ROUTING_UNAVAILABLE_MESSAGE);

  try {
    return lookup(resultSessionId).status === 'absent'
      ? ok(undefined)
      : err(ROUTING_UNAVAILABLE_MESSAGE);
  } catch {
    return err(ROUTING_UNAVAILABLE_MESSAGE);
  }
}

export function createReviewLifecycle(options: ReviewLifecycleOptions): ReviewLifecycle {
  const { backend, registry, lookupSessionProvider, storage } = options;
  const lookupResultSession = options.lookupResultSession ?? lookupSessionProvider;
  const writeOutcome = options.recordOutcome ?? recordReviewOutcomeWithRetry;

  interface PreparedReview {
    owner: ReviewProvider | null;
    servingProvider: ReviewProvider;
    release: () => void;
    discardAfterRelease: Set<string>;
  }

  interface NormalizedReview<R extends ReviewResult> {
    result: R;
    resultProvider: ReviewProvider;
    identity: ModelIdentity | null;
  }

  function prepareReviewAdmission<I extends ReviewInput>(input: I): Result<PreparedReview> {
    const owner = lookupOwner(input.session_id, lookupSessionProvider, backend.providers);
    if (!owner.ok) return err(owner.error);

    const servingProvider = owner.data ?? backend.provider;
    if (input.session_id && input.model && !canOverrideModelOnResume(backend, servingProvider)) {
      return err(sessionModelConflictMessage());
    }

    const admission = registry.admit(
      input.session_id,
      input.session_id ? servingProvider : undefined,
    );
    if (!admission.ok) return err(admission.error);
    return ok({
      owner: owner.data,
      servingProvider,
      release: admission.data.release,
      discardAfterRelease: new Set<string>(),
    });
  }

  function normalizeProviderSuccess<I extends ReviewInput, R extends ReviewResult>(
    input: I,
    providerData: R,
    prepared: PreparedReview,
  ): Result<NormalizedReview<R>> {
    const result = { ...providerData, models: providerData.models ?? [] } as R;
    const retainedOwner =
      input.session_id === result.session_id && prepared.owner ? prepared.owner : null;
    const resultProvider = retainedOwner ?? result.provider ?? backend.provider;
    const identity = ownerModel(result, resultProvider);
    const freshResult = ensureFreshResultSession(
      input.session_id,
      result.session_id,
      registry,
      lookupResultSession,
      storage,
    );
    if (!freshResult.ok) {
      registry.fail(input.session_id);
      return err(freshResult.error);
    }

    // Memory state is authoritative for the live process and must update
    // before persistence so a storage failure cannot erase a successful turn.
    registry.complete(input.session_id, result.session_id, resultProvider, identity);
    return ok({ result, resultProvider, identity });
  }

  async function persistOutcomeAndBuildProvenance<R extends ReviewResult>(
    type: ReviewType,
    input: ReviewInput,
    normalized: NormalizedReview<R>,
    prepared: PreparedReview,
  ): Promise<Result<ReviewProvenance>> {
    if (!storage) return ok({ persistence: 'not_recorded', warning: null });

    let outcome: Result<void>;
    try {
      outcome = await writeOutcome(storage.db, {
        preflightSessionId: input.session_id,
        preflightProvider: input.session_id ? prepared.servingProvider : undefined,
        resultSessionId: normalized.result.session_id,
        servingProvider: normalized.resultProvider,
        ownerModelIdentity: normalized.identity,
        review: reviewSnapshot(type, normalized.result),
      });
    } catch {
      outcome = err(`${ErrorCode.STORAGE_ERROR}: review outcome writer failed`);
    }

    if (!outcome.ok) {
      if (outcome.error.startsWith(`${ErrorCode.SESSION_ROUTING_UNAVAILABLE}:`)) {
        prepared.discardAfterRelease.add(normalized.result.session_id);
        if (input.session_id) prepared.discardAfterRelease.add(input.session_id);
        return err(ROUTING_UNAVAILABLE_MESSAGE);
      }
      try {
        options.onOutcomePersistenceFailure?.(normalized.result.session_id);
      } catch {
        // Routing degradation is best-effort defensive state. A callback
        // bug must not erase the already successful provider response.
      }
      console.error(
        '[codex-bridge] review history persistence failed; continuing with memory-only session state',
      );
      return ok({ persistence: 'memory_only', warning: OUTCOME_WRITE_WARNING });
    }

    for (const persistedSessionId of new Set(
      [input.session_id, normalized.result.session_id].filter(
        (sessionId): sessionId is string => sessionId !== undefined,
      ),
    )) {
      try {
        options.onOutcomePersisted?.(persistedSessionId);
      } catch {
        // Persistence already succeeded; defensive routing cleanup cannot
        // change the successful review response.
      }
    }
    return storage.durability === 'memory_only'
      ? ok({
          persistence: 'memory_only',
          warning: storage.warning === null ? null : MEMORY_ONLY_WARNING,
        })
      : ok({ persistence: 'durable', warning: null });
  }

  function releaseOrDiscardRoutingState(prepared: PreparedReview): void {
    prepared.release();
    for (const sessionId of prepared.discardAfterRelease) registry.discard(sessionId);
  }

  function unexpectedFailure<R extends ReviewResult>(sessionId?: string): Result<R> {
    registry.fail(sessionId);
    console.error('[codex-bridge] review failed unexpectedly');
    return err<R>(UNEXPECTED_REVIEW_ERROR);
  }

  async function execute<I extends ReviewInput, R extends ReviewResult>(
    type: ReviewType,
    input: I,
    invoke: () => Promise<Result<R>>,
  ): Promise<Result<R>> {
    // Empty inputs are provider-free synthetic results. Resolve them before
    // ownership lookup, admission, or any session-state mutation.
    if ('diff' in input && input.diff.trim().length === 0) {
      try {
        const synthetic = await invoke();
        return synthetic.ok ? ok(notRecorded(synthetic.data)) : synthetic;
      } catch {
        return unexpectedFailure<R>();
      }
    }

    const preparation = prepareReviewAdmission(input);
    if (!preparation.ok) return err<R>(preparation.error);
    const prepared = preparation.data;

    try {
      const providerResult = await invoke();
      if (!providerResult.ok) {
        registry.fail(input.session_id, providerResult.session_id);
        return providerResult;
      }

      const normalized = normalizeProviderSuccess(input, providerResult.data, prepared);
      if (!normalized.ok) return err<R>(normalized.error);
      const provenance = await persistOutcomeAndBuildProvenance(
        type,
        input,
        normalized.data,
        prepared,
      );
      if (!provenance.ok) return err<R>(provenance.error);
      return ok({ ...normalized.data.result, provenance: provenance.data });
    } catch {
      return unexpectedFailure<R>(input.session_id);
    } finally {
      releaseOrDiscardRoutingState(prepared);
    }
  }

  return {
    reviewPlan: (input) => execute('plan', input, () => backend.reviewPlan(input)),
    reviewCode: (input) => execute('code', input, () => backend.reviewCode(input)),
    reviewPrecommit: (input) => execute('precommit', input, () => backend.reviewPrecommit(input)),
  };
}
