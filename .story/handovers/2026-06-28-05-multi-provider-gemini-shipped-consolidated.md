# Session Handover (consolidated): Multi-Provider — Gemini backend shipped, wired, and live-validated

**Consolidates the session's earlier handovers (`...-03-...`, `...-04-...`) into one self-contained record.** Read this one.

**Date:** 2026-06-28 (long single session)
**HEAD:** `3108e9c` · **Suite:** 558 tests / 31 files green · **Tree:** clean
**Span:** Finished T-013, then T-014 → T-015 → T-016 → T-018. ~16 green commits, suite green at every one.

## Headline
The OpenAI-Codex-only review bridge is now **multi-provider**. A second backend — **Google Gemini via the Antigravity `agy` CLI** — is implemented, selectable by config, and **validated live end-to-end against real agy** (returned a real verdict + summary + conversation-id `session_id` in ~7s). Setting `"provider": "gemini"` in `.reviewbridge.json` routes reviews through agy; the default stays `codex` with zero behavior change.

## Tickets closed this session
- **T-013** — ReviewBackend seam + shared orchestrator. The seam every backend implements; orchestrator owns the provider-neutral flow (chunking, dedup, merge, parse-retry) and exposes three capability flags. (~75% of the codebase was already provider-agnostic; this refactor was the bulk of the work.)
- **T-014** — provider-neutral errors: `CODEX_TIMEOUT`→`REVIEW_TIMEOUT`, `CODEX_PARSE_ERROR`→`RESPONSE_PARSE_ERROR`; dropped "OpenAI Codex" from `SERVER_INSTRUCTIONS` + the CLI description (deliberate user-facing contract change; assertions updated).
- **T-015** — `provider: 'codex'|'gemini'` config (default codex → zero breaking change); `model` now optional with the default resolved **in the backend**, not the schema; `RECOMMENDED_MODELS` → per-provider Record. Config layer still imports no backend code.
- **T-016** — Gemini backend (`src/backends/gemini.ts`): `runAgyPrint` (spawn `agy --print --sandbox --model <m> [--conversation <id>]`, prompt via stdin), `classifyAgyError`, `readConversationId` (capture from agy's cache), `runSerialized` (capture-race mutex), `createGeminiBackend`. Live-validated.
- **T-018** — `createBackend(config, copilot)` selects backend by `config.provider`; `server.ts` + `cli/commands.ts` wired to it; CLI init-failure message neutralized.

## Architecture (current)
```
src/backends/
  backend.ts       → ReviewBackend interface (the single seam)
  orchestrator.ts  → provider-neutral flow + 3 capabilities on ReviewFlowDeps:
                       • allowsModelOverrideOnResume  (codex false, gemini true)
                       • resumesAcrossChunks          (codex true, gemini false → independent chunks)
                       • defaultModel                 (backend-supplied default)
  codex.ts         → createCodexBackend (TurnRunner via @openai/codex-sdk; new Codex() lazy inside)
  gemini.ts        → createGeminiBackend (TurnRunner via agy subprocess)
  index.ts         → createBackend(config) — selects by config.provider (sync, exhaustive)
config/types.ts    → provider enum, optional model, RECOMMENDED_MODELS Record (NO backend imports)
```

## agy facts (verified live, agy 1.0.13, Google AI Pro)
- Prompt passed via **stdin** (positional arg ignored). `--print --sandbox` → **clean JSON** on stdout.
- `agy models`: "Gemini 3.5 Flash (Medium/High/Low)", "Gemini 3.1 Pro (Low/High)", "Claude Sonnet 4.6 (Thinking)", "Claude Opus 4.6 (Thinking)", "GPT-OSS 120B (Medium)". Effort is part of the model string → `reasoning_effort` not applied for gemini. `GEMINI_DEFAULT_MODEL = "Gemini 3.5 Flash (Medium)"`.
- Session capture: `~/.gemini/antigravity-cli/cache/last_conversations.json` keyed by cwd → uuid. Resume: `--conversation <id>`. agy persists natively → no local history store.
- L-010: agy is an autonomous agent — it WRITES code unless constrained. Mitigation in place: `--sandbox` + JSON-only prompt.

## Runway (multi-provider phase)
- **T-017** provider provenance — tag sessions with their provider so a codex thread-id and an agy conversation-id can't resume under the wrong backend (clear error, not a confusing one). **Recommended next.**
- **T-019** `model: "latest"` resolver per provider. Mind **L-008**: SDK-path "latest" = latest the *pinned SDK* supports, not newest announced.
- **T-020** dual-backend test suite (unblocks once selection + latest land).

## Verification standing
- Gemini backend: live-validated against real agy.
- Selection routing: unit-tested (`index.test.ts`). Server/CLI wiring: mocked tests. Codex path: `server.integration.test.ts` (mocked SDK).
- Optional remaining proof: a single **live CLI run** with `provider:'gemini'` (build + temp `.reviewbridge.json`) exercises the built binary end-to-end. High-confidence-but-redundant given the above; not yet run.

## Directives in force
- **TDD for everything** (red→green for new behavior; characterization for refactors).
- **Always use the latest model per provider** (→ T-019).
- Per-increment small green commits; **no AI tool names / co-author tags in commit messages** (describe what/why, not who wrote it).
- Live-validate risky integrations.

## Verify before resuming
`npm test` (558, 31 files) · `npm run typecheck` · `npm run lint` — all green at `3108e9c`. Tree clean.

## Pointers
- Lessons **L-009** (agy session mechanics — live-confirmed) and **L-010** (sandbox the agent — honored).
- Guard tests pinning preserved behavior: `src/backends/codex.test.ts` (retry, model-on-chunk-1-only, T-001 partial-failure) and `src/backends/orchestrator.test.ts` (the three capabilities).
- `stash@{0}` — the original Path-B `@google/genai` PoC (reference only).
