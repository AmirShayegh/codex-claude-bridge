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
): CodeReviewResult {
  const { agreed, divergent } = computeAgreement(
    { provider: p, findings: ra.findings },
    { provider: s, findings: rb.findings },
    codeRank,
  );
  const verdict = CODE_VERDICT_RANK[ra.verdict] >= CODE_VERDICT_RANK[rb.verdict] ? ra.verdict : rb.verdict;
  return {
    verdict,
    summary: joinSummaries(ra.summary, rb.summary),
    findings: [...agreed, ...divergent.map((d) => d.finding)],
    session_id: ra.session_id,
    provider: p,
    deliberation: {
      providers: [p, s],
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

function combinePlan(
  p: ReviewProvider,
  ra: PlanReviewResult,
  s: ReviewProvider,
  rb: PlanReviewResult,
): PlanReviewResult {
  const { agreed, divergent } = computeAgreement(
    { provider: p, findings: ra.findings },
    { provider: s, findings: rb.findings },
    planRank,
  );
  const verdict = PLAN_VERDICT_RANK[ra.verdict] >= PLAN_VERDICT_RANK[rb.verdict] ? ra.verdict : rb.verdict;
  return {
    verdict,
    summary: joinSummaries(ra.summary, rb.summary),
    findings: [...agreed, ...divergent.map((d) => d.finding)],
    session_id: ra.session_id,
    provider: p,
    deliberation: {
      providers: [p, s],
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
      agreement: 'agree',
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
      agreement: 'agree',
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

// Ask `judge` to adjudicate `findings` (from the other provider) against the
// change. Returns adjudications aligned to `findings` (undefined where none).
// Best-effort: a missing capability or a failed call leaves findings un-adjudicated.
async function runAdjudicate(
  judge: ReviewBackend,
  content: string,
  findings: CrossFinding[],
): Promise<(Adjudication | undefined)[]> {
  const out: (Adjudication | undefined)[] = new Array(findings.length).fill(undefined);
  if (findings.length === 0 || !judge.crossReview) return out;
  const res = await judge.crossReview({
    content,
    findings: findings.map((f) => ({
      severity: f.severity,
      category: f.category,
      file: f.file,
      line: f.line,
      description: f.description,
    })),
  });
  if (!res.ok) return out;
  for (const a of res.data.adjudications) {
    if (a.index >= 0 && a.index < findings.length) {
      out[a.index] = { by: judge.provider, verdict: a.verdict, reason: a.reason };
    }
  }
  return out;
}

// Each provider's divergent findings are adjudicated by the OTHER provider (in
// parallel). Returns adjudications aligned to the input `divergent` order.
async function adjudicateDivergent(
  divergent: { provider: ReviewProvider; finding: CrossFinding }[],
  content: string,
  primary: ReviewBackend,
  secondary: ReviewBackend,
): Promise<(Adjudication | undefined)[]> {
  const byPrimary = divergent.filter((d) => d.provider === primary.provider);
  const bySecondary = divergent.filter((d) => d.provider === secondary.provider);
  const [secAdj, priAdj] = await Promise.all([
    runAdjudicate(secondary, content, byPrimary.map((d) => d.finding)),
    runAdjudicate(primary, content, bySecondary.map((d) => d.finding)),
  ]);
  const out: (Adjudication | undefined)[] = new Array(divergent.length).fill(undefined);
  let si = 0;
  let pi = 0;
  for (let i = 0; i < divergent.length; i++) {
    if (divergent[i].provider === primary.provider) out[i] = secAdj[si++];
    else if (divergent[i].provider === secondary.provider) out[i] = priAdj[pi++];
  }
  return out;
}

async function deliberatePlan(
  primary: ReviewBackend,
  secondary: ReviewBackend,
  input: PlanReviewInput,
  crossReview: boolean,
  lookup?: SessionProviderLookup,
): Promise<Result<PlanReviewResult>> {
  // A resumed session belongs to one provider — can't deliberate it. Fall through
  // to failover, which routes to the session's OWNING leaf via lookup (ISS-011).
  if (input.session_id) return withFailover(primary, secondary, input, (b, i) => b.reviewPlan(i), lookup);

  const [ra, rb] = await Promise.all([
    primary.reviewPlan(input),
    secondary.reviewPlan({ ...input, model: undefined }),
  ]);
  if (ra.ok && rb.ok) {
    const combined = combinePlan(primary.provider, ra.data, secondary.provider, rb.data);
    const dl = combined.deliberation;
    if (!crossReview || !dl || dl.divergent.length === 0) return ok(combined);
    const adjs = await adjudicateDivergent(dl.divergent, input.plan, primary, secondary);
    return ok({
      ...combined,
      deliberation: {
        ...dl,
        divergent: dl.divergent.map((d, i) => (adjs[i] ? { ...d, adjudication: adjs[i] } : d)),
      },
    });
  }
  if (ra.ok) return ok(degradePlan(primary.provider, ra.data, secondary.provider, errOf(rb)));
  if (rb.ok) return ok(degradePlan(secondary.provider, rb.data, primary.provider, errOf(ra)));
  return err<PlanReviewResult>(bothFailed(errOf(ra), secondary.provider, errOf(rb)));
}

async function deliberateCode(
  primary: ReviewBackend,
  secondary: ReviewBackend,
  input: CodeReviewInput,
  crossReview: boolean,
  lookup?: SessionProviderLookup,
): Promise<Result<CodeReviewResult>> {
  if (input.session_id) return withFailover(primary, secondary, input, (b, i) => b.reviewCode(i), lookup);

  const [ra, rb] = await Promise.all([
    primary.reviewCode(input),
    secondary.reviewCode({ ...input, model: undefined }),
  ]);
  if (ra.ok && rb.ok) {
    const combined = combineCode(primary.provider, ra.data, secondary.provider, rb.data);
    const dl = combined.deliberation;
    if (!crossReview || !dl || dl.divergent.length === 0) return ok(combined);
    const adjs = await adjudicateDivergent(dl.divergent, input.diff, primary, secondary);
    return ok({
      ...combined,
      deliberation: {
        ...dl,
        divergent: dl.divergent.map((d, i) => (adjs[i] ? { ...d, adjudication: adjs[i] } : d)),
      },
    });
  }
  if (ra.ok) return ok(degradeCode(primary.provider, ra.data, secondary.provider, errOf(rb)));
  if (rb.ok) return ok(degradeCode(secondary.provider, rb.data, primary.provider, errOf(ra)));
  return err<CodeReviewResult>(bothFailed(errOf(ra), secondary.provider, errOf(rb)));
}

export function createDeliberationBackend(
  primary: ReviewBackend,
  secondary: ReviewBackend,
  opts: { crossReview?: boolean; lookup?: SessionProviderLookup } = {},
): ReviewBackend {
  // deliberate-deep: after each provider reviews independently, the OTHER
  // provider adjudicates its divergent findings (confirmed/disputed/unsure).
  const crossReview = opts.crossReview ?? false;
  const lookup = opts.lookup;
  return {
    // Presents as the primary for tagging + the session_id/model gate; but a
    // resumed session routes to its OWNING leaf via lookup (ISS-011). The
    // allowsModelOverrideOnResume gate stays the primary's conservative one — a
    // secondary-owned resume combined with a model override may still be rejected;
    // acceptable, out of scope for T-027.
    provider: primary.provider,
    providers: [...primary.providers, ...secondary.providers],
    allowsModelOverrideOnResume: primary.allowsModelOverrideOnResume,
    reviewPlan: (input: PlanReviewInput) => deliberatePlan(primary, secondary, input, crossReview, lookup),
    reviewCode: (input: CodeReviewInput) => deliberateCode(primary, secondary, input, crossReview, lookup),
    // Precommit stays failover — it runs constantly and is latency-sensitive. It
    // still routes resumes to the owning leaf via the same lookup.
    reviewPrecommit: (input: PrecommitReviewInput) =>
      withFailover(primary, secondary, input, (b, i) => b.reviewPrecommit(i), lookup),
  };
}
