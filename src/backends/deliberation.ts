import { ErrorCode, ok, err } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import type { ReviewProvider } from '../config/types.js';
import { isReviewTier } from '../config/types.js';
import { CodeFindingSeveritySchema, PlanFindingSeveritySchema } from '../review/types.js';
import type { PlanReviewResult, CodeReviewResult, ModelIdentity } from '../review/types.js';
import { deduplicateModelIdentities, sessionModelConflictMessage } from './orchestrator.js';
import { lookupSessionOwner, withFailover } from './failover.js';
import type { SessionProviderLookup } from './failover.js';
import { sliceDiffToFiles } from '../utils/diff-files.js';
import { estimateTokens } from '../utils/chunking.js';
import type {
  ReviewBackend,
  PlanReviewInput,
  CodeReviewInput,
  PrecommitReviewInput,
} from './backend.js';
import { canOverrideModelOnResume } from './backend.js';

const REJECTED_PROVIDER_ERROR = `${ErrorCode.UNKNOWN_ERROR}: provider call failed unexpectedly`;

async function resultFromProviderCall<T>(call: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await call();
  } catch {
    return err<T>(REJECTED_PROVIDER_ERROR);
  }
}

// Deliberation: run BOTH providers on the same review, then surface where they
// agree (both flagged a finding → high confidence) vs. diverge (only one flagged
// → needs judgment). The caller (Claude Code) synthesizes. Scoped to plan + code;
// precommit and resumed sessions fall through to plain failover. Like the
// failover composite, this IS a ReviewBackend, so the tool/CLI layers are
// untouched — the extra signal rides in an additive `deliberation` block.

type AnyFinding = { severity: string; category: string; file: string | null; line: number | null };

// Same key the chunk merge uses (orchestrator.deduplicateFindings): a finding is
// "the same" across providers when file, line, and category match. Keyless
// findings (no file/line) can't be matched, so they're always divergent.
function keyOf(f: AnyFinding): string | null {
  return f.file === null || f.line === null ? null : `${f.file}:${f.line}:${f.category}`;
}

// Higher rank = more severe (reverse index), mirroring orchestrator.severityRank.
function rankFn(order: readonly string[]): (severity: string) => number {
  const rank = new Map(order.map((s, i, arr) => [s, arr.length - 1 - i]));
  return (s) => rank.get(s) ?? -1;
}
const codeRank = rankFn(CodeFindingSeveritySchema.options);
const planRank = rankFn(PlanFindingSeveritySchema.options);

export interface Agreement<F> {
  agreed: F[];
  divergent: { provider: ReviewProvider; finding: F }[];
}

// Cross-provider line drift observed 0–2 across 3 live deliberate-deep runs on the
// N-001 planted-bug diff (note N-002 / ISS-013); genuinely-distinct defects sat ≥3
// lines apart. A window of 2 therefore captures the real drift without bridging
// separate defects. This governs the CROSS-provider merge only — deduplicateFindings
// (same-provider chunk merge, orchestrator.ts) stays exact-key (ISS-013 acceptance d).
const LINE_WINDOW = 2;

// Providers name the same defect with different category vocab AND different
// casing/plurals ("bugs"/"Bug", "security"/"Security", "Incorrect logic"/"bug").
// Normalizing lets casing/plural variants compare equal; the raw vocab differences
// are handled by only trusting a different-category match when it lands on the exact
// same line (see matchAllowed).
function normalizeCategory(c: string): string {
  return c.trim().toLowerCase().replace(/\s+/g, ' ').replace(/s$/, '');
}

// Whether two keyable cross-provider findings on the SAME file may be merged. Same
// normalized category tolerates the observed ≤2 line drift; a different category is
// only trusted at the exact same line (Δ0), so genuinely-distinct nearby defects
// (e.g. an assignment bug and a validation gap two lines apart) never false-merge.
function matchAllowed(fa: AnyFinding, fb: AnyFinding): boolean {
  if (fa.file !== fb.file || fa.line === null || fb.line === null) return false;
  const dl = Math.abs(fa.line - fb.line);
  return normalizeCategory(fa.category) === normalizeCategory(fb.category)
    ? dl <= LINE_WINDOW
    : dl === 0;
}

