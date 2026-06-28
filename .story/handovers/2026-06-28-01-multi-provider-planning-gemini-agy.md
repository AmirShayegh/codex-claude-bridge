# Session Handover: Multi-Provider planning — Gemini backend via `agy` CLI

**Date:** 2026-06-28
**Span:** Single session — investigation + planning only (no production code yet)
**Net change:** New **Multi-Provider** roadmap phase + 8 tickets (T-013..T-020), 2 lessons (L-009, L-010). One Path-B proof-of-concept stashed (not adopted). Next action: start T-013.

## Goal
Add Google Gemini as a second review backend alongside the existing one, **without** changing the MCP tool contract, the structured-output schemas, the session-continuity model, or the zero-config install.

## How we reached the plan
1. **Investigation workflow (5 agents).** Mapped backend coupling: the `CodexClient` interface is already a clean provider-agnostic seam, and ~75% of the codebase (prompts, Zod schemas, chunking, dedup/merge, storage, config) is reusable as-is. Researched the real Gemini surface, audited a batch of hallucinated guidance, ran an adversarial stress-test. Its independent rec was the raw `@google/genai` API (**Path B**).
2. **Empirical discovery.** User installed the Antigravity CLI (`agy` 1.0.13, Google AI Pro auth). Direct probing beat web research: `agy --print` returns clean JSON headlessly, `--conversation <id>` resumes sessions, models are Gemini 3.x. This contradicted the workflow's anti-CLI claims (no stdout-drop bug; clean schema output observed).
3. **Decision — Path A (wrap `agy`)** over Path B, on the user's stated priority: **$0 on the existing Pro subscription + native resumable sessions** (no local history store needed). It's also the closer twin to the existing CLI-under-SDK architecture.
4. **Spike (→ L-009).** Validated end-to-end that an `agy` conversation id is capturable (`~/.gemini/antigravity-cli/cache/last_conversations.json`, keyed by cwd) and resumable in `--print` mode — token set in turn 1 was recalled in turn 2 with the token absent from turn 2's prompt. This **retired the biggest design risk** (session continuity on a seemingly stateless provider).
5. **The `agy` detour (→ L-010).** When the user asked `agy` to "investigate," it *implemented* a full Path-B backend unprompted (REST + native fetch + a `session_messages` table). Competent, but: wrong path, classes over factories, reused `CODEX_*` error codes for Gemini, baked in the O(N²) chunk-replay bug, hardcoded a model, added env-based auto-switch magic. **Stashed (`stash@{0}`)** for reference; not adopted.

## Decisions locked
- **Surface:** wrap `agy --print --sandbox` (Path A). Zero new npm deps; uses the Pro subscription.
- **Config:** `provider: 'codex'|'gemini'` (default `codex` → zero breaking change). Explicit only — no env auto-switch.
- **Sessions:** agy conversation id = `session_id`; capture from `last_conversations.json`; resume via `--conversation`. Serialize capture (concurrency caveat). **No ConversationStore.**
- **Chunking:** run chunks independently + merge; resume only across phases (avoids O(N²) replay).
- **Models:** `model: 'latest'` sentinel resolved per-backend (`agy models` for Gemini; SDK-pinned id for the other — do NOT chase newest, per L-008). Recommend-not-enforce preserved (L-006).
- **Provenance:** tag sessions by provider so ids aren't silently cross-resumed.
- **Dual/cross-review:** deferred to a later phase; the seam won't preclude it (merged-with-provenance output).
- **Effort:** ~3–5 engineer-days; the path-independent refactor dominates, not the Gemini specifics.

## Tickets (phase `multi-provider`)
Roots (no deps): **T-013** (ReviewBackend seam + orchestrator extraction), **T-014** (generic-ize error codes), **T-015** (provider config + per-provider defaults).
- **T-016** Gemini backend via `agy` ← T-013, T-015
- **T-017** provider provenance ← T-013
- **T-018** selection + wiring ← T-013, T-015, T-016
- **T-019** `model:'latest'` resolver ← T-015, T-016
- **T-020** dual-backend tests ← T-016, T-018

**Critical path:** T-013 → T-016 → T-018 → T-020.

## Next
Start **T-013** — the path-independent foundation refactor: rename `CodexClient`→`ReviewBackend`, extract the shared orchestrator parameterized by a per-turn `TurnRunner`, move Codex specifics into `src/backends/codex.ts`. **No behavior change; suite must stay green.** TDD discipline (user-reinforced): write the **T-001 partial-failure ordering** regression test FIRST (it passes on current code), then refactor under it. New behavior in later tickets follows red→green→refactor.

## Key pointers
- `src/codex/client.ts` — current seam (`CodexClient` 53-57), `runReview` (163-238), chunk loops (418-446 reviewCode, 514-536 reviewPrecommit), `classifyError` (74-133), `threadOpts`/`resumeThreadOpts` (142-161), merge/dedup (256-308).
- `stash@{0}` — stashed Path-B PoC (reference only; `git stash show -p stash@{0}`).
- **L-009** agy session mechanics · **L-010** sandbox-the-agent constraint.
- Prod-realistic tests: mock only the external boundary (the `agy` subprocess / SDK / git / fs), never internal chunking/merge/config.