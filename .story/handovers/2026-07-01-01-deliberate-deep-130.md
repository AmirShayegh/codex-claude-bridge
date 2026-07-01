## Session handover — deliberate-deep (T-025) built + shipped as v1.3.0

### What shipped
Phase 2 of Deliberation — a fourth review mode, **`deliberate-deep`** (T-025, now complete). After both providers review a plan/diff independently (v1 `deliberate`), each provider's **divergent** (one-sided) findings are handed to the **other** provider to adjudicate: `confirmed` | `disputed` | `unsure` + reason. This makes agreement *semantic* instead of positional — the motivating problem from dogfooding v1 was that two same-meaning findings stayed `divergent` under exact `file:line:category` key matching, and a shared false positive slipped through.

Published **v1.3.0** to npm (`npm view codex-claude-bridge version` → 1.3.0), tagged `v1.3.0`, pushed to origin/main.

### Commits (on main, pushed)
- `f0574a0` feat: add deliberate-deep cross-review round to deliberation mode
- `f82bfce` chore: bump version to 1.3.0  (tag `v1.3.0`)

### How it's built (the seam)
- **`ReviewBackend.crossReview?(input)`** — new *optional* capability (`src/backends/backend.ts`). Leaf backends (codex, gemini) implement it via the orchestrator's existing structured-output turn (`runCrossReview` in `orchestrator.ts`, wired in `codex.ts` + `gemini.ts`). Composites do **not** expose it — the deliberation composite calls it on its underlying leaves. This keeps the tool/CLI layers untouched.
- **`CrossReviewResultSchema`** = `{ adjudications: { index, verdict, reason }[] }` (`src/codex/types.ts`); `buildCrossReviewPrompt` presents findings neutrally ("Another reviewer flagged…", "do not defer"), numbered by index, delimiter-injection-safe (`src/codex/prompts.ts`).
- **Composite** (`src/backends/deliberation.ts`): `createDeliberationBackend(primary, secondary, { crossReview: true })`. In the both-ok branch, when there are divergent findings, `adjudicateDivergent` runs the 2 cross-review calls in parallel (primary's divergent judged by secondary, and vice-versa) and attaches an optional `adjudication` to each divergent item **by index**. Best-effort: a missing capability or a failing/out-of-usage provider leaves that side un-adjudicated; the deliberation result still returns.
- **Wiring**: config `mode` enum gained `'deliberate-deep'` (`src/config/types.ts`); `createBackend` routes it (`src/backends/index.ts`). Divergent schema item gained the optional `adjudication` block (`src/codex/types.ts`).
- Scope: **plan + code only**. `review_precommit` stays failover. Resumed sessions don't deliberate.

### Verified (probe-loop, real path)
Ran the CLI with a real `.reviewbridge.json` (`mode: deliberate-deep`, codex gpt-5.5 primary) against a bug-bearing auth diff. Both real providers reviewed, **two live cross-review turns fired**. Read the output JSON: 5 divergent findings, each adjudicated by the *other* provider (no self-adjudication, correct index alignment, `chunks_reviewed` absent). All 5 came back `confirmed`. Clean probe — no bug found. (Note: agreement was `mixed`/`agreed: []` because the two providers cited different lines/categories for the same bugs — exactly the positional-matching limitation deliberate-deep is designed to paper over via semantic adjudication.)

### Quality gates
typecheck ✅ · lint ✅ · **677 tests pass** (+14 new: 6 composite in `deliberation.test.ts`, 5 prompt in `prompts.test.ts`, 2 orchestrator in `orchestrator.test.ts`, 1 wiring in `index.test.ts`). `prepublishOnly` re-ran all gates before publish.

### Standing items / next
- **Restart Claude Code** to move the MCP servers (`codex-bridge`, `codex-bridge-local`) onto 1.3.0 — MCP doesn't hot-reload (L-013). The local CLI already runs fresh `dist`.
- **Rotate the npm token** — `npm_sZGl…` has been pasted into the transcript across sessions; publishes worked (whoami: ashayegh) but it should be rotated.
- The **Deliberation** phase is now effectively done (T-024 + T-025 complete). Next candidate phases: **Team Integration** (review_pr tool + CLI via `gh`) or **Polish** (review presets + MCP progress notifications). 4 open issues remain — triage before starting a new phase.
- Possible follow-up (deferred, not ticketed): heavier finding **anonymization** in cross-review only matters at 3+ providers; skipped intentionally.