// Collapse one provider's findings by EXACT key (file:line:category), keeping the
// higher-severity copy — mirrors deduplicateFindings so a provider that repeats a key
// doesn't let the last copy silently win. Keyless findings (no file/line) can never be
// line-matched, so they're separated out and go straight to divergent.
function dedupExact<F extends AnyFinding>(
  findings: F[],
  rankOf: (severity: string) => number,
): { keyable: F[]; keyless: F[] } {
  const keyless: F[] = [];
  const byKey = new Map<string, F>();
  for (const f of findings) {
    const k = keyOf(f);
    if (k === null) {
      keyless.push(f);
      continue;
    }
    const existing = byKey.get(k);
    if (!existing || rankOf(f.severity) > rankOf(existing.severity)) byKey.set(k, f);
  }
  return { keyable: [...byKey.values()], keyless };
}

// Split two providers' findings into those both flagged (agreed, keeping the
// higher-severity representative) and those only one flagged (divergent). Cross-
// provider matching is semantic, not exact-key (ISS-013): a line window plus a
// category-aware gate (matchAllowed), resolved by greedy 1:1 pairing so each finding
// merges at most once — no finding appears in both agreed and divergent.
export function computeAgreement<F extends AnyFinding>(
  a: { provider: ReviewProvider; findings: F[] },
  b: { provider: ReviewProvider; findings: F[] },
  rankOf: (severity: string) => number,
): Agreement<F> {
  const agreed: F[] = [];
  const divergent: { provider: ReviewProvider; finding: F }[] = [];

  const da = dedupExact(a.findings, rankOf);
  const db = dedupExact(b.findings, rankOf);
  for (const finding of da.keyless) divergent.push({ provider: a.provider, finding });
  for (const finding of db.keyless) divergent.push({ provider: b.provider, finding });
  const aKey = da.keyable;
  const bKey = db.keyable;

  // Candidate cross-provider pairs, ranked so the greedy pass takes the strongest
  // match first: category-equal before category-different, then closest line, then
  // higher combined severity, then a stable (i, j) lexicographic tiebreak so the
  // result is deterministic. aKey/bKey hold only findings with non-null file+line,
  // so Math.abs on lines is never NaN.
  const pairs: { i: number; j: number; catEq: number; dl: number; sev: number }[] = [];
  for (let i = 0; i < aKey.length; i++) {
    for (let j = 0; j < bKey.length; j++) {
      const fa = aKey[i];
      const fb = bKey[j];
      if (!matchAllowed(fa, fb)) continue;
      pairs.push({
        i,
        j,
        catEq: normalizeCategory(fa.category) === normalizeCategory(fb.category) ? 1 : 0,
        dl: Math.abs((fa.line as number) - (fb.line as number)),
        sev: rankOf(fa.severity) + rankOf(fb.severity),
      });
    }
  }
  pairs.sort((x, y) => y.catEq - x.catEq || x.dl - y.dl || y.sev - x.sev || x.i - y.i || x.j - y.j);

  const usedA = new Set<number>();
  const usedB = new Set<number>();
  for (const p of pairs) {
    if (usedA.has(p.i) || usedB.has(p.j)) continue;
    usedA.add(p.i);
    usedB.add(p.j);
    const fa = aKey[p.i];
    const fb = bKey[p.j];
    // Keep the higher-severity representative; a tie keeps a's (mirrors prior behavior).
    agreed.push(rankOf(fa.severity) >= rankOf(fb.severity) ? fa : fb);
  }

  for (let i = 0; i < aKey.length; i++) {
    if (!usedA.has(i)) divergent.push({ provider: a.provider, finding: aKey[i] });
  }
  for (let j = 0; j < bKey.length; j++) {
    if (!usedB.has(j)) divergent.push({ provider: b.provider, finding: bKey[j] });
  }
  return { agreed, divergent };
}

function agreementLabel(
  vA: string,
  vB: string,
  divergentCount: number,
): 'agree' | 'mixed' | 'conflict' {
  if (vA !== vB) return 'conflict';
  return divergentCount === 0 ? 'agree' : 'mixed';
}

function joinSummaries(a: string, b: string): string {
  return [a, b].filter(Boolean).join(' ');
}

// Worst verdict wins (a merged review is only as clean as its harshest reviewer).
const CODE_VERDICT_RANK: Record<CodeReviewResult['verdict'], number> = {
  approve: 0,
  request_changes: 1,
  reject: 2,
};
const PLAN_VERDICT_RANK: Record<PlanReviewResult['verdict'], number> = {
  approve: 0,
  revise: 1,
  reject: 2,
};

