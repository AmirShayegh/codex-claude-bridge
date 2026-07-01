# Handover — v1.2.0 published (deliberation live); Phase 2 (LLM cross-review) next

## TL;DR
**Deliberation mode shipped in `codex-claude-bridge@1.2.0`** — published to npm and pushed. `"mode": "deliberate"` runs `review_plan` + `review_code` through both providers and returns a structured agreement/disagreement map. Dogfooding it (deliberation reviewing its own code) even caught a real minor edge case, now fixed. **Next: Phase 2 — an LLM cross-review round** so the two providers semantically adjudicate each other's findings (not just exact-key matching). This handover is the pre-Phase-2 checkpoint.

## State
- Branch `main`, HEAD **`bc712c8`**, **in sync** with origin. Tree: only uncommitted `.story/` tracking (handovers/snapshots) — commit as tracking.
- **npm `latest` = 1.2.0** (verified). Tags `v1.1.0`, `v1.2.0` pushed. `dist` rebuilt.
- Suite **663 green / 33 files**, typecheck + lint clean.
- Recent commits: `f7dad93` (deliberation feat) · `0450e7f` (computeAgreement fix) · `bc712c8` (bump 1.2.0).

## What's live in 1.2.0
`"mode": "deliberate"` (config `single|failover|deliberate`, derived from `fallback` when unset). Both providers review plan/code in parallel; the merged result carries an additive `deliberation` block: `providers`, `verdicts[]`, `agreement` (agree|mixed|conflict), `agreed[]` (both flagged — high confidence), `divergent[]` (one flagged), optional `degraded`. Degrades to a single provider if one is out of usage; `review_precommit` + resumed sessions stay failover. Files: `src/backends/deliberation.ts` (+test), `src/codex/types.ts` (schema), `src/backends/index.ts` (wiring), `src/config/types.ts` (`mode`), README (Deliberation section). Tracked: **T-024 complete**, `deliberation` phase.

## Dogfood findings (why Phase 2 matters — read this before building)
Ran deliberation on real diffs. Two concrete lessons:
1. **Exact-key matching misses semantic agreement.** On the failover diff, BOTH providers flagged the same concern (the `fallback` default) but at adjacent lines / different categories, so they landed as two *divergent* findings instead of one *agreed* (high-confidence). v1 keys on `${file}:${line}:${category}` — it can't tell that two differently-worded findings mean the same thing. **This is exactly what an LLM cross-review round fixes.**
2. **The caller-as-synthesizer design is right.** That convergent finding was actually a *false positive* — the diff didn't include the Zod `.default(true)`, so both models assumed failover was off by default. Only the caller (Claude Code), with full repo context, could adjudicate it. Two models agreeing looked high-signal but shared a blind spot. Keep the human/agent as final judge.
3. Deliberation caught a real edge case in its own `computeAgreement` (same-provider same-key dupes collapsing to last-seen instead of highest-severity) → fixed in `0450e7f`.

## Phase 2 — LLM cross-review round (T-025, to be created)
**Goal:** after both providers draft their reviews, each provider critiques the OTHER's findings (anonymized) — confirm / dispute / "you missed X" — so agreement is semantic, not positional. Then the caller synthesizes with that adjudication.

**Reuse (from `/Users/amirshayegh/Developer/llmtium`, MIT, the user's):** the engine sits on a narrow provider seam; lift the provider-agnostic pieces:
- `packages/core/src/engine/anonymizer.ts` — label randomization (`anonymize`) + per-reviewer deterministic shuffle (`shuffleForReviewer`) + `deanonymize`.
- `packages/core/src/schemas/cross-review.schema.ts` + `types/cross-review.ts` — the CrossReview shape (scores, issues, disagreements-with-quotes, missing_info, confidence). Adapt to *findings* rather than free-text responses.
- `packages/core/src/workflows/shared-prompts.ts` `buildReviewPrompt` — the cross-review prompt pattern.
- Do NOT lift llmtium's provider adapters (key-based); implement against the bridge's `ReviewBackend.reviewX` + each backend's `structuredOutput` path instead.

**Design decisions to settle with the user before coding:**
- **Activation:** a new mode (`deliberate-deep`?) or a flag (`cross_review: true`) on deliberate? Cross-review is +2 LLM calls (4 total) → cost/latency.
- **What it adds to output:** per-divergent-finding adjudication (the other provider's confirm/dispute + reason) enriching the `deliberation` block; possibly re-bucket a divergent finding into `agreed` when the other provider confirms it.
- **Anonymization:** present findings to the cross-reviewer without provider labels (kill identity bias, per llmtium).
- **Degradation:** if a provider can't cross-review, fall back to v1's computed map.

**Architecture fit:** stays behind the `ReviewBackend` seam (a richer deliberation composite, or a stage inside `deliberatePlan`/`deliberateCode`). The bridge already has structured-output + parse-retry per backend to reuse for the cross-review call.

## Next steps
1. Commit the uncommitted `.story/` tracking.
2. **Plan + build Phase 2** (T-025). Given the design decisions above, worth a quick design/confirm before coding.
3. **Release** Phase 2 as 1.3.0 when done.

## Standing action items
- **Rotate the npm token** (pasted in chat; used again for the 1.2.0 publish).
- **Restart Claude Code** to move the MCP servers onto 1.2.0 (L-013 — they don't hot-reload). `npx …@latest` now resolves to 1.2.0.

## Also open (non-blocking)
Lower-tier review items (m2 timeout semantics, m5 injection-disputed, m6 + nitpicks, merge-helper test gaps).
