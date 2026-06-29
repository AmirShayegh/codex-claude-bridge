import type { ReviewBridgeConfig } from '../config/types.js';
import type { CopilotInstructions } from '../config/copilot-instructions.js';
import type { ReviewBackend } from './backend.js';
import { createCodexBackend } from './codex.js';
import { createGeminiBackend } from './gemini.js';

export type { ReviewBackend } from './backend.js';

// Build the review backend the config selects. Only the chosen provider's client
// initializes: createCodexBackend runs `new Codex()` lazily inside itself, and
// the Gemini backend spawns agy per review — so simply not calling the
// unselected factory is enough. No dynamic import / async is needed (which keeps
// the sync server.ts and CLI call sites unchanged).
export function createBackend(
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