function combineCode(
  p: ReviewProvider,
  ra: CodeReviewResult,
  s: ReviewProvider,
  rb: CodeReviewResult,
  // Session id of the combined result. Defaults to the primary's; the resume
  // path passes the RESUMED owner's session id so the caller can continue it.
  sessionId?: string,
): CodeReviewResult {
  const { agreed, divergent } = computeAgreement(
    { provider: p, findings: ra.findings },
    { provider: s, findings: rb.findings },
    codeRank,
  );
  // Worst-of-both, computed from the two INDEPENDENT reviews and BY DESIGN not
  // re-derived after cross-review (ISS-015): a deliberate-deep adjudication is
  // advisory input for the caller's synthesis, not folded back into the verdict.
  const verdict =
    CODE_VERDICT_RANK[ra.verdict] >= CODE_VERDICT_RANK[rb.verdict] ? ra.verdict : rb.verdict;
  return {
    verdict,
    summary: joinSummaries(ra.summary, rb.summary),
    findings: [...agreed, ...divergent.map((d) => d.finding)],
    session_id: sessionId ?? ra.session_id,
    provider: p,
    ...(ra.models || rb.models
      ? { models: deduplicateModelIdentities([...(ra.models ?? []), ...(rb.models ?? [])]) }
      : {}),
    // Surface the primary's chunk count at top level (the presented result).
    ...(ra.chunks_reviewed !== undefined ? { chunks_reviewed: ra.chunks_reviewed } : {}),
    deliberation: {
      providers: [p, s],
      verdicts: [
        {
          provider: p,
          verdict: ra.verdict,
          ...(ra.chunks_reviewed !== undefined ? { chunks_reviewed: ra.chunks_reviewed } : {}),
        },
        {
          provider: s,
          verdict: rb.verdict,
          ...(rb.chunks_reviewed !== undefined ? { chunks_reviewed: rb.chunks_reviewed } : {}),
        },
      ],
      agreement: agreementLabel(ra.verdict, rb.verdict, divergent.length),
      agreed,
      divergent,
    },
  };
}

function combinePlan(
  p: ReviewProvider,
  ra: PlanReviewResult,
  s: ReviewProvider,
  rb: PlanReviewResult,
  sessionId?: string,
): PlanReviewResult {
  const { agreed, divergent } = computeAgreement(
    { provider: p, findings: ra.findings },
    { provider: s, findings: rb.findings },
    planRank,
  );
  // Worst-of-both, pre-cross-review by design (ISS-015) — see combineCode.
  const verdict =
    PLAN_VERDICT_RANK[ra.verdict] >= PLAN_VERDICT_RANK[rb.verdict] ? ra.verdict : rb.verdict;
  return {
    verdict,
    summary: joinSummaries(ra.summary, rb.summary),
    findings: [...agreed, ...divergent.map((d) => d.finding)],
    session_id: sessionId ?? ra.session_id,
    provider: p,
    ...(ra.models || rb.models
      ? { models: deduplicateModelIdentities([...(ra.models ?? []), ...(rb.models ?? [])]) }
      : {}),
    deliberation: {
      providers: [p, s],
      // Plan reviews are not chunked, so no chunks_reviewed on verdicts.
      verdicts: [
        { provider: p, verdict: ra.verdict },
        { provider: s, verdict: rb.verdict },
      ],
      agreement: agreementLabel(ra.verdict, rb.verdict, divergent.length),
      agreed,
      divergent,
    },
  };
}

// One provider failed: return the survivor's review with a `degraded` marker so
// the caller knows only one provider reviewed. Deliberation subsumes failover.
function degradeCode(
  served: ReviewProvider,
  data: CodeReviewResult,
  failed: ReviewProvider,
  reason: string,
): CodeReviewResult {
  return {
    ...data,
    provider: served,
    deliberation: {
      providers: [served],
      verdicts: [{ provider: served, verdict: data.verdict }],
      agreement: 'degraded',
      agreed: [],
      divergent: [],
      degraded: { failed, reason },
    },
  };
}

function degradePlan(
  served: ReviewProvider,
  data: PlanReviewResult,
  failed: ReviewProvider,
  reason: string,
): PlanReviewResult {
  return {
    ...data,
    provider: served,
    deliberation: {
      providers: [served],
      verdicts: [{ provider: served, verdict: data.verdict }],
      agreement: 'degraded',
      agreed: [],
      divergent: [],
      degraded: { failed, reason },
    },
  };
}

