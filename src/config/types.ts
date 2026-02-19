import { z } from 'zod';

// Config-local severity enum — avoids cross-layer import from codex/types.ts
const BlockOnSeveritySchema = z.enum(['critical', 'major', 'minor', 'suggestion', 'nitpick']);

const PlanReviewStandardsSchema = z.object({
  focus: z.array(z.string()).default(['architecture', 'feasibility']),
  depth: z.enum(['quick', 'thorough']).default('thorough'),
});

const CodeReviewStandardsSchema = z.object({
  criteria: z.array(z.string()).default(['bugs', 'security', 'performance', 'style']),
  require_tests: z.boolean().default(true),
  max_file_size: z.number().int().positive().default(500),
});

const PrecommitStandardsSchema = z.object({
  auto_diff: z.boolean().default(true),
  block_on: z.array(BlockOnSeveritySchema).default(['critical', 'major']),
});

const ReviewStandardsSchema = z.object({
  plan_review: PlanReviewStandardsSchema.default(PlanReviewStandardsSchema.parse({})),
  code_review: CodeReviewStandardsSchema.default(CodeReviewStandardsSchema.parse({})),
  precommit: PrecommitStandardsSchema.default(PrecommitStandardsSchema.parse({})),
});

export const ReviewBridgeConfigSchema = z.object({
  model: z.string().default('o4-mini'),
  reasoning_effort: z.enum(['low', 'medium', 'high']).default('medium'),
  timeout_seconds: z.number().int().positive().default(300),
  review_standards: ReviewStandardsSchema.default(ReviewStandardsSchema.parse({})),
  project_context: z.string().default(''),
});

export type ReviewBridgeConfig = z.infer<typeof ReviewBridgeConfigSchema>;
export const DEFAULT_CONFIG: ReviewBridgeConfig = ReviewBridgeConfigSchema.parse({});
