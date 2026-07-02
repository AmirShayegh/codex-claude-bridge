import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig, formatConfigSource } from './config/loader.js';
import { createBackend } from './backends/index.js';
import { loadCopilotInstructions } from './config/copilot-instructions.js';
import type { CopilotInstructions } from './config/copilot-instructions.js';
import { openReviewDb, makeSessionProviderLookup } from './storage/db.js';
import { registerReviewPlanTool } from './tools/review-plan.js';
import { registerReviewCodeTool } from './tools/review-code.js';
import { registerReviewPrecommitTool } from './tools/review-precommit.js';
import { registerReviewHistoryTool } from './tools/review-history.js';
import { registerReviewStatusTool } from './tools/review-status.js';

export const SERVER_INSTRUCTIONS = `codex-claude-bridge — automated code review.

WORKFLOW: Use these tools in order during a feature lifecycle:

1. review_plan — Call AFTER drafting an implementation plan, BEFORE writing code.
   Returns a verdict (approve/revise/reject) with findings. Save the session_id.

2. review_code — Call AFTER writing or modifying code. Auto-captures working changes,
   or pass a git diff explicitly for PR/branch reviews.
   Pass the session_id from review_plan so the reviewer checks code against the plan.
   Returns a verdict (approve/request_changes/reject) with file and line references.

3. review_precommit — Call AFTER git add, BEFORE git commit. Auto-captures staged changes.
   Returns ready_to_commit (boolean), blockers, and warnings.

Supporting tools:
- review_status — Check if a review is still running, completed, or failed.
- review_history — Look up past reviews by session or recent count.

SESSION CONTINUITY: Always pass the session_id returned by one tool into the next.
This links plan → code → precommit reviews into a single session so the reviewer
has full context across the lifecycle.

ACTING ON RESULTS:
- approve / ready_to_commit=true → Proceed to the next step.
- revise / request_changes → Address the findings, then call the same tool again.
- reject → Rethink the approach. Consider a new plan and start a fresh session.

TIPS:
- review_code auto-captures working changes (git diff HEAD) — pass diff explicitly only for PR or branch diffs.
- review_precommit auto-captures staged changes — no need to pass a diff manually.
- You do not need to review every change. Use your judgement on when a review adds value.`;

// Read the package version once at module load so the MCP server advertises
// the same version as the published package, instead of drifting from a
// hardcoded literal. The URL resolves correctly across vitest (source),
// tsup-bundled dist, and npm-installed consumers — package.json is always
// adjacent to the running file's parent dir.
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string }
).version;

export function createServer(): McpServer {
  const configResult = loadConfig();
  if (!configResult.ok) {
    // Throw without pre-logging — the MCP entry point (mcp.ts) prints the
    // message once and exits. Avoids the double-print that happened when
    // index.ts also console.error'd the bubbled Error.
    throw new Error(configResult.error);
  }
  const { config, source } = configResult.data;
  console.error(`[codex-bridge] config source: ${formatConfigSource(source)}`);

  let copilotInstr: CopilotInstructions | undefined;
  if (config.copilot_instructions) {
    const instrCwd = source.kind === 'project' ? dirname(source.path) : undefined;
    const instrResult = loadCopilotInstructions(instrCwd);
    if (instrResult.ok) {
      copilotInstr = instrResult.data;
    } else {
      console.error(`Copilot instructions load failed, skipping: ${instrResult.error}`);
    }
  }

  // Open the db before building the backend so resume routing can consult session
  // ownership. The read-write open always returns a usable db (in-memory on
  // failure); the tools and lookup accept an optional db regardless.
  const db = openReviewDb();
  const client = createBackend(config, copilotInstr, makeSessionProviderLookup(db));

  try {
    const server = new McpServer(
      { name: 'codex-claude-bridge', version: PACKAGE_VERSION },
      { instructions: SERVER_INSTRUCTIONS },
    );

    registerReviewPlanTool(server, client, db);
    registerReviewCodeTool(server, client, db);
    registerReviewPrecommitTool(server, client, db);
    registerReviewHistoryTool(server, db);
    registerReviewStatusTool(server, db);

    return server;
  } catch (e) {
    throw new Error(`Failed to initialize MCP server: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}