function bothFailed(pErr: string, secondary: ReviewProvider, sErr: string): string {
  return `${pErr} (deliberation: ${secondary} also failed: ${sErr})`;
}

// Extract an error string without needing TS to narrow across the two results
// (it doesn't track the "exactly one failed" disjunction between ra and rb).
function errOf<T>(r: Result<T>): string {
  return r.ok ? '' : r.error;
}

// --- Cross-review round (deliberate-deep) ---

type Adjudication = {
  by: ReviewProvider;
  verdict: 'confirmed' | 'disputed' | 'unsure';
  reason: string;
};
type CrossFinding = AnyFinding & { description: string };
type CrossReviewFailure = { by: ReviewProvider; reason: string };
type AdjudicateResult = {
  adjudications: (Adjudication | undefined)[];
  models: ModelIdentity[];
  failure?: CrossReviewFailure;
};
// A per-call model override is meaningful only to the provider it names. A TIER
// ('max' / 'balanced' / 'fast') is provider-neutral, so it carries to the other
// reviewer — and to its adjudication — exactly as it carries across failover.
// Dropping it here made `max` pick the strongest model for one reviewer only,
// and `fast` run the other at a more expensive default.
function carriedModel(model: string | undefined): string | undefined {
  return isReviewTier(model) ? model : undefined;
}

type DeliberationModelOverrides = {
  primary?: string;
  secondary?: string;
};

// Ask `judge` to adjudicate `findings` (from the other provider) against the
// change. Returns adjudications aligned to `findings` (undefined where none),
// plus a `failure` when the judge could not run (errored) — distinct from
// "ran and returned no adjudication". A judge with no crossReview capability is
// not a failure (it simply can't adjudicate).
async function runAdjudicate(
  judge: ReviewBackend,
  content: string,
  findings: CrossFinding[],
  model?: string,
  maxChunkTokens?: number,
): Promise<AdjudicateResult> {
  const out: (Adjudication | undefined)[] = new Array(findings.length).fill(undefined);
  const crossReview = judge.crossReview;
  if (findings.length === 0 || !crossReview) return { adjudications: out, models: [] };
  // ISS-012: slice the subject to only the files these findings touch so a large
  // diff doesn't blow the single adjudication turn. Plans / no-file findings fall
  // back to the full subject. If it's STILL over budget, fail this adjudication
  // cleanly (bounded cost) — surfaced via cross_review_failures, no multi-turn.
  const wanted = new Set(
    findings.map((f) => f.file).filter((f): f is string => typeof f === 'string'),
  );
  const subject = sliceDiffToFiles(content, wanted);
  if (maxChunkTokens !== undefined && estimateTokens(subject) > maxChunkTokens) {
    return {
      adjudications: out,
      models: [],
      failure: {
        by: judge.provider,
        reason: `cross-review subject exceeds max_chunk_tokens (${estimateTokens(subject)} > ${maxChunkTokens}) even after slicing to referenced files`,
      },
    };
  }
  const res = await resultFromProviderCall(() =>
    crossReview({
      content: subject,
      findings: findings.map((f) => ({
        severity: f.severity,
        category: f.category,
        file: f.file,
        line: f.line,
        description: f.description,
      })),
      model,
    }),
  );
  if (!res.ok) {
    return {
      adjudications: out,
      models: [],
      failure: { by: judge.provider, reason: res.error },
    };
  }
  for (const a of res.data.adjudications) {
    if (a.index >= 0 && a.index < findings.length) {
      out[a.index] = { by: judge.provider, verdict: a.verdict, reason: a.reason };
    }
  }
  return { adjudications: out, models: res.data.models ?? [] };
}

