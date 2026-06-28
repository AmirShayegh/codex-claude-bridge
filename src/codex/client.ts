// Compatibility shim. The Codex backend moved to src/backends/codex.ts and the
// shared review flow to src/backends/orchestrator.ts during the multi-provider
// refactor (T-013). This module re-exports the symbols that tools, the CLI, and
// tests still import from here, so those import sites keep resolving while the
// remaining increments re-point them to the new locations.
import type { ReviewBackend } from '../backends/backend.js';

export type CodexClient = ReviewBackend;

export { looksLikeDiff, sessionModelConflictMessage } from '../backends/orchestrator.js';
export { createCodexClient } from '../backends/codex.js';
