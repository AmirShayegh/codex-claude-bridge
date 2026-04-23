import { z } from 'zod';

// Config-local severity enum — avoids cross-layer import from codex/types.ts
const BlockOnSeveritySchema = z.enum(['critical', 'major', 'minor', 'suggestion', 'nitpick']);

// Models we officially support in .reviewbridge.json. The MCP input schemas
// and CLI --model flag stay permissive so Claude Code can experiment per
// call, but a persisted config that silently used an older Codex variant
// (e.g. gpt-5.1-codex-mini, which Codex CLI's memory-writing subsystem
// hits on ChatGPT-tier accounts) caused real confusion — see L-006, L-007.
export const SUPPORTED_MODELS = ['gpt-5.5', 'gpt-5.4'] as const;
export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

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
  model: z
    .string()
    .superRefine((v, ctx) => {
      if (!(SUPPORTED_MODELS as readonly string[]).includes(v)) {
        ctx.addIssue({
          code: 'custom',
          message: `Unsupported model "${v}". Supported values: ${SUPPORTED_MODELS.join(', ')}.`,
        });
      }
    })
    .default('gpt-5.5'),
  reasoning_effort: z.enum(['low', 'medium', 'high']).default('medium'),
  timeout_seconds: z.number().int().positive().default(300),
  max_chunk_tokens: z.number().int().positive().default(8000),
  review_standards: ReviewStandardsSchema.default(() => ReviewStandardsSchema.parse({})),
  project_context: z.string().default(''),
  copilot_instructions: z.boolean().default(true),
});

export type ReviewBridgeConfig = z.infer<typeof ReviewBridgeConfigSchema>;
export const DEFAULT_CONFIG: ReviewBridgeConfig = ReviewBridgeConfigSchema.parse({});
