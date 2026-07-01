# Handover — Deliberation mode built, tested, live-verified (committed, not pushed)

## TL;DR
The **deliberation** feature (T-024) is **done**: `"mode": "deliberate"` runs `review_plan` + `review_code` through **both** providers independently and returns a structured agreement/disagreement map for Claude Code to synthesize. Built behind the same `ReviewBackend` seam as failover, **662 tests green**, typecheck + lint clean, and **live-verified** end-to-end. Committed locally (2 commits) — **not pushed, not published** (npm still 1.1.0). Next call: push and/or cut **1.2.0**.

## State
- Branch `main`, HEAD **`66f7274`**. `origin/main` at **`a88260b`** → **2 unpushed commits**:
  - `f7dad93` feat: deliberation mode — both providers review, bridge surfaces the disagreement
  - `66f7274` chore: track deliberation feature (T-024) and session handovers
- **npm `latest` = 1.1.0** (deliberation NOT published). `dist` rebuilt at HEAD.
- Tree clean. Suite green (662 / 33 files), typecheck + lint clean.
- Codex usage cap appears reset (served `request_changes` in the live test); Gemini/agy working.

## What shipped (T-024)
- **Config:** `mode: 'single' | 'failover' | 'deliberate'` (optional) in `src/config/types.ts`. Derived from the 1.1.0 `fallback` flag when unset (`fallback:false` → single, else failover) — existing configs keep working.
- **Composite:** `src/backends/deliberation.ts` → `createDeliberationBackend(primary, secondary)`, mirrors `failover.ts`. `reviewPlan`/`reviewCode` run both leaves via `Promise.all` then combine; `reviewPrecommit` and resumed sessions delegate to `withFailover` (now exported from `failover.ts`). Wired in `createBackend` (`src/backends/index.ts`) — `mode === 'deliberate'` builds the deliberation composite.
- **Agreement:** `computeAgreement()` groups findings by the existing `${file}:${line}:${category}` key (keyless → divergent; both → agreed, keeping the higher-severity representative). Top-level result = merged (worst verdict, deduped union of `agreed` + `divergent`, `chunks_reviewed` stripped) + an **additive optional `deliberation` block** on the Plan/Code result schemas (`src/codex/types.ts`), omitted from the orchestrator response schemas so the model can't inject it. Blind `JSON.stringify(result.data)` in the tools ⇒ **zero tool/CLI changes**.
- **Degrade:** one provider fails → survivor's review + `deliberation.degraded = { failed, reason }` (subsumes failover). Both fail → combined error led by primary.
- **Scope:** plan + code only. precommit stays failover.

## Verification
- `deliberation.test.ts` (11): agree / mixed / conflict, one-fails-degrades, both-fail, resume-delegates, precommit-is-failover, worst-verdict + no `chunks_reviewed`, and `computeAgreement` directly. `index.test.ts` rewritten to assert mode routing (composite factories mocked).
- **Live (CLI, fresh dist):** `{"provider":"codex","mode":"deliberate"}` on a SQLi diff → both providers reviewed; **both caught the SQL injection** (`agreed: ['security']`, high confidence), `divergent`: codex→api_contracts, gemini→style; `agreement: conflict` (codex request_changes vs gemini reject); top verdict reject; `chunks_reviewed` absent. 17s.

## How to use
`.reviewbridge.json`: `{ "provider": "codex", "mode": "deliberate" }`. Output keeps the usual `{verdict, summary, findings, session_id}` plus a `deliberation` block (`providers`, `verdicts[]`, `agreement`, `agreed[]`, `divergent[]`, optional `degraded`). Documented in README (Deliberation section).

## Next steps
1. **Push** the 2 commits (`git push origin main`).
2. Optional **release 1.2.0** so `deliberate` reaches `npx codex-claude-bridge@latest` (bump package.json → commit → annotated tag `v1.2.0` → `npm publish` → push). Same procedure as 1.1.0 (prepublishOnly gate runs build+typecheck+lint+test). Deliberation is additive/backward-compatible → minor bump.
3. **L-013:** exercising via the MCP tool needs a Claude Code restart (the running `codex-bridge-local`/`codex-bridge` servers are stale). Use the CLI to try mid-session.

## Standing action items (from prior handovers)
- **Rotate the npm token** pasted in chat earlier.
- **Restart Claude Code** to move the MCP servers onto 1.1.0 (and, once published, 1.2.0).

## Open / Phase 2 (deliberation)
- **LLM cross-review round** — each provider adjudicates the other's findings (anonymized) before the caller synthesizes. This is where `@llmtium/core`'s anonymizer + `CrossReview` schema/prompt (`/Users/amirshayegh/Developer/llmtium`, MIT) get lifted.
- **Per-call `deliberate: true`** on the tools (v1 is config-mode only).
- **Deliberation for `review_precommit`**.

## Also still open (untouched, non-blocking)
- Lower-tier review items: m2 (timeout semantics), m5 (injection — disputed), m6 + nitpicks, merge-helper unit-test gaps.
- Dual/cross-review as its own product concept remains distinct from single-direction failover; deliberation is the closest realized piece.
