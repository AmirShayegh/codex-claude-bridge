import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig, formatConfigSource } from './config/loader.js';
import { createBackend } from './backends/index.js';
import { canonicalizeStartupDirectory } from './utils/workspace.js';
import { createPreparationLimiter } from './review/preparation.js';
import type { RequestPreparationDeps } from './review/request-prep.js';
import {
  makeSessionModelLookup,
  makeSessionProviderLookup,
  openReviewDbWithMetadata,
} from './storage/db.js';
import type { OpenReviewDbMetadata } from './storage/db.js';
import { createSessionRegistry } from './storage/session-registry.js';
import { createSessionRouting } from './storage/session-routing.js';
import { createReviewLifecycle } from './review/lifecycle.js';
import { registerReviewPlanTool } from './tools/review-plan.js';
import { registerReviewCodeTool } from './tools/review-code.js';
import { registerReviewPrecommitTool } from './tools/review-precommit.js';
import { registerReviewHistoryTool } from './tools/review-history.js';
import { registerReviewStatusTool } from './tools/review-status.js';
import { escapeTerminalControls } from './utils/terminal.js';

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
- WHERE a review runs is per call. review_plan/review_code/review_precommit accept 'cwd': an absolute
  path to the repository or git worktree being reviewed. It decides where git captures from, which
  repository instruction files apply, and where the reviewer subprocess runs. ALWAYS pass 'cwd':
  by default an auto-capturing review_code/review_precommit call without it is refused with
  INVALID_INPUT, because the alternative — capturing from the directory the server was launched in —
  is often NOT where you are working. It is not remembered across calls: send it again on every
  call, including when resuming a session_id.
- Auto-captured results carry 'captured_from': the absolute directory the bridge actually ran git in.
  Check it when a result surprises you — an empty result means "nothing there", not "nothing at all".
  If it is not the repository you meant, pass 'cwd' (or supply the diff explicitly).
- Auto-capture requires a git work tree. Pointing 'cwd' at a plain directory returns INVALID_INPUT
  rather than silently reviewing nothing; review_plan and explicit diffs work anywhere readable.
- You do not need to review every change. Use your judgement on when a review adds value.
- review_plan and review_code accept a 'deliberate' boolean that overrides the configured mode for
  one call: true = both providers review (deliberation), false = single provider with failover.
  Requires a two-provider setup. review_precommit is always failover.
- Every result carries a 'review_mode' field (single/failover/deliberate/deliberate-deep) naming the
  composition that was CONFIGURED for the call. A result also carries a 'failover' block ONLY when
  the primary provider failed and the other one served: it names the failed provider, its error,
  the model you asked for, and what the other provider was handed. No 'failover' block means the
  primary served. Treat a failed-over result as a different reviewer's opinion, not the one you
  requested, and consider whether its 'carried_model' (null = the secondary's default) is
  adequate for the change.
- Every successful review also carries 'models' (successful reviewer/adjudicator contributions with
  requested/resolved/observed identity evidence) and 'provenance' (durable, memory_only, or
  not_recorded). Runtime labels are control-plane evidence, not proof of underlying weights.
- review_history returns immutable model snapshots in bounded pages. Pass its next_cursor into the
  next call to continue without overlap.
- Under deliberate-deep, the top-level 'verdict' reflects both providers' INDEPENDENT reviews; the
  per-finding adjudications in deliberation.divergent[] are advisory for YOUR synthesis and are not
  folded back into the verdict. Weigh disputed findings yourself.`;

// Read the package version once at module load so the MCP server advertises
// the same version as the published package, instead of drifting from a
// hardcoded literal. The URL resolves correctly across vitest (source),
// tsup-bundled dist, and npm-installed consumers — package.json is always
// adjacent to the running file's parent dir.
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
    version: string;
  }
).version;

// Storage is optional at runtime (ISS-042). When even the in-memory database
// cannot open — the SQLite native addon failed to load — the server still comes
// up: reviews run with in-process session state only, and history/status
// answer STORAGE_UNAVAILABLE with the diagnosis. Exiting here used to close the
// MCP connection, which hid the cause behind CONNECTION_CLOSED and forced a
// manual reconnect after the rebuild.
interface StartupStorage {
  opened: OpenReviewDbMetadata | undefined;
  unavailableReason: string | undefined;
}

function openStorageOrDegrade(): StartupStorage {
  try {
    return { opened: openReviewDbWithMetadata(), unavailableReason: undefined };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(
      `[codex-bridge] review storage unavailable; reviews will run without history: ${escapeTerminalControls(reason)}`,
    );
    return { opened: undefined, unavailableReason: reason };
  }
}

export function createServer(): McpServer {
  const configResult = loadConfig();
  if (!configResult.ok) {
    // Throw without pre-logging — the MCP entry point (mcp.ts) prints the
    // message once and exits. Avoids the double-print that happened when
    // index.ts also console.error'd the bubbled Error.
    throw new Error(configResult.error);
  }
  const { config, source } = configResult.data;
  console.error(
    `[codex-bridge] config source: ${escapeTerminalControls(formatConfigSource(source))}`,
  );

  // Where a request that names no `cwd` runs. Captured and canonicalized ONCE at
  // startup: reading process.cwd() per request would let a later change move
  // every default silently, and an uncanonicalized value would not match the
  // paths git and the providers report back.
  const prep: RequestPreparationDeps = {
    limiter: createPreparationLimiter(),
    defaultWorkingDirectory: canonicalizeStartupDirectory(process.cwd()),
    loadInstructions: config.copilot_instructions,
    requireCwdForCapture: config.require_cwd,
  };

  // Open the db before building the backend so resume routing can consult session
  // ownership. Ordinary file failures fall back to in-memory inside the open;
  // only a native-addon failure leaves no database at all.
  const storage = openStorageOrDegrade();
  const registry = createSessionRegistry();
  const routing = createSessionRouting({
    registry,
    durability: storage.opened?.durability ?? 'memory_only',
    providerLookup: makeSessionProviderLookup(storage.opened?.db),
    modelLookup: makeSessionModelLookup(storage.opened?.db),
  });
  const client = createBackend(config, routing.lookupProvider, routing.lookupModel);
  const lifecycle = createReviewLifecycle({
    backend: client,
    registry,
    lookupSessionProvider: routing.lookupProvider,
    lookupResultSession: routing.lookupResultSession,
    storage: storage.opened,
    storageWarning: storage.unavailableReason,
    onOutcomePersistenceFailure: routing.markOutcomePersistenceFailure,
    onOutcomePersisted: routing.markOutcomePersisted,
  });

  try {
    const server = new McpServer(
      { name: 'codex-claude-bridge', version: PACKAGE_VERSION },
      { instructions: SERVER_INSTRUCTIONS },
    );

    const db = storage.opened?.db;
    registerReviewPlanTool(server, client, prep, db, lifecycle);
    registerReviewCodeTool(server, client, prep, db, lifecycle);
    registerReviewPrecommitTool(server, client, prep, db, config, lifecycle);
    registerReviewHistoryTool(server, db, storage.unavailableReason);
    registerReviewStatusTool(server, db, registry, storage.unavailableReason);

    return server;
  } catch (e) {
    throw new Error(
      `Failed to initialize MCP server: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
}
