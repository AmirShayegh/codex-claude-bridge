# Handover — Multi-provider phase COMPLETE (T-013→T-020)

## TL;DR
The `multi-provider` phase is fully shipped. Gemini (via the Antigravity `agy` CLI) is now a first-class, pluggable review backend alongside Codex, selectable by config, with provider provenance, cross-provider resume guards, and per-backend `latest`-model resolution. The MCP tool contract, structured-output Zod schemas, session-continuity model, and zero-config npx install are unchanged. **611 tests green; typecheck + lint clean.**

## What shipped this session (T-017, T-019, T-020)

### T-017 — Provider provenance on sessions (4 increments)
- `36dc678` sessions table gains a `provider TEXT` column + `getSession()` (idempotent ALTER migration).
- `63f9360` `review_history` surfaces `provider` per entry via `LEFT JOIN sessions` (null for legacy rows). `ReviewHistoryEntrySchema` gained `provider: z.string().nullable()`.
- `95a7e56` `ReviewBackend.provider` identity on the interface; both factories + the SDK-init-failure fallback tag themselves.
- `c844b67` cross-provider resume now fails fast with `PROVIDER_MISMATCH` **before** any backend call or state mutation. Logic lives in `SessionTracker.preflight()` (now returns `Result<void>`); `createSessionTracker(db, provider)` also tags newly created sessions. Legacy null-provider sessions resume freely. Real-SQLite integration test covers gemini-under-codex rejection.

### T-019 — `model: "latest"` resolver across providers (3 increments + a live-validation fix)
- `91e883e` gemini latest discovery: `runAgyModels()` → `pickLatestFlashModel()` (numeric version-sort of the Flash family, tier preference Medium→High→Low) → safe fallback to `GEMINI_DEFAULT_MODEL`.
- `bc4ad8f` replaced the static `defaultModel` capability with `resolveModel(requested) => Promise<string>` on `ReviewFlowDeps`. The orchestrator resolves **once per review** (skipping empty diffs) and threads the concrete id into both the per-turn `model` (via new `perTurnModel()` fresh/resume gate) and the error-context `resolvedModel`. Codex maps `latest`/unset → `CODEX_DEFAULT_MODEL` (SDK-pin bound, **not** newest-announced — L-008); gemini → newest Flash; explicit pin → unchanged (L-006). Also fixed a latent bug where `config.model:"latest"` would have been passed literally.
- `71984fb` stderr narration of the resolved model for unpinned reviews (schema is fixed, so logs are the surfacing point).
- `0c55559` **live-validation catch:** `agy models` blocks on open stdin; without `stdin.end()` the query timed out (~15s) and fell back every review, making gemini-latest a slow no-op. Fixed + regression test + **lesson L-011**. *Real agy resolved `Gemini 3.5 Flash (Medium)` from the query after the fix.*

### T-020 — Dual-backend test suite (audit + fill, tests only)
- `5ad566c` audited coverage against the checklist; filled gaps mocking only external boundaries (agy subprocess, fs): codex resolved-model→`startThread` (unset/latest→`gpt-5.5`, pin→unchanged); gemini prompt→stdin, empty-output retry, chunked-independent runs (review id = chunk 1), and T-001 partial-failure session_id passthrough. Provider dispatch, config parsing, `classifyAgyError` (all 6 branches), session capture/resume, and provenance were already covered.

## Key architecture (for the next session)
- **Seam:** `src/backends/backend.ts` (`ReviewBackend` interface) + `orchestrator.ts` (provider-neutral flow via `TurnRunner` + `ReviewFlowDeps` capability flags: `allowsModelOverrideOnResume`, `resumesAcrossChunks`, `resolveModel`). `createBackend(config)` in `backends/index.ts` dispatches on `config.provider`.
- **Codex** (`codex.ts`): one thread per review, resumes across chunks, SDK reasserts `--model` on resume (so model omitted on resumed turns).
- **Gemini** (`gemini.ts`): wraps `agy --print --sandbox --model <m> [--conversation <id>]`, prompt via **stdin** (argv-safe), session id captured from `~/.gemini/antigravity-cli/cache/last_conversations.json` (keyed by cwd), `runSerialized` mutex guards id-capture races, chunks run independently.

## Gotchas reinforced
- **L-011 (new):** always `child.stdin.end()` when spawning `agy` — it blocks on stdin even for `agy models`. Unit tests with mocked spawn can't catch this; live-validate.
- L-008: codex "latest" = SDK-pinned binary's latest, never newest-announced.
- L-006: recommend models, never enforce; explicit pin always wins.

## State / next steps
- Branch `main`, clean working tree after `5ad566c`. **Not pushed; release not bumped** (currently 1.0.0). No new MCP tools or schema changes, so existing installs keep working; a version bump + publish would ship Gemini support.
- The original epic mentioned **dual/cross-review (run BOTH providers and compare)** as a later phase — no tickets exist for it yet. That's the natural next phase if pursued: a `provider: "both"` or a `review_cross` concept, reconciling two verdicts. Would need new schema/tool thought (the "don't change the contract" constraint would need revisiting).
- Consider memoizing `agy models` per backend instance (currently queried once per unpinned review; fine but cacheable) — minor perf, noted not done.
