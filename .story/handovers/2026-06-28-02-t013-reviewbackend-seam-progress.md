# Session Handover: T-013 in progress — ReviewBackend seam extracted (4/6 increments)

**Date:** 2026-06-28 (continuation of the multi-provider planning session)
**Span:** Single working session — executed T-013 incrementally, TDD/green-at-each-step.
**Net change:** 4 green refactor commits on `main` (+ the earlier planning commit). T-013 ~⅔ done. Suite green (516) at every step. Working tree clean.

## Where this fits
Continues the **Multi-Provider** phase (see prior handover `2026-06-28-01-multi-provider-planning-gemini-agy.md`). Goal: add Google Gemini as a review backend via the Antigravity `agy` CLI (Path A), MCP contract/schemas/sessions/zero-config unchanged. **T-013 is the path-independent foundation refactor** — the bulk of the work — that every later ticket builds on.

## What landed this session (all on `main`, linear)
```
726aaf0 refactor: relocate the SDK-backed review backend under src/backends (T-013)
930d58f refactor: drive review flow through a TurnRunner seam (T-013)
d446a8d refactor: extract shared review helpers to orchestrator (T-013)
69e4649 refactor: introduce provider-neutral ReviewBackend seam (T-013)
71ced4b chore: plan pluggable review-provider backend (T-013..T-020)   ← prior session
```

## Architecture now (the seam exists and is pluggable)
```
src/backends/
  backend.ts       → ReviewBackend interface + PlanReviewInput/CodeReviewInput/PrecommitReviewInput
  orchestrator.ts  → provider-NEUTRAL flow: looksLikeDiff, chunk loop, empty/single/multi,
                     dedup, merge, sessionModelConflictMessage, the response schemas,
                     and runPlanReview/runCodeReview/runPrecommitReview(input, deps, turn).
                     Seam types: TurnParams, TurnRunner, ReviewFlowDeps.
  codex.ts         → the Codex backend: classifyError, threadOpts/resumeThreadOpts, runReview
                     (the Codex TurnRunner), createCodexClient(config, copilot) → ReviewBackend.
src/codex/client.ts → 4-line compatibility SHIM re-exporting CodexClient (alias of ReviewBackend),
                     looksLikeDiff, sessionModelConflictMessage, createCodexClient.
```
**Key idea:** the orchestrator owns the flow; each backend supplies only a `TurnRunner` (one prompt → schema-validated Result + session_id), its error classification, and its default model. `createCodexClient` builds a `TurnRunner` from `runReview` and delegates the three flows to the orchestrator. Behavior is byte-for-byte preserved — verified by the unchanged guard tests.

## Increments done
- **1** ReviewBackend seam (`backend.ts`), `CodexClient` aliased.
- **2a** pure helpers (diff detection, overhead sizing, dedup, merge) → `orchestrator.ts`.
- **2b** the three review *flows* → `orchestrator.ts` behind the `TurnRunner` seam (the behavior-sensitive one — preserved retry-on-same-thread and model-on-chunk-1-only exactly).
- **3** relocated the Codex backend → `backends/codex.ts`; `client.ts` is now a shim.

## Remaining for T-013 (2 increments)
**Increment 4 — parameterize the two Codex policies as a backend capability.** This is the ONE spot the "neutral" orchestrator still hardcodes a Codex assumption (model omitted on resume; conflict check always on). Gemini *allows* model-on-resume, so this must become a capability.
- Add `allowsModelOverrideOnResume: boolean` to `ReviewFlowDeps` (Codex passes `false`).
- Conflict check (all 3 flows): error only when `!allowsModelOverrideOnResume && input.session_id && input.model`.
- Multi-chunk loop model arg: `allowsModelOverrideOnResume ? input.model : (sessionId ? undefined : input.model)`.
- **TDD (new behavior → red→green, per the user's "TDD for everything"):** add `src/backends/orchestrator.test.ts` with a fake `TurnRunner` asserting BOTH capability values — `false` reproduces today's conflict-error + model-omitted-on-resume; `true` skips the conflict and forwards model on resume. Existing Codex tests must stay green (Codex = `false`).

**Increment 5 — re-point imports + retire the shim.** Update `src/tools/review-{plan,code,precommit}.ts` (CodexClient type, sessionModelConflictMessage) and `src/cli/commands.ts` (+ tests) to import from `src/backends/` directly; delete `src/codex/client.ts`; consider renaming `src/codex/client.test.ts` → `src/backends/codex.test.ts`. Consider renaming `createCodexClient` → `createCodexBackend` (the T-018 selection layer will call it). Keep suite green.

After 4+5, mark **T-013 complete** (it's `inprogress` now). Then the runway is **T-016** (Gemini backend via `agy`), **T-015** (provider config), etc. — see the phase graph in the planning handover.

## Active directives (user-stated this session)
- **TDD for everything.** Refactors = characterization/green-at-each-step; new behavior = red→green. Increment 4 is the first that adds new behavior.
- **"Always use the latest model from every provider."** Captured as ticket **T-019** (`model:'latest'` resolver, per-backend) — but mind the L-008 trap: for the SDK-backed path, "latest" = latest the pinned SDK supports, NOT newest announced.
- **Per-increment commit cadence** (small, bisectable, green) is working well — keep it.

## Verify before resuming
`npm test` (516, 28 files) · `npm run typecheck` · `npm run lint` — all green at `726aaf0`. `better-sqlite3` was rebuilt for Node 22 this session (in node_modules; a future `npm ci` resets it).

## Pointers
- Guard tests that pin the behavior the refactor must preserve: `src/codex/client.test.ts:188/201` (retry), `:653/683` (model-on-chunk-1-only), `:1164/1184` (T-001 partial-failure session_id passthrough), `src/tools/review-code.test.ts:234/254/272/284` (preflight ordering), `src/server.integration.test.ts:382` (T-001 e2e).
- `stash@{0}` — the stashed Path-B `@google/genai` PoC the `agy` CLI generated (reference only; `git stash show -p stash@{0}`).
- **L-009** agy session mechanics · **L-010** sandbox-the-agent constraint.