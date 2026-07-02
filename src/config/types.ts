import { z } from 'zod';

// Config-local severity enum — avoids cross-layer import from review/types.ts
const BlockOnSeveritySchema = z.enum(['critical', 'major', 'minor', 'suggestion', 'nitpick']);

// The review providers the bridge can target. Single source of truth for the
// config `provider` enum and the per-provider recommended-model map below.
const ProviderSchema = z.enum(['codex', 'gemini']);
export type ReviewProvider = z.infer<typeof ProviderSchema>;

// Narrow a raw provider string (e.g. the nullable sessions.provider column) to a
// ReviewProvider, mapping unknown/legacy values to null instead of casting.
export function toReviewProvider(value: string | null | undefined): ReviewProvider | null {
  const parsed = ProviderSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// Models we officially document and recommend, per provider. Used for
// error-message tips and README copy — NOT a blocking allowlist. Users who
// pass a different model via .reviewbridge.json, the MCP `model` param, or the
// CLI --model flag are forwarded to the backend as-is; we just don't advertise
// anything outside this set. See L-006 for the policy.
export const RECOMMENDED_MODELS = {
  codex: ['gpt-5.5', 'gpt-5.4'],
  // agy model strings (effort is part of the name); from `agy models`.
  gemini: ['Gemini 3.5 Flash (Medium)', 'Gemini 3.5 Flash (High)', 'Gemini 3.1 Pro (High)'],
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
  // Path to a `codex` binary to spawn instead of the one bundled with
  // @openai/codex-sdk. Escape hatch for when the vendored binary is missing or
  // unusable — e.g. macOS XProtect trashing it as a false positive — so the
  // bridge can point at a working system install (which codex → e.g.
  // ~/.local/bin/codex). Falls back to the env var CODEX_PATH, then the bundled
  // binary. Codex provider only.
  codex_path: z.string().optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high']).default('medium'),
  timeout_seconds: z.number().int().positive().default(300),
  max_chunk_tokens: z.number().int().positive().default(8000),
  review_standards: ReviewStandardsSchema.default(() => ReviewStandardsSchema.parse({})),
  project_context: z.string().default(''),
  copilot_instructions: z.boolean().default(true),
  // When a review fails because the configured provider is out of usage /
  // unavailable, automatically retry through the other provider. On by default;
  // set false for strict single-provider behavior (CI determinism, or to avoid
  // sending a diff to a second vendor on failover).
  fallback: z.boolean().default(true),
  // Review mode. 'single' = one provider only; 'failover' = one provider, fall
  // back to the other when it's out of usage (default); 'deliberate' = both
  // providers review (plan + code) and the bridge returns a structured
  // agreement/disagreement map for the caller to synthesize; 'deliberate-deep' =
  // deliberate plus a cross-review round where each provider adjudicates the
  // other's divergent findings (confirmed/disputed/unsure). Optional — when unset
  // it's derived from `fallback` (false → single, else failover) so 1.1.0 configs
  // keep working.
  mode: z.enum(['single', 'failover', 'deliberate', 'deliberate-deep']).optional(),
});

export type ReviewBridgeConfig = z.infer<typeof ReviewBridgeConfigSchema>;
export const DEFAULT_CONFIG: ReviewBridgeConfig = ReviewBridgeConfigSchema.parse({});
