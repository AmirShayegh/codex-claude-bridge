# Session Handover: Release train 0.3.0 → 0.3.5

**Date:** 2026-04-23
**Span:** Full working day
**Net change:** Six npm releases, one PR merged (T-011), three new lessons, one issue filed, one issue resolved, one policy reversal.

## What shipped (chronologically)

| Version | SHA | Headline |
|---|---|---|
| **0.3.0** | 558912d | Default model bumped `gpt-5.4` → `gpt-5.5`; `@latest` pinned in every README install/usage command |
| **0.3.1** | 14d2792 | Tightened MODEL_ERROR classifier (anchored regex); preserves raw error via `Original error:` suffix |
| **0.3.2** | 1a97616 | Targeted fallback tip when Codex rejects a model for ChatGPT-account auth |
| **0.3.3** | 2d6367d | T-011: per-call `model` override on all 3 review tools (MCP + CLI), merged via PR #6 |
| **0.3.4** | d48947d | Config-level `model` allowlist via `superRefine` — **reverted same day** |
| **0.3.5** | 3439091 | Revert of 0.3.4; model stays permissive, `SUPPORTED_MODELS` renamed to `RECOMMENDED_MODELS` |

All on `main`, all linear history, all published to npm with matching GitHub Releases.

## Storybloq seeded + used

`.story/` initialized mid-day with 7 phases, 10 forward-looking tickets, 3 issues, 4 lessons. Committed to git (option A). Three handovers now on disk including this one.

Current status:
- **Tickets:** T-011 complete (shipped 0.3.3). T-001, T-002, T-003, T-007, T-008 ready to work. T-004, T-005, T-006, T-009, T-010 blocked on dependencies.
- **Issues:** ISS-001 resolved (classifier bug, fixed in 2f17aa2). ISS-002 low-priority housekeeping. **ISS-003 open** — MODEL_ERROR tip misleads when the failing model is from a Codex internal subsystem (e.g. the memory-writing agent) rather than the caller's configured model.
- **Lessons added today:** L-005 (SDK forwards `--model` on resume), L-006 (recommend-not-enforce policy, updated during the 0.3.4 reversal), L-007 (Codex CLI memory agent hardcodes gpt-5.1-codex-mini on ChatGPT tier).

## The 0.3.4 reversal — worth internalizing

Captured as L-006, but writing it up here because it's the biggest meta-lesson of the day:

0.3.4 tightened `.reviewbridge.json` by rejecting any `model` value other than `gpt-5.5` / `gpt-5.4` via `z.superRefine`. User pushed back within minutes: *"we shouldnt offer it ourselves (5.1) but if user chooses it we shouldnt block them."* 0.3.5 reverted.

The confusion was in my framing: I treated "document only 5.5/5.4" and "enforce only 5.5/5.4" as the same thing. They're not. **Curation scopes recommendations; enforcement sets permission boundaries.** The project wants the first, not the second. When in doubt on future policy changes: default to documentation and leave schemas permissive unless a value is categorically dangerous.

## The gpt-5.1-codex-mini mystery (now captured as L-007)

Earlier in the day a parallel session reported the bridge trying `gpt-5.1-codex-mini`. Binary-grep on `~/.nvm/.../codex` revealed the root cause: Codex CLI has an internal *memory-writing agent* at `codex_core::memories::phase1` / `phase2` that fires background calls using a hardcoded `gpt-5.1-codex-mini`. On ChatGPT-subscription auth that specific model isn't supported, so the memory-agent call errors and bubbles up through our SDK path as if it were our review request. The error text names `gpt-5.1-codex-mini`, not the model we configured.

**Implication for ISS-003:** our classifier tip says "Fall back to gpt-5.4" even when the user is already on gpt-5.4 and the failure is from a Codex subsystem they can't reach. Fix is to detect extracted-model ≠ configured-model and emit a distinct tip pointing at API-key auth or disabling memories. Not yet shipped — next session can pick it up from ISS-003.

## State of main

```
3439091 0.3.5   ← current
161f3db revert: drop config model allowlist
d48947d 0.3.4
ef803d4 feat: restrict .reviewbridge.json model
bcb8112 chore: file ISS-003 and L-007
02e88f6 chore: capture L-006 (supported model policy)
d9da0c2 docs: drop mini/older Codex variants
d7c6c2f chore: T-011 complete; capture L-005
2d6367d 0.3.3
...
```

Working tree clean. No open PRs. No stale branches. Four older local branches (`docs/improve-presentation`, `feat/standalone-cli`, `feat/wire-chunking`, `fix/user-feedback-v0.1.5`) still untouched — flagged earlier, left for a deliberate pass.

## Open threads for next session

1. **ISS-003 (medium) — misleading MODEL_ERROR tip when failing model ≠ configured model.** ~15 LOC + 20 LOC test. Straightforward. Would ship as 0.3.6.
2. **T-001 — multi-chunk session orphaning.** Reliability phase. Self-contained.
3. **T-002 — `saveReview` + `markSessionCompleted` atomicity.** Reliability phase. Transaction wrap + test.
4. **Stale branches** — four leftover locals worth pruning or resurrecting.

## Key files to remember

- `src/codex/client.ts` — classifier (lines 86-113), `runReview` (141-210), per-call override plumbing
- `src/config/types.ts` — `RECOMMENDED_MODELS` constant (lines 11-12), permissive `model` field
- `.reviewbridge.json` (gitignored) — pinned to `gpt-5.4` for the developer's ChatGPT-tier auth during the 5.5 rollout window
- `~/.codex/config.toml` — developer's Codex CLI default also `gpt-5.4`

## Meta

Six releases in one day is a lot. Five landed cleanly; one (0.3.4) needed same-day reversal because of a design mistake on my end (curation vs enforcement). Worth setting a light pre-release bar for future policy-enforcing schema changes: *"would a reasonable user object to this being a hard error?"* If yes, ship as a warning or documentation instead. L-006 now captures this as project-level guidance.
