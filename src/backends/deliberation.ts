import { ok, err } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import type { ReviewProvider } from '../config/types.js';
import {
  CodeFindingSeveritySchema,
  PlanFindingSeveritySchema,
} from '../review/types.js';
import type { PlanReviewResult, CodeReviewResult } from '../review/types.js';
import { withFailover } from './failover.js';
import type { SessionProviderLookup } from './failover.js';
import { sliceDiffToFiles } from '../utils/diff-files.js';
import { estimateTokens } from '../utils/chunking.js';
import type {
  ReviewBackend,
  PlanReviewInput,
  CodeReviewInput,
  PrecommitReviewInput,
} from './backend.js';

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

// Split two providers' findings into those both flagged (agreed, keeping the
// higher-severity representative) and those only one flagged (divergent).
export function computeAgreement<F extends AnyFinding>(
  a: { provider: ReviewProvider; findings: F[] },
  b: { provider: ReviewProvider; findings: F[] },
  rankOf: (severity: string) => number,
): Agreement<F> {
  const map = new Map<string, { a?: F; b?: F }>();
  const divergent: { provider: ReviewProvider; finding: F }[] = [];

  // Add one provider's findings to its side of the map. Keyless findings (no
  // file/line) can't be matched → divergent. When a provider reports the same
  // key twice, keep the higher-severity one (mirrors deduplicateFindings) rather
  // than letting the last silently win.
  const put = (side: 'a' | 'b', provider: ReviewProvider, findings: F[]): void => {
    for (const f of findings) {
      const k = keyOf(f);
      if (k === null) {
        divergent.push({ provider, finding: f });
        continue;
      }
      const entry = map.get(k) ?? {};
      const existing = entry[side];
      if (!existing || rankOf(f.severity) > rankOf(existing.severity)) {
        entry[side] = f;
        map.set(k, entry);
      }
    }
  };
  put('a', a.provider, a.findings);
  put('b', b.provider, b.findings);

  const agreed: F[] = [];
  for (const { a: fa, b: fb } of map.values()) {
    if (fa && fb) agreed.push(rankOf(fa.severity) >= rankOf(fb.severity) ? fa : fb);
    else if (fa) divergent.push({ provider: a.provider, finding: fa });
    else if (fb) divergent.push({ provider: b.provider, finding: fb });
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
  const verdict = CODE_VERDICT_RANK[ra.verdict] >= CODE_VERDICT_RANK[rb.verdict] ? ra.verdict : rb.verdict;
  return {
    verdict,
    summary: joinSummaries(ra.summary, rb.summary),
    findings: [...agreed, ...divergent.map((d) => d.finding)],
    session_id: sessionId ?? ra.session_id,
    provider: p,
    // Surface the primary's chunk count at top level (the presented result).
    ...(ra.chunks_reviewed !== undefined ? { chunks_reviewed: ra.chunks_reviewed } : {}),
    deliberation: {
      providers: [p, s],
      verdicts: [
        { provider: p, verdict: ra.verdict, ...(ra.chunks_reviewed !== undefined ? { chunks_reviewed: ra.chunks_reviewed } : {}) },
        { provider: s, verdict: rb.verdict, ...(rb.chunks_reviewed !== undefined ? { chunks_reviewed: rb.chunks_reviewed } : {}) },
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
  const verdict = PLAN_VERDICT_RANK[ra.verdict] >= PLAN_VERDICT_RANK[rb.verdict] ? ra.verdict : rb.verdict;
  return {
    verdict,
    summary: joinSummaries(ra.summary, rb.summary),
    findings: [...agreed, ...divergent.map((d) => d.finding)],
    session_id: sessionId ?? ra.session_id,
    provider: p,
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

type Adjudication = { by: ReviewProvider; verdict: 'confirmed' | 'disputed' | 'unsure'; reason: string };
type CrossFinding = AnyFinding & { description: string };
type CrossReviewFailure = { by: ReviewProvider; reason: string };
type AdjudicateResult = { adjudications: (Adjudication | undefined)[]; failure?: CrossReviewFailure };

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
  if (findings.length === 0 || !judge.crossReview) return { adjudications: out };
  // ISS-012: slice the subject to only the files these findings touch so a large
  // diff doesn't blow the single adjudication turn. Plans / no-file findings fall
  // back to the full subject. If it's STILL over budget, fail this adjudication
  // cleanly (bounded cost) — surfaced via cross_review_failures, no multi-turn.
  const wanted = new Set(findings.map((f) => f.file).filter((f): f is string => typeof f === 'string'));
  const subject = sliceDiffToFiles(content, wanted);
  if (maxChunkTokens !== undefined && estimateTokens(subject) > maxChunkTokens) {
    return {
      adjudications: out,
      failure: {
        by: judge.provider,
        reason: `cross-review subject exceeds max_chunk_tokens (${estimateTokens(subject)} > ${maxChunkTokens}) even after slicing to referenced files`,
      },
    };
  }
  const res = await judge.crossReview({
    content: subject,
    findings: findings.map((f) => ({
      severity: f.severity,
      category: f.category,
      file: f.file,
      line: f.line,
      description: f.description,
    })),
    model,
  });
  if (!res.ok) return { adjudications: out, failure: { by: judge.provider, reason: res.error } };
  for (const a of res.data.adjudications) {
    if (a.index >= 0 && a.index < findings.length) {
      out[a.index] = { by: judge.provider, verdict: a.verdict, reason: a.reason };
    }
  }
  return { adjudications: out };
}

// Each provider's divergent findings are adjudicated by the OTHER provider (in
// parallel). Returns adjudications aligned to the input `divergent` order, plus
// any per-judge failures (both judges can fail independently).
async function adjudicateDivergent(
  divergent: { provider: ReviewProvider; finding: CrossFinding }[],
  content: string,
  primary: ReviewBackend,
  secondary: ReviewBackend,
  primaryModel?: string,
  maxChunkTokens?: number,
): Promise<{ adjudications: (Adjudication | undefined)[]; failures: CrossReviewFailure[] }> {
  const byPrimary = divergent.filter((d) => d.provider === primary.provider);
  const bySecondary = divergent.filter((d) => d.provider === secondary.provider);
  const [secAdj, priAdj] = await Promise.all([
    // The primary's model override applies to the PRIMARY judge only; the
    // secondary judge resolves its own default (same convention as reviews).
    runAdjudicate(secondary, content, byPrimary.map((d) => d.finding), undefined, maxChunkTokens),
    runAdjudicate(primary, content, bySecondary.map((d) => d.finding), primaryModel, maxChunkTokens),
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
  return { adjudications: out, failures };
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
  primaryModel?: string,
  maxChunkTokens?: number,
): Promise<CodeReviewResult> {
  const dl = combined.deliberation;
  if (!crossReview || !dl || dl.divergent.length === 0) return combined;
  const { adjudications, failures } = await adjudicateDivergent(dl.divergent, subject, primary, secondary, primaryModel, maxChunkTokens);
  return {
    ...combined,
    deliberation: {
      ...dl,
      divergent: dl.divergent.map((d, i) => (adjudications[i] ? { ...d, adjudication: adjudications[i] } : d)),
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
  primaryModel?: string,
  maxChunkTokens?: number,
): Promise<PlanReviewResult> {
  const dl = combined.deliberation;
  if (!crossReview || !dl || dl.divergent.length === 0) return combined;
  const { adjudications, failures } = await adjudicateDivergent(dl.divergent, subject, primary, secondary, primaryModel, maxChunkTokens);
  return {
    ...combined,
    deliberation: {
      ...dl,
      divergent: dl.divergent.map((d, i) => (adjudications[i] ? { ...d, adjudication: adjudications[i] } : d)),
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
): { ownerLeaf: ReviewBackend; otherLeaf: ReviewBackend } {
  const owner = lookup?.(sessionId) ?? null;
  const ownerLeaf = owner && secondary.providers.includes(owner) ? secondary : primary;
  return { ownerLeaf, otherLeaf: ownerLeaf === primary ? secondary : primary };
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
    // leaf reviews fresh. Each leaf gets input.model only if it is the primary.
    const { ownerLeaf, otherLeaf } = ownerLeafFor(input.session_id, primary, secondary, lookup);
    const [ownerRes, otherRes] = await Promise.all([
      ownerLeaf.reviewPlan({ ...input, model: ownerLeaf === primary ? input.model : undefined }),
      otherLeaf.reviewPlan({ ...input, session_id: undefined, model: otherLeaf === primary ? input.model : undefined }),
    ]);
    // Map owner/other back to primary/secondary Results (used for both the combine
    // and the primary-led bothFailed message).
    const primaryRes = ownerLeaf === primary ? ownerRes : otherRes;
    const secondaryRes = ownerLeaf === primary ? otherRes : ownerRes;
    if (ownerRes.ok && otherRes.ok && primaryRes.ok && secondaryRes.ok) {
      const combined = combinePlan(primary.provider, primaryRes.data, secondary.provider, secondaryRes.data, ownerRes.data.session_id);
      return ok(await maybeAdjudicatePlan(combined, input.plan, primary, secondary, crossReview, input.model, maxChunkTokens));
    }
    if (ownerRes.ok) return ok(degradePlan(ownerLeaf.provider, ownerRes.data, otherLeaf.provider, errOf(otherRes)));
    if (otherRes.ok) return ok(degradePlan(otherLeaf.provider, otherRes.data, ownerLeaf.provider, errOf(ownerRes)));
    return err<PlanReviewResult>(bothFailed(errOf(primaryRes), secondary.provider, errOf(secondaryRes)));
  }

  const [ra, rb] = await Promise.all([
    primary.reviewPlan(input),
    secondary.reviewPlan({ ...input, model: undefined }),
  ]);
  if (ra.ok && rb.ok) {
    const combined = combinePlan(primary.provider, ra.data, secondary.provider, rb.data);
    return ok(await maybeAdjudicatePlan(combined, input.plan, primary, secondary, crossReview, input.model, maxChunkTokens));
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
    const { ownerLeaf, otherLeaf } = ownerLeafFor(input.session_id, primary, secondary, lookup);
    const [ownerRes, otherRes] = await Promise.all([
      ownerLeaf.reviewCode({ ...input, model: ownerLeaf === primary ? input.model : undefined }),
      otherLeaf.reviewCode({ ...input, session_id: undefined, model: otherLeaf === primary ? input.model : undefined }),
    ]);
    const primaryRes = ownerLeaf === primary ? ownerRes : otherRes;
    const secondaryRes = ownerLeaf === primary ? otherRes : ownerRes;
    if (ownerRes.ok && otherRes.ok && primaryRes.ok && secondaryRes.ok) {
      const combined = combineCode(primary.provider, primaryRes.data, secondary.provider, secondaryRes.data, ownerRes.data.session_id);
      return ok(await maybeAdjudicateCode(combined, input.diff, primary, secondary, crossReview, input.model, maxChunkTokens));
    }
    if (ownerRes.ok) return ok(degradeCode(ownerLeaf.provider, ownerRes.data, otherLeaf.provider, errOf(otherRes)));
    if (otherRes.ok) return ok(degradeCode(otherLeaf.provider, otherRes.data, ownerLeaf.provider, errOf(ownerRes)));
    return err<CodeReviewResult>(bothFailed(errOf(primaryRes), secondary.provider, errOf(secondaryRes)));
  }

  const [ra, rb] = await Promise.all([
    primary.reviewCode(input),
    secondary.reviewCode({ ...input, model: undefined }),
  ]);
  if (ra.ok && rb.ok) {
    const combined = combineCode(primary.provider, ra.data, secondary.provider, rb.data);
    return ok(await maybeAdjudicateCode(combined, input.diff, primary, secondary, crossReview, input.model, maxChunkTokens));
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
    // Presents as the primary for tagging + the session_id/model gate; but a
    // resumed session routes to its OWNING leaf via lookup (ISS-011). The
    // allowsModelOverrideOnResume gate stays the primary's conservative one — a
    // secondary-owned resume combined with a model override may still be rejected;
    // acceptable, out of scope for T-027.
    provider: primary.provider,
    providers: [...primary.providers, ...secondary.providers],
    allowsModelOverrideOnResume: primary.allowsModelOverrideOnResume,
    reviewPlan: (input: PlanReviewInput) => deliberatePlan(primary, secondary, input, crossReview, lookup, maxChunkTokens),
    reviewCode: (input: CodeReviewInput) => deliberateCode(primary, secondary, input, crossReview, lookup, maxChunkTokens),
    // Precommit stays failover — it runs constantly and is latency-sensitive. It
    // still routes resumes to the owning leaf via the same lookup.
    reviewPrecommit: (input: PrecommitReviewInput) =>
      withFailover(primary, secondary, input, (b, i) => b.reviewPrecommit(i), lookup),
  };
}