// Each provider's divergent findings are adjudicated by the OTHER provider (in
// parallel). Returns adjudications aligned to the input `divergent` order, plus
// any per-judge failures (both judges can fail independently).
async function adjudicateDivergent(
  divergent: { provider: ReviewProvider; finding: CrossFinding }[],
  content: string,
  primary: ReviewBackend,
  secondary: ReviewBackend,
  modelOverrides: DeliberationModelOverrides,
  maxChunkTokens?: number,
): Promise<{
  adjudications: (Adjudication | undefined)[];
  failures: CrossReviewFailure[];
  models: ModelIdentity[];
}> {
  const byPrimary = divergent.filter((d) => d.provider === primary.provider);
  const bySecondary = divergent.filter((d) => d.provider === secondary.provider);
  const [secAdj, priAdj] = await Promise.all([
    runAdjudicate(
      secondary,
      content,
      byPrimary.map((d) => d.finding),
      modelOverrides.secondary,
      maxChunkTokens,
    ),
    runAdjudicate(
      primary,
      content,
      bySecondary.map((d) => d.finding),
      modelOverrides.primary,
      maxChunkTokens,
    ),
  ]);
  const out: (Adjudication | undefined)[] = new Array(divergent.length).fill(undefined);
  let si = 0;
  let pi = 0;
  for (let i = 0; i < divergent.length; i++) {
    if (divergent[i].provider === primary.provider) out[i] = secAdj.adjudications[si++];
    else if (divergent[i].provider === secondary.provider) out[i] = priAdj.adjudications[pi++];
  }
  const failures: CrossReviewFailure[] = [];
  if (secAdj.failure) failures.push(secAdj.failure);
  if (priAdj.failure) failures.push(priAdj.failure);
  // Review identities are primary→secondary, so adjudication identities follow
  // the same deterministic provider order even though the two calls run in parallel.
  const models = deduplicateModelIdentities([...priAdj.models, ...secAdj.models]);
  return { adjudications: out, failures, models };
}

// deliberate-deep tail, shared by the fresh and resume paths: if cross-review is
// on and there are divergent findings, adjudicate them and attach each one-sided
// finding's adjudication (plus any judge failures) to the combined result.
// Returns the combined data unchanged when cross-review is off or nothing diverged.
async function maybeAdjudicateCode(
  combined: CodeReviewResult,
  subject: string,
  primary: ReviewBackend,
  secondary: ReviewBackend,
  crossReview: boolean,
  modelOverrides: DeliberationModelOverrides,
  maxChunkTokens?: number,
): Promise<CodeReviewResult> {
  const dl = combined.deliberation;
  if (!crossReview || !dl || dl.divergent.length === 0) return combined;
  const { adjudications, failures, models } = await adjudicateDivergent(
    dl.divergent,
    subject,
    primary,
    secondary,
    modelOverrides,
    maxChunkTokens,
  );
  return {
    ...combined,
    models: deduplicateModelIdentities([...(combined.models ?? []), ...models]),
    deliberation: {
      ...dl,
      divergent: dl.divergent.map((d, i) =>
        adjudications[i] ? { ...d, adjudication: adjudications[i] } : d,
      ),
      ...(failures.length > 0 ? { cross_review_failures: failures } : {}),
    },
  };
}

async function maybeAdjudicatePlan(
  combined: PlanReviewResult,
  subject: string,
  primary: ReviewBackend,
  secondary: ReviewBackend,
  crossReview: boolean,
  modelOverrides: DeliberationModelOverrides,
  maxChunkTokens?: number,
): Promise<PlanReviewResult> {
  const dl = combined.deliberation;
  if (!crossReview || !dl || dl.divergent.length === 0) return combined;
  const { adjudications, failures, models } = await adjudicateDivergent(
    dl.divergent,
    subject,
    primary,
    secondary,
    modelOverrides,
    maxChunkTokens,
  );
  return {
    ...combined,
    models: deduplicateModelIdentities([...(combined.models ?? []), ...models]),
    deliberation: {
      ...dl,
      divergent: dl.divergent.map((d, i) =>
        adjudications[i] ? { ...d, adjudication: adjudications[i] } : d,
      ),
      ...(failures.length > 0 ? { cross_review_failures: failures } : {}),
    },
  };
}

// Resolve which leaf owns a resumed session. Unknown owner → primary (T-027's
// fail-open default: legacy/untagged sessions resume on the primary).
function ownerLeafFor(
  sessionId: string,
  primary: ReviewBackend,
  secondary: ReviewBackend,
  lookup?: SessionProviderLookup,
): Result<{ ownerLeaf: ReviewBackend; otherLeaf: ReviewBackend }> {
  const ownerResult = lookupSessionOwner(sessionId, lookup);
  if (!ownerResult.ok) return ownerResult;
  const owner = ownerResult.data;
  const ownerLeaf = owner && secondary.providers.includes(owner) ? secondary : primary;
  return ok({ ownerLeaf, otherLeaf: ownerLeaf === primary ? secondary : primary });
}

