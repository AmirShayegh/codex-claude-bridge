# Session Handover: Multi-Provider — Gemini backend shipped & live-validated; selection wiring is the next step

**Date:** 2026-06-28 (long continuation session)
**Span:** Finished T-013, then T-014 → T-015 → T-016 → started T-018. ~14 green commits, suite green at every commit (558 tests, 31 files at HEAD `69aaea9`). Tree clean.

## Headline
The **Gemini backend works end-to-end against real `agy`** — not just mocks. A live smoke test returned a real verdict, summary, and a real conversation-id `session_id` in ~7s. The whole multi-provider phase's hard parts are done; what remains is wiring selection so users can actually pick `provider: "gemini"`.

## Tickets closed this session
- **T-013 complete** — ReviewBackend seam + shared orchestrator. (Finished increments 4-5: `allowsModelOverrideOnResume` capability; retired the `codex/client.ts` shim; renamed `createCodexClient`→`createCodexBackend`.)
- **T-014 complete** — provider-neutral errors: `CODEX_TIMEOUT`→`REVIEW_TIMEOUT`, `CODEX_PARSE_ERROR`→`RESPONSE_PARSE_ERROR`; dropped "OpenAI Codex" from `SERVER_INSTRUCTIONS` + CLI description. (Deliberate user-facing contract change — assertions updated, not papered over.)
- **T-015 complete** — `provider: 'codex'|'gemini'` config (defaults to codex → zero breaking change); `model` now optional with the default resolved **in the backend** (`CODEX_DEFAULT_MODEL`, threaded via `ReviewFlowDeps.defaultModel`); `RECOMMENDED_MODELS` → per-provider Record.
- **T-016 complete** — Gemini backend via `agy` (`src/backends/gemini.ts`): `runAgyPrint` (spawn `agy --print --sandbox --model <m> [--conversation <id>]`, prompt via stdin), `classifyAgyError`, `readConversationId` (capture from agy's cache), `runSerialized` (capture-race mutex), `createGeminiBackend`. **Live-validated** end-to-end.

## T-018 — IN PROGRESS (the immediate next task)
Goal: dispatch to the chosen backend and wire it through the entry points.
- **DONE & committed (`69aaea9`):** `src/backends/index.ts` → `createBackend(config, copilotInstructions)` switches on `config.provider`. Sync (no async ripple): only the selected provider's client initializes because `new Codex()` is already lazy inside the codex factory and agy spawns per-review. Exhaustive switch (`satisfies never`). Tested in `src/backends/index.test.ts` (4 tests).
- **REMAINING (do this next):**
  1. `src/server.ts:81` — replace `createCodexBackend(config, copilotInstr)` with `createBackend(...)`; change import from `./backends/codex.js` to `./backends/index.js`.
  2. `src/cli/commands.ts:74` — same swap; import from `../backends/index.js`.
  3. `src/server.test.ts:20` — change `vi.mock('./backends/codex.js', { createCodexBackend })` → `vi.mock('./backends/index.js', { createBackend })`.
  4. `src/cli/commands.test.ts:6,42,46` — change the mock target to `../backends/index.js`, import `createBackend`, `vi.mocked(createBackend)`.
  5. Confirm acceptance: `provider:'codex'` and `provider:'gemini'` both work via MCP + CLI; only the selected provider initializes. Then mark T-018 complete.

## Architecture (current)
```
src/backends/
  backend.ts       → ReviewBackend interface (the single seam)
  orchestrator.ts  → provider-neutral flow + 3 capabilities on ReviewFlowDeps:
                       allowsModelOverrideOnResume, resumesAcrossChunks, defaultModel
  codex.ts         → createCodexBackend (TurnRunner via @openai/codex-sdk)
  gemini.ts        → createGeminiBackend (TurnRunner via agy subprocess)
  index.ts         → createBackend(config) — selects by config.provider
config/types.ts    → provider enum, optional model, RECOMMENDED_MODELS Record (no backend imports)
```
Gemini capabilities: `allowsModelOverrideOnResume: true`, `resumesAcrossChunks: false` (independent chunks — avoids O(N²) context growth), `defaultModel: 'Gemini 3.5 Flash (Medium)'`.

## agy facts (verified live, agy 1.0.13, Google AI Pro)
- Prompt is passed via **stdin** (a positional arg is ignored). `--print --sandbox` yields **clean JSON** on stdout.
- `agy models`: "Gemini 3.5 Flash (Medium/High/Low)", "Gemini 3.1 Pro (Low/High)", "Claude Sonnet 4.6 (Thinking)", "Claude Opus 4.6 (Thinking)", "GPT-OSS 120B (Medium)". Effort is baked into the model string (so `reasoning_effort` is not applied for gemini).
- Session capture: `~/.gemini/antigravity-cli/cache/last_conversations.json` keyed by cwd → uuid. Resume with `--conversation <id>`. (`RECOMMENDED_MODELS.gemini` now holds the real strings.)

## Runway after T-018
- **T-017** provider provenance: tag sessions with their provider so a codex thread-id and an agy conversation-id can't be resumed under the wrong backend (clear error, not a confusing failure).
- **T-019** `model: "latest"` resolver per provider. Mind **L-008**: for the SDK-backed path "latest" = latest the pinned SDK supports, not newest announced.
- **T-020** dual-backend test suite (blocked until selection + latest land).

## Directives still in force
- **TDD for everything** — red→green for new behavior, characterization for refactors. (Every increment this session followed it.)
- **Always use the latest model per provider** (→ T-019).
- Per-increment small green commits; **no AI tool names or co-author tags in commit messages** (describe what/why, not who wrote it).
- Live-validate risky integrations (did this for agy; recommend a similar smoke once selection is wired).

## Verify before resuming
`npm test` (558, 31 files) · `npm run typecheck` · `npm run lint` — all green at `69aaea9`. Tree clean.

## Pointers
- Lessons **L-009** (agy session mechanics — live-confirmed this session) and **L-010** (sandbox the agent — honored via `--sandbox` + JSON-only prompt).
- Guard tests that pin preserved behavior: `src/backends/codex.test.ts` (retry, model-on-chunk-1-only, T-001 partial-failure) and `src/backends/orchestrator.test.ts` (the three capabilities).
- A throwaway live test (`gemini.live.test.ts`) was used to validate end-to-end and then deleted — re-create it ad hoc if you want to re-verify after wiring.
