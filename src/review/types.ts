import { z } from 'zod';
import { ModelSelectorSchema, SessionIdSchema } from '../utils/input-validation.js';

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
  line: z.preprocess((v) => {
    if (v === '' || v === null || v === undefined) return null;
    if (typeof v === 'string' || typeof v === 'number') return v;
    return null;
  }, z.coerce.number().int().positive().nullable()),
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
export const ReviewProviderSchema = z.enum(['codex', 'gemini']);
const ReviewProviderEnum = ReviewProviderSchema;
const ServingProviderSchema = ReviewProviderEnum.optional();

export const ModelIdentitySchema = z.object({
  provider: ReviewProviderSchema,
  role: z.enum(['review', 'adjudication']),
  requested: ModelSelectorSchema.nullable(),
  resolved: ModelSelectorSchema.nullable(),
  observed: ModelSelectorSchema.nullable(),
  evidence: z.enum(['runtime_session_record', 'bridge_selection', 'unavailable']),
});

export const ReviewProvenanceSchema = z.object({
  persistence: z.enum(['durable', 'memory_only', 'not_recorded']),
  warning: z.string().nullable(),
});

const HostReviewMetadataFields = {
  // Additive for backward-compatible decoding. New successful bridge responses
  // always emit both fields; model-facing schemas must explicitly omit them.
  models: z.array(ModelIdentitySchema).optional(),
  provenance: ReviewProvenanceSchema.optional(),
};

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
      // Each provider's verdict, with the chunk count it reviewed (code only).
      verdicts: z.array(
        z.object({
          provider: ReviewProviderEnum,
          verdict: z.string(),
          chunks_reviewed: z.number().int().positive().optional(),
        }),
      ),
      // 'degraded' means only one provider could review (the other failed); the
      // `degraded` marker names the failed provider and reason.
      agreement: z.enum(['agree', 'mixed', 'conflict', 'degraded']),
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
      // Present under `deliberate-deep` when a cross-review adjudication turn
      // itself failed (e.g. the judge errored). Distinguishes "adjudication ran
      // and found nothing" from "adjudication could not run". Both judges can
      // fail independently, so this is an array.
      cross_review_failures: z
        .array(z.object({ by: ReviewProviderEnum, reason: z.string() }))
        .optional(),
    })
    .optional();
}

// Which composition actually served a review. Additive/optional: leaf results
// never set it; the composite and the single-mode decorator stamp it so the
// caller can tell single/failover/deliberate apart even when no deliberation
// block is present.
const ReviewModeSchema = z.enum(['single', 'failover', 'deliberate', 'deliberate-deep']).optional();

export const PlanReviewResultSchema = z.object({
  verdict: z.enum(['approve', 'revise', 'reject']),
  summary: z.string(),
  findings: z.array(PlanFindingSchema),
  session_id: SessionIdSchema,
  provider: ServingProviderSchema,
  review_mode: ReviewModeSchema,
  deliberation: deliberationSchema(PlanFindingSchema),
  ...HostReviewMetadataFields,
});

export const CodeReviewResultSchema = z.object({
  verdict: z.enum(['approve', 'request_changes', 'reject']),
  summary: z.string(),
  findings: z.array(CodeFindingSchema),
  session_id: SessionIdSchema,
  chunks_reviewed: z.number().int().positive().optional(),
  // Files each chunk held, in chunk order (index i ↔ chunk i+1). Present only
  // when the diff was split: a reader with a suspicion spanning two files can
  // see whether any single reviewer call ever saw both. Host-only, like
  // chunks_reviewed — never produced by the model.
  chunk_files: z.array(z.array(z.string())).optional(),
  // Absolute directory the bridge ran git in when it auto-captured this diff
  // (ISS-028). Present ONLY on an auto-captured result — omitted entirely for an
  // explicit diff. Host-only: the response boundary stamps it from the resolver,
  // the reviewer never produces it, and it is never persisted to history.
  captured_from: z.string().optional(),
  provider: ServingProviderSchema,
  review_mode: ReviewModeSchema,
  deliberation: deliberationSchema(CodeFindingSchema),
  ...HostReviewMetadataFields,
});

