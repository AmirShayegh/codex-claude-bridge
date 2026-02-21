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
  line: z.number().int().positive().nullable(),
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

export const PlanReviewResultSchema = z.object({
  verdict: z.enum(['approve', 'revise', 'reject']),
  summary: z.string(),
  findings: z.array(PlanFindingSchema),
  session_id: z.string(),
});

export const CodeReviewResultSchema = z.object({
  verdict: z.enum(['approve', 'request_changes', 'reject']),
  summary: z.string(),
  findings: z.array(CodeFindingSchema),
  session_id: z.string(),
  chunks_reviewed: z.number().int().positive().optional(),
});

export const PrecommitResultSchema = z.object({
  ready_to_commit: z.boolean(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  session_id: z.string(),
  chunks_reviewed: z.number().int().positive().optional(),
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
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
export type ReviewHistoryEntry = z.infer<typeof ReviewHistoryEntrySchema>;
