import type { ReviewBridgeConfig, ReviewProvider } from '../config/types.js';
import type { ReviewBackend } from './backend.js';
import { createCodexBackend } from './codex.js';
import { createGeminiBackend } from './gemini.js';
import type { SessionProviderLookup } from './failover.js';
import { createCompositeBackend, withSingleMode } from './composite.js';
import type { ModelIdentity } from '../review/types.js';

export type { ReviewBackend } from './backend.js';

// Build a single (non-failover) backend for the given provider. Only the chosen
// provider's client initializes: createCodexBackend runs `new Codex()` lazily
// inside itself, and the Gemini backend spawns agy per review — so simply not
// calling the unselected factory is enough. No dynamic import / async is needed
// (which keeps the sync server.ts and CLI call sites unchanged).
function createLeafBackend(
  config: ReviewBridgeConfig,
  lookupSessionModel?: (sessionId: string) => ModelIdentity | null,
): ReviewBackend {
  switch (config.provider) {
    case 'codex':
      return lookupSessionModel
        ? createCodexBackend(config, { lookupSessionModel })
        : createCodexBackend(config);
    case 'gemini':
      return createGeminiBackend(config);
  }
  // provider is a closed enum, so the switch is exhaustive. This line fails to
  // compile if a provider is added without a case; it then falls back to codex
  // rather than throwing.
  config.provider satisfies never;
  return lookupSessionModel
    ? createCodexBackend(config, { lookupSessionModel })
    : createCodexBackend(config);
}

// Build the review backend the config selects. `mode` picks the base composition:
// 'single' = the configured provider only; 'failover' (default) = fall back to the
// other provider when the primary is out of usage; 'deliberate' = both providers
// review and the bridge surfaces the agreement map; 'deliberate-deep' = deliberate
// plus a cross-review round. When `mode` is unset it's derived from the 1.1.0
// `fallback` flag for back-compat. For any two-provider mode a single composite is
// returned that picks failover vs deliberation PER CALL from the `deliberate`
// toggle (T-028); single mode returns a decorator that stamps review_mode:'single'
// and rejects a per-call deliberate request.
export function createBackend(
  config: ReviewBridgeConfig,
  lookupSessionProvider?: SessionProviderLookup,
  lookupSessionModel?: (sessionId: string) => ModelIdentity | null,
): ReviewBackend {
  const mode = config.mode ?? (config.fallback ? 'failover' : 'single');
  const primary = createLeafBackend(config, lookupSessionModel);
  if (mode === 'single') return withSingleMode(primary);

  const secondaryProvider: ReviewProvider = config.provider === 'codex' ? 'gemini' : 'codex';
  // Build the secondary leaf directly (NOT via createBackend — that would recurse
  // and try to build its own composite). Clear `model` so a primary-specific pin
  // (e.g. a Codex model) isn't forced onto the secondary, which resolves its own.
  const secondary = createLeafBackend(
    { ...config, provider: secondaryProvider, model: undefined },
    lookupSessionModel,
  );
  return createCompositeBackend(primary, secondary, config, lookupSessionProvider);
}
