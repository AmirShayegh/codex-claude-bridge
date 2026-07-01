import { ok, err } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import type { ReviewProvider } from '../config/types.js';
import {
  CodeFindingSeveritySchema,
  PlanFindingSeveritySchema,
} from '../codex/types.js';
import type { PlanReviewResult, CodeReviewResult } from '../codex/types.js';
import { withFailover } from './failover.js';
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

async function deliberatePlan(
  primary: ReviewBackend,
  secondary: ReviewBackend,
  input: PlanReviewInput,
): Promise<Result<PlanReviewResult>> {
  // A resumed session belongs to one provider — can't deliberate it. Fall through
  // to failover (delegates to the primary; the cross-provider guard handles it).
  if (input.session_id) return withFailover(primary, secondary, input, (b, i) => b.reviewPlan(i));

  const [ra, rb] = await Promise.all([
    primary.reviewPlan(input),
    secondary.reviewPlan({ ...input, model: undefined }),
  ]);
  if (ra.ok && rb.ok) return ok(combinePlan(primary.provider, ra.data, secondary.provider, rb.data));
  if (ra.ok) return ok(degradePlan(primary.provider, ra.data, secondary.provider, errOf(rb)));
  if (rb.ok) return ok(degradePlan(secondary.provider, rb.data, primary.provider, errOf(ra)));
  return err<PlanReviewResult>(bothFailed(errOf(ra), secondary.provider, errOf(rb)));
}

async function deliberateCode(
  primary: ReviewBackend,
  secondary: ReviewBackend,
  input: CodeReviewInput,
): Promise<Result<CodeReviewResult>> {
  if (input.session_id) return withFailover(primary, secondary, input, (b, i) => b.reviewCode(i));

  const [ra, rb] = await Promise.all([
    primary.reviewCode(input),
    secondary.reviewCode({ ...input, model: undefined }),
  ]);
  if (ra.ok && rb.ok) return ok(combineCode(primary.provider, ra.data, secondary.provider, rb.data));
  if (ra.ok) return ok(degradeCode(primary.provider, ra.data, secondary.provider, errOf(rb)));
  if (rb.ok) return ok(degradeCode(secondary.provider, rb.data, primary.provider, errOf(ra)));
  return err<CodeReviewResult>(bothFailed(errOf(ra), secondary.provider, errOf(rb)));
}

export function createDeliberationBackend(
  primary: ReviewBackend,
  secondary: ReviewBackend,
): ReviewBackend {
  return {
    // Presents as the primary: resumes route to it, and the tool's cross-provider
    // guard + session_id/model gate key off these.
    provider: primary.provider,
    allowsModelOverrideOnResume: primary.allowsModelOverrideOnResume,
    reviewPlan: (input: PlanReviewInput) => deliberatePlan(primary, secondary, input),
    reviewCode: (input: CodeReviewInput) => deliberateCode(primary, secondary, input),
    // Precommit stays failover — it runs constantly and is latency-sensitive.
    reviewPrecommit: (input: PrecommitReviewInput) =>
      withFailover(primary, secondary, input, (b, i) => b.reviewPrecommit(i)),
  };
}