export async function deliberatePlan(
  primary: ReviewBackend,
  secondary: ReviewBackend,
  input: PlanReviewInput,
  crossReview: boolean,
  lookup?: SessionProviderLookup,
  maxChunkTokens?: number,
): Promise<Result<PlanReviewResult>> {
  if (input.session_id) {
    // Deliberate-on-resume (ISS-010): the OWNER resumes its session; the other
    // leaf reviews fresh. A model override belongs to the resumed owner; the
    // fresh other provider resolves its own default.
    const owner = ownerLeafFor(input.session_id, primary, secondary, lookup);
    if (!owner.ok) return err<PlanReviewResult>(owner.error);
    const { ownerLeaf, otherLeaf } = owner.data;
    if (input.model && !canOverrideModelOnResume(ownerLeaf, ownerLeaf.provider)) {
      return err<PlanReviewResult>(sessionModelConflictMessage());
    }
    const carried = carriedModel(input.model);
    const modelOverrides: DeliberationModelOverrides =
      ownerLeaf === primary
        ? { primary: input.model, secondary: carried }
        : { primary: carried, secondary: input.model };
    const [ownerRes, otherRes] = await Promise.all([
      resultFromProviderCall(() => ownerLeaf.reviewPlan(input)),
      resultFromProviderCall(() =>
        otherLeaf.reviewPlan({
          ...input,
          session_id: undefined,
          model: carried,
        }),
      ),
    ]);
    // Map owner/other back to primary/secondary Results (used for both the combine
    // and the primary-led bothFailed message).
    const primaryRes = ownerLeaf === primary ? ownerRes : otherRes;
    const secondaryRes = ownerLeaf === primary ? otherRes : ownerRes;
    if (ownerRes.ok && otherRes.ok && primaryRes.ok && secondaryRes.ok) {
      const combined = combinePlan(
        primary.provider,
        primaryRes.data,
        secondary.provider,
        secondaryRes.data,
        ownerRes.data.session_id,
      );
      return ok(
        await maybeAdjudicatePlan(
          combined,
          input.plan,
          primary,
          secondary,
          crossReview,
          modelOverrides,
          maxChunkTokens,
        ),
      );
    }
    if (ownerRes.ok)
      return ok(
        degradePlan(ownerLeaf.provider, ownerRes.data, otherLeaf.provider, errOf(otherRes)),
      );
    if (otherRes.ok)
      return ok(
        degradePlan(otherLeaf.provider, otherRes.data, ownerLeaf.provider, errOf(ownerRes)),
      );
    return err<PlanReviewResult>(
      bothFailed(errOf(primaryRes), secondary.provider, errOf(secondaryRes)),
    );
  }

  const [ra, rb] = await Promise.all([
    resultFromProviderCall(() => primary.reviewPlan(input)),
    resultFromProviderCall(() =>
      secondary.reviewPlan({ ...input, model: carriedModel(input.model) }),
    ),
  ]);
  if (ra.ok && rb.ok) {
    const combined = combinePlan(primary.provider, ra.data, secondary.provider, rb.data);
    return ok(
      await maybeAdjudicatePlan(
        combined,
        input.plan,
        primary,
        secondary,
        crossReview,
        { primary: input.model, secondary: carriedModel(input.model) },
        maxChunkTokens,
      ),
    );
  }
  if (ra.ok) return ok(degradePlan(primary.provider, ra.data, secondary.provider, errOf(rb)));
  if (rb.ok) return ok(degradePlan(secondary.provider, rb.data, primary.provider, errOf(ra)));
  return err<PlanReviewResult>(bothFailed(errOf(ra), secondary.provider, errOf(rb)));
}

