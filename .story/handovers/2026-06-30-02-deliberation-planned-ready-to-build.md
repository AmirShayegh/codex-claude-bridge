# Handover — Deliberation mode planned & approved (ready to build, no code yet)

## TL;DR
v1.1.0 (multi-provider + failover) is **published and live**. This session then designed the next feature — **deliberation mode** (both providers review a plan/diff in parallel; the bridge returns a structured agree/disagree map; Claude Code synthesizes) — and the **plan is approved**. **No implementation code has been written yet** (one exploratory config edit was reverted to keep a clean slate). Next session: execute the approved plan for **T-024**.

## Where to resume
- **Approved plan:** `~/.claude/plans/lets-do-all-cozy-feather.md` (full detail — read this first).
- **Ticket:** **T-024** (feature, `deliberation` phase), status `open`.
- Both capture the design below.

## State
- Branch `main`, HEAD **`a88260b`**, in sync with origin. **npm `latest = 1.1.0`**, tag `v1.1.0` pushed.
- Working tree: **no code changes**. Uncommitted `.story/` tracking only: `roadmap.json` (new `deliberation` phase), `tickets/T-024.json`, and two handovers (`2026-06-30-01-…` and this one) + snapshots. Safe to commit as a tracking commit.
- Suite green (651 tests / 32 files), typecheck + lint clean, at `a88260b`.
- Codex usage cap appears to have reset (a review served `provider: codex` earlier); Gemini/agy working.

## The feature (T-024) — decisions locked with the user
- **What:** for high-stakes reviews, run **both** providers (codex + gemini) independently on the same input, then surface where they **agree** (both flagged a finding → high confidence) vs **diverge** (only one flagged → needs judgment).
- **Depth:** independent parallel reviews + a **computed** disagreement map. **No LLM cross-review or synthesis stage** — Claude Code (the caller) is the synthesizer; it re-judges the one-sided findings against the diff it already has. (Cheapest: 2 provider calls.)
- **Scope:** `review_plan` + `review_code` only. `review_precommit` stays failover (frequent, latency-sensitive).
- **Activation:** opt-in config `mode` (default stays failover). Deliberation always sends the diff to both vendors — must be deliberate.
- **Not a port of LLMtium:** the bridge's providers already return *structured* reviews, so the "draft" stage is just each leaf's `reviewX`, and the map is pure computation on the existing `${file}:${line}:${category}` dedup key. (LLMtium's engine at `/Users/amirshayegh/Developer/llmtium` — MIT, the user's — sits on a narrow provider seam; its anonymizer + `CrossReview` schema are the Phase-2 lift if we ever add an LLM cross-review round.)

## Implementation steps (from the approved plan, in order)
1. **`src/config/types.ts`** — add `mode: z.enum(['single','failover','deliberate']).optional()` (next to the existing `fallback`). *(This exact edit was drafted then reverted — redo it as step 1.)*
2. **`src/codex/types.ts`** — add a `DeliberationSchema` and an **additive optional `deliberation`** field on `PlanReviewResultSchema` + `CodeReviewResultSchema` (not precommit). Blind `JSON.stringify(result.data)` in the tools means zero tool changes (same trick as the `provider` field). Block shape: `{ providers, verdicts[], agreement: 'agree'|'mixed'|'conflict', agreed: Finding[], divergent: {provider,finding}[], degraded?: {failed,reason} }`.
3. **`src/backends/orchestrator.ts`** — add `deliberation: true` to the three `.omit({...})` response schemas (next to `provider: true`) so the model can't inject the block.
4. **`src/backends/failover.ts`** — export `withFailover` (reused for the deliberation composite's precommit path).
5. **`src/backends/deliberation.ts`** (new) — `createDeliberationBackend(primary, secondary)`, structured like `createFailoverBackend` (`failover.ts:72-88`). `provider`/`allowsModelOverrideOnResume` = primary's. `reviewPlan`/`reviewCode` → run both via `Promise.all`, combine. `reviewPrecommit` → `withFailover`. `session_id` present → delegate to primary (deliberation is fresh-only; the `PROVIDER_MISMATCH` guard covers wrong-provider resumes). Combine: both ok → merged result + `deliberation` block; one ok → survivor + `deliberation.degraded`; both fail → combined error (mirror failover). Agreement: group each provider's findings by the `${file}:${line}:${category}` key (`orchestrator.ts:71`); keyless (file/line null) → `divergent`; keep higher-severity representative for `agreed` (`severityRank`, `orchestrator.ts:57`). Reuse `mergeCodeResults` for the merged top-level code result but **strip `chunks_reviewed`** (it'd read "2"); write a small plan merge (approve<revise<reject) since there's no `mergePlanResults`.
6. **`src/backends/index.ts`** — in `createBackend`, derive `const mode = config.mode ?? (config.fallback ? 'failover' : 'single')`; `single` → primary leaf; build secondary leaf directly (`{...config, provider:<other>, model:undefined}`); `deliberate` → `createDeliberationBackend`; else `createFailoverBackend`.
7. **Tests (TDD):** `deliberation.test.ts` (both agree / partial diverge / conflicting verdicts / one-fails-degrades / both-fail / session_id-delegates / precommit-is-failover / merged worst verdict, no chunks_reviewed); a direct agreement-helper test; update `index.test.ts` (mode wiring) + `config/types.test.ts` (mode field).
8. **`README.md`** — document `"mode": "deliberate"` + the `deliberation` output block.

## Verification (per plan)
Full suite + typecheck + lint green. **Live:** `{"provider":"codex","mode":"deliberate"}` config, `review-code` on a real diff → both providers review; inspect the `deliberation` block (agreed vs divergent, per-provider verdicts). If Codex is out of usage it degrades to a single gemini result with `deliberation.degraded` set. Remember **L-013**: restart Claude Code (or use the CLI) to exercise via the MCP tool — the running server won't hot-reload.

## Reuse map (grounded by exploration this session)
- Composite template: `src/backends/failover.ts` (`tag`, `withFailover`, `createFailoverBackend`).
- Dedup key + severity rank + merge: `src/backends/orchestrator.ts` (`deduplicateFindings` `:62`, `severityRank` `:57`, `mergeCodeResults` `:83`).
- Finding/result shapes + the `provider` additive-field precedent: `src/codex/types.ts`.
- Wiring seam: `src/backends/index.ts` `createBackend`.
- Tool surfacing (blind stringify): `src/tools/review-code.ts:99`.

## Still open (untouched, non-blocking)
- Deliberation **Phase 2:** LLM cross-review round (lift `@llmtium/core` anonymizer + `CrossReview` schema/prompt), per-call `deliberate: true` flag, precommit deliberation.
- Prior lower-tier review items: m2 (timeout semantics), m5 (injection — disputed), m6 + nitpicks, merge-helper unit-test gaps.
- User action items from last handover: **rotate the npm token** (pasted in chat), **restart Claude Code** to move the MCP servers onto 1.1.0.
