import { z } from 'zod';

// Separate severity enums: plan uses 'suggestion', code uses 'nitpick'
export const PlanFindingSeveritySchema = z.enum(['critical', 'major', 'minor', 'suggestion']);
export const CodeFindingSeveritySchema = z.enum(['critical', 'major', 'minor', 'nitpick']);
// Union for contexts that accept any severity (storage, history, config)
export const FindingSeveritySchema = z.enum([
  'critical',
  'major',
  'minor',
  'suggestion',
  'nitpick',
]);

const BaseFindingFields = {
  category: z.string(),
  description: z.string(),
  file: z.string().nullable(),
  line: z.preprocess(
    v => {
      if (v === '' || v === null || v === undefined) return null;
      if (typeof v === 'string' || typeof v === 'number') return v;
      return null;
    },
    z.coerce.number().int().positive().nullable(),
  ),
  suggestion: z.string().nullable(),
};

export const PlanFindingSchema = z.object({
  severity: PlanFindingSeveritySchema,
  ...BaseFindingFields,
});

export const CodeFindingSchema = z.object({
  severity: CodeFindingSeveritySchema,
  ...BaseFindingFields,
});

// General ReviewFinding accepts all severities (used for storage/history)
export const ReviewFindingSchema = z.object({
  severity: FindingSeveritySchema,
  ...BaseFindingFields,
});

// The backend that actually produced this result. Set by each backend on its
// own results; under provider failover it reflects the provider that served the
// review (which may differ from the configured primary). Optional/additive.
const ReviewProviderEnum = z.enum(['codex', 'gemini']);
const ServingProviderSchema = ReviewProviderEnum.optional();

// Deliberation metadata: when both providers review the same input, the bridge
// reports each provider's verdict and splits findings into those BOTH flagged
// (high confidence) vs. only one flagged (needs judgment) so the caller can
// synthesize. Additive/optional — consumers that ignore it still get a coherent
// merged result. `degraded` is set when only one provider could review (the
// other was out of usage), i.e. the result is effectively a single-provider one.
function deliberationSchema<F extends z.ZodTypeAny>(findingSchema: F) {
  return z
    .object({
      providers: z.array(ReviewProviderEnum),
      verdicts: z.array(z.object({ provider: ReviewProviderEnum, verdict: z.string() })),
      agreement: z.enum(['agree', 'mixed', 'conflict']),
      agreed: z.array(findingSchema),
      divergent: z.array(
        z.object({
          provider: ReviewProviderEnum,
          finding: findingSchema,
          // Present under `deliberate-deep`: the OTHER provider's adjudication of
          // this one-sided finding after a cross-review round.
          adjudication: z
            .object({
              by: ReviewProviderEnum,
              verdict: z.enum(['confirmed', 'disputed', 'unsure']),
              reason: z.string(),
            })
            .optional(),
        }),
      ),
      degraded: z.object({ failed: ReviewProviderEnum, reason: z.string() }).optional(),
    })
    .optional();
}

export const PlanReviewResultSchema = z.object({
  verdict: z.enum(['approve', 'revise', 'reject']),
  summary: z.string(),
  findings: z.array(PlanFindingSchema),
  session_id: z.string(),
  provider: ServingProviderSchema,
  deliberation: deliberationSchema(PlanFindingSchema),
});

export const CodeReviewResultSchema = z.object({
  verdict: z.enum(['approve', 'request_changes', 'reject']),
  summary: z.string(),
  findings: z.array(CodeFindingSchema),
  session_id: z.string(),
  chunks_reviewed: z.number().int().positive().optional(),
  provider: ServingProviderSchema,
  deliberation: deliberationSchema(CodeFindingSchema),
});

export const PrecommitResultSchema = z.object({
  ready_to_commit: z.boolean(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  session_id: z.string(),
  chunks_reviewed: z.number().int().positive().optional(),
  provider: ServingProviderSchema,
});

// Cross-review (deliberate-deep): a provider's adjudication of another reviewer's
// findings. `index` refers to the position of the finding in the input list.
export const CrossReviewResultSchema = z.object({
  adjudications: z.array(
    z.object({
      index: z.number().int(),
      verdict: z.enum(['confirmed', 'disputed', 'unsure']),
      reason: z.string(),
    }),
  ),
});

export const ReviewStatusSchema = z.object({
  status: z.enum(['in_progress', 'completed', 'failed', 'not_found']),
  session_id: z.string(),
  progress: z.string().optional(),
  elapsed_seconds: z.number().optional(),
});

export const VerdictSchema = z.enum(['approve', 'revise', 'reject', 'request_changes']);

export const ReviewHistoryEntrySchema = z.object({
  session_id: z.string(),
  type: z.enum(['plan', 'code', 'precommit']),
  verdict: VerdictSchema,
  timestamp: z.string(),
  summary: z.string(),
  // Which provider produced the review, joined from the sessions table. Null
  // for legacy reviews whose session predates provider tagging.
  provider: z.string().nullable(),
});

// Inferred types for use across the codebase
export type PlanFindingSeverity = z.infer<typeof PlanFindingSeveritySchema>;
export type CodeFindingSeverity = z.infer<typeof CodeFindingSeveritySchema>;
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;
export type PlanFinding = z.infer<typeof PlanFindingSchema>;
export type CodeFinding = z.infer<typeof CodeFindingSchema>;
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type PlanReviewResult = z.infer<typeof PlanReviewResultSchema>;
export type CodeReviewResult = z.infer<typeof CodeReviewResultSchema>;
export type PrecommitResult = z.infer<typeof PrecommitResultSchema>;
export type CrossReviewResult = z.infer<typeof CrossReviewResultSchema>;
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
export type ReviewHistoryEntry = z.infer<typeof ReviewHistoryEntrySchema>;