export async function deliberateCode(
  primary: ReviewBackend,
  secondary: ReviewBackend,
  input: CodeReviewInput,
  crossReview: boolean,
  lookup?: SessionProviderLookup,
  maxChunkTokens?: number,
): Promise<Result<CodeReviewResult>> {
  if (input.session_id) {
    const owner = ownerLeafFor(input.session_id, primary, secondary, lookup);
    if (!owner.ok) return err<CodeReviewResult>(owner.error);
    const { ownerLeaf, otherLeaf } = owner.data;
    if (input.model && !canOverrideModelOnResume(ownerLeaf, ownerLeaf.provider)) {
      return err<CodeReviewResult>(sessionModelConflictMessage());
    }
    const carried = carriedModel(input.model);
    const modelOverrides: DeliberationModelOverrides =
      ownerLeaf === primary
        ? { primary: input.model, secondary: carried }
        : { primary: carried, secondary: input.model };
    const [ownerRes, otherRes] = await Promise.all([
      resultFromProviderCall(() => ownerLeaf.reviewCode(input)),
      resultFromProviderCall(() =>
        otherLeaf.reviewCode({
          ...input,
          session_id: undefined,
          model: carried,
        }),
      ),
    ]);
    const primaryRes = ownerLeaf === primary ? ownerRes : otherRes;
    const secondaryRes = ownerLeaf === primary ? otherRes : ownerRes;
    if (ownerRes.ok && otherRes.ok && primaryRes.ok && secondaryRes.ok) {
      const combined = combineCode(
        primary.provider,
        primaryRes.data,
        secondary.provider,
        secondaryRes.data,
        ownerRes.data.session_id,
      );
      return ok(
        await maybeAdjudicateCode(
          combined,
          input.diff,
          primary,
          secondary,
          crossReview,
          modelOverrides,
          maxChunkTokens,
        ),
      );
    }
    if (ownerRes.ok)
      return ok(
        degradeCode(ownerLeaf.provider, ownerRes.data, otherLeaf.provider, errOf(otherRes)),
      );
    if (otherRes.ok)
      return ok(
        degradeCode(otherLeaf.provider, otherRes.data, ownerLeaf.provider, errOf(ownerRes)),
      );
    return err<CodeReviewResult>(
      bothFailed(errOf(primaryRes), secondary.provider, errOf(secondaryRes)),
    );
  }

  const [ra, rb] = await Promise.all([
    resultFromProviderCall(() => primary.reviewCode(input)),
    resultFromProviderCall(() =>
      secondary.reviewCode({ ...input, model: carriedModel(input.model) }),
    ),
  ]);
  if (ra.ok && rb.ok) {
    const combined = combineCode(primary.provider, ra.data, secondary.provider, rb.data);
    return ok(
      await maybeAdjudicateCode(
        combined,
        input.diff,
        primary,
        secondary,
        crossReview,
        { primary: input.model, secondary: carriedModel(input.model) },
        maxChunkTokens,
      ),
    );
  }
  if (ra.ok) return ok(degradeCode(primary.provider, ra.data, secondary.provider, errOf(rb)));
  if (rb.ok) return ok(degradeCode(secondary.provider, rb.data, primary.provider, errOf(ra)));
  return err<CodeReviewResult>(bothFailed(errOf(ra), secondary.provider, errOf(rb)));
}

export function createDeliberationBackend(
  primary: ReviewBackend,
  secondary: ReviewBackend,
  opts: { crossReview?: boolean; lookup?: SessionProviderLookup; maxChunkTokens?: number } = {},
): ReviewBackend {
  // deliberate-deep: after each provider reviews independently, the OTHER
  // provider adjudicates its divergent findings (confirmed/disputed/unsure).
  const crossReview = opts.crossReview ?? false;
  const lookup = opts.lookup;
  // Budget for the cross-review subject (ISS-012). Undefined = unbounded.
  const maxChunkTokens = opts.maxChunkTokens;
  return {
    // Presents as the primary for tagging, while owner-aware capability lookup
    // and resume routing both target the leaf that owns the session (ISS-011).
    provider: primary.provider,
    providers: [...primary.providers, ...secondary.providers],
    allowsModelOverrideOnResume: primary.allowsModelOverrideOnResume,
    allowsModelOverrideOnResumeFor: (provider) => {
      const owner = primary.providers.includes(provider)
        ? primary
        : secondary.providers.includes(provider)
          ? secondary
          : null;
      return owner ? canOverrideModelOnResume(owner, provider) : false;
    },
    reviewPlan: (input: PlanReviewInput) =>
      deliberatePlan(primary, secondary, input, crossReview, lookup, maxChunkTokens),
    reviewCode: (input: CodeReviewInput) =>
      deliberateCode(primary, secondary, input, crossReview, lookup, maxChunkTokens),
    // Precommit stays failover — it runs constantly and is latency-sensitive. It
    // still routes resumes to the owning leaf via the same lookup.
    reviewPrecommit: (input: PrecommitReviewInput) =>
      withFailover(primary, secondary, input, (b, i) => b.reviewPrecommit(i), lookup),
  };
}