export const PrecommitResultSchema = z.object({
  ready_to_commit: z.boolean(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  session_id: SessionIdSchema,
  chunks_reviewed: z.number().int().positive().optional(),
  // Files each chunk held, in chunk order (index i ↔ chunk i+1). Present only
  // when the diff was split: a reader with a suspicion spanning two files can
  // see whether any single reviewer call ever saw both. Host-only, like
  // chunks_reviewed — never produced by the model.
  chunk_files: z.array(z.array(z.string())).optional(),
  // Absolute directory the bridge ran git in when it auto-captured this diff
  // (ISS-028). Present ONLY on an auto-captured result — omitted entirely for an
  // explicit diff. Host-only: the response boundary stamps it from the resolver,
  // the reviewer never produces it, and it is never persisted to history.
  captured_from: z.string().optional(),
  provider: ServingProviderSchema,
  review_mode: ReviewModeSchema,
  ...HostReviewMetadataFields,
});

// Cross-review (deliberate-deep): a provider's adjudication of another reviewer's
// findings. `index` refers to the position of the finding in the input list.
export const CrossReviewResponseSchema = z.object({
  adjudications: z.array(
    z.object({
      index: z.number().int(),
      verdict: z.enum(['confirmed', 'disputed', 'unsure']),
      reason: z.string(),
    }),
  ),
});

export const CrossReviewResultSchema = CrossReviewResponseSchema.extend({
  ...HostReviewMetadataFields,
});

export const ReviewStatusSchema = z.object({
  status: z.enum(['in_progress', 'completed', 'failed', 'not_found']),
  session_id: SessionIdSchema,
  progress: z.string().optional(),
  elapsed_seconds: z.number().optional(),
});

export const VerdictSchema = z.enum(['approve', 'revise', 'reject', 'request_changes']);

const ReviewHistoryEntryBaseSchema = z.object({
  session_id: SessionIdSchema,
  type: z.enum(['plan', 'code', 'precommit']),
  verdict: VerdictSchema,
  timestamp: z.string(),
  summary: z.string(),
  // Which provider produced the review, joined from the sessions table. Null
  // for legacy reviews whose session predates provider tagging.
  provider: z.string().nullable(),
});

export const ReviewHistoryEntrySchema = z.discriminatedUnion('model_metadata_status', [
  ReviewHistoryEntryBaseSchema.extend({
    models: z.array(ModelIdentitySchema),
    model_metadata_status: z.literal('recorded'),
  }),
  ReviewHistoryEntryBaseSchema.extend({
    models: z.null(),
    model_metadata_status: z.literal('legacy_unrecorded'),
  }),
  ReviewHistoryEntryBaseSchema.extend({
    models: z.null(),
    model_metadata_status: z.literal('invalid'),
  }),
]);

// Inferred types for use across the codebase
export type PlanFindingSeverity = z.infer<typeof PlanFindingSeveritySchema>;
export type CodeFindingSeverity = z.infer<typeof CodeFindingSeveritySchema>;
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;
export type PlanFinding = z.infer<typeof PlanFindingSchema>;
export type CodeFinding = z.infer<typeof CodeFindingSchema>;
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewProvider = z.infer<typeof ReviewProviderSchema>;
export type ModelIdentity = z.infer<typeof ModelIdentitySchema>;
export type ReviewProvenance = z.infer<typeof ReviewProvenanceSchema>;
export type PlanReviewResult = z.infer<typeof PlanReviewResultSchema>;
export type CodeReviewResult = z.infer<typeof CodeReviewResultSchema>;
export type PrecommitResult = z.infer<typeof PrecommitResultSchema>;
export type CrossReviewResponse = z.infer<typeof CrossReviewResponseSchema>;
export type CrossReviewResult = z.infer<typeof CrossReviewResultSchema>;
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
export type ReviewHistoryEntry = z.infer<typeof ReviewHistoryEntrySchema>;
