import type { ReviewBridgeConfig, ReviewProvider } from '../config/types.js';
import type { CopilotInstructions } from '../config/copilot-instructions.js';
import type { ReviewBackend } from './backend.js';
import { createCodexBackend } from './codex.js';
import { createGeminiBackend } from './gemini.js';
import { createFailoverBackend } from './failover.js';
import { createDeliberationBackend } from './deliberation.js';

export type { ReviewBackend } from './backend.js';

// Build a single (non-failover) backend for the given provider. Only the chosen
// provider's client initializes: createCodexBackend runs `new Codex()` lazily
// inside itself, and the Gemini backend spawns agy per review — so simply not
// calling the unselected factory is enough. No dynamic import / async is needed
// (which keeps the sync server.ts and CLI call sites unchanged).
function createLeafBackend(
  config: ReviewBridgeConfig,
  copilotInstructions?: CopilotInstructions,
): ReviewBackend {
  switch (config.provider) {
    case 'codex':
      return createCodexBackend(config, copilotInstructions);
    case 'gemini':
      return createGeminiBackend(config, copilotInstructions);
  }
  // provider is a closed enum, so the switch is exhaustive. This line fails to
  // compile if a provider is added without a case; it then falls back to codex
  // rather than throwing.
  config.provider satisfies never;
  return createCodexBackend(config, copilotInstructions);
}

// Build the review backend the config selects. `mode` picks the composition:
// 'single' = the configured provider only; 'failover' (default) = fall back to
// the other provider when the primary is out of usage; 'deliberate' = both
// providers review (plan + code) and the bridge surfaces the agreement map;
// 'deliberate-deep' = deliberate plus a cross-review round where each provider
// adjudicates the other's divergent findings. When `mode` is unset it's derived
// from the 1.1.0 `fallback` flag for back-compat.
export function createBackend(
  config: ReviewBridgeConfig,
  copilotInstructions?: CopilotInstructions,
): ReviewBackend {
  const mode = config.mode ?? (config.fallback ? 'failover' : 'single');
  const primary = createLeafBackend(config, copilotInstructions);
  if (mode === 'single') return primary;

  const secondaryProvider: ReviewProvider = config.provider === 'codex' ? 'gemini' : 'codex';
  // Build the secondary leaf directly (NOT via createBackend — that would recurse
  // and try to build its own composite). Clear `model` so a primary-specific pin
  // (e.g. a Codex model) isn't forced onto the secondary, which resolves its own.
  const secondary = createLeafBackend(
    { ...config, provider: secondaryProvider, model: undefined },
    copilotInstructions,
  );
  if (mode === 'deliberate') return createDeliberationBackend(primary, secondary);
  if (mode === 'deliberate-deep') return createDeliberationBackend(primary, secondary, { crossReview: true });
  return createFailoverBackend(primary, secondary);
}
