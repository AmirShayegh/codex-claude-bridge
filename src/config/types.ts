import { z } from 'zod';

// Config-local severity enum — avoids cross-layer import from codex/types.ts
const BlockOnSeveritySchema = z.enum(['critical', 'major', 'minor', 'suggestion', 'nitpick']);

// The review providers the bridge can target. Single source of truth for the
// config `provider` enum and the per-provider recommended-model map below.
const ProviderSchema = z.enum(['codex', 'gemini']);
export type ReviewProvider = z.infer<typeof ProviderSchema>;

// Models we officially document and recommend, per provider. Used for
// error-message tips and README copy — NOT a blocking allowlist. Users who
// pass a different model via .reviewbridge.json, the MCP `model` param, or the
// CLI --model flag are forwarded to the backend as-is; we just don't advertise
// anything outside this set. See L-006 for the policy.
export const RECOMMENDED_MODELS = {
  codex: ['gpt-5.5', 'gpt-5.4'],
  // Provisional until confirmed against agy's accepted ids in T-016.
  gemini: ['gemini-flash-latest'],
} as const satisfies Record<ReviewProvider, readonly string[]>;
export type RecommendedModel = (typeof RECOMMENDED_MODELS)[ReviewProvider][number];

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
  plan_review: PlanReviewStandardsSchema.default(() => PlanReviewStandardsSchema.parse({})),
  code_review: CodeReviewStandardsSchema.default(() => CodeReviewStandardsSchema.parse({})),
  precommit: PrecommitStandardsSchema.default(() => PrecommitStandardsSchema.parse({})),
});

export const ReviewBridgeConfigSchema = z.object({
  // Explicit provider selection only — no implicit env-based auto-switching.
  provider: ProviderSchema.default('codex'),
  // No schema-level default — each backend resolves its own default model at
  // construction. A config value or per-call override takes precedence.
  model: z.string().optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high']).default('medium'),
  timeout_seconds: z.number().int().positive().default(300),
  max_chunk_tokens: z.number().int().positive().default(8000),
  review_standards: ReviewStandardsSchema.default(() => ReviewStandardsSchema.parse({})),
  project_context: z.string().default(''),
  copilot_instructions: z.boolean().default(true),
});

export type ReviewBridgeConfig = z.infer<typeof ReviewBridgeConfigSchema>;
export const DEFAULT_CONFIG: ReviewBridgeConfig = ReviewBridgeConfigSchema.parse({});
