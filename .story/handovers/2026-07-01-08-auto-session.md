# Handover — Deliberation Hardening Phase complete (7/7 targets)

## Summary
Targeted autonomous session over the 7-ticket Hardening phase (PHASE 11), all committed to `main`. Six tickets were planned/reviewed/implemented normally; the seventh (T-029) surfaced a **critical regression** via a live probe and fixed it as its unblock prerequisite. Full gate green throughout: typecheck + lint clean, **786 tests pass** (was ~765 at session start).

## Tickets completed (in dependency order)
- **T-026** — looksLikeDiff accepts hunk-less git diffs (metadata/binary/rename-only). Commit 5ad9b9e.
- **T-027** — cross-provider session-resume routing + read-only db guard (makeSessionProviderLookup, checkSessionProvider, fail-open). Commit 069ac84.
- **T-028** — composite backend (single/failover/deliberate/deliberate-deep), per-call `deliberate` input, `review_mode` stamping, degraded agreement. Commit 0f41515.
- **T-030** — deliberate-deep cross-review slices the subject diff to the reviewed files + budget-fails; threads model + maxChunkTokens on fresh AND resume paths. Commit c54f977.
- **T-031** — config no-op audit (ISS-004): removed dead max_file_size, wired precommit.auto_diff (MCP + CLI --auto-diff/--no-auto-diff), loader unknown-key stderr warnings. Commit b434a4f.
- **T-032** — MODEL_ERROR classifier: distinct message when the rejected model differs (case-insensitively) from the model actually sent — the Codex-internal-subsystem case (ISS-003). Commit 71b8f1e.
- **T-029** — semantic cross-provider agreement matching (ISS-013). Commit 9160920. Its prerequisite hotfix ISS-019 is commit badf79b.

## MAJOR discovery: ISS-019 (critical, was breaking all live Codex reviews)
During T-029 Step 1 (which requires both providers live), a live deliberate-deep probe revealed that `review_mode` (added to the *ResultSchema in T-028) leaked into the model-facing *ResponseSchema in orchestrator.ts — the `.omit()` lists dropped session_id/provider/deliberation/chunks_reviewed but not review_mode. Since review_mode is `.optional()`, toJSONSchema emitted it as a non-required property, and OpenAI structured outputs REJECT any schema whose `required` omits a property. Result: **every live Codex structured review (plan/code/precommit, single AND deliberate) failed** with invalid_json_schema. Invisible because (a) tests mock the SDK, (b) Gemini doesn't enforce the constraint so reviews silently degraded to Gemini-only, (c) Codex was rate-limited the whole session T-028 landed in. FIX: add review_mode to the 3 omit lists + a RECURSIVE lock test asserting required-covers-properties at every nesting level (guards the whole category). NOTE: the regression lived only on unreleased main — NOT in the published npm 1.4.0.

## Key decisions
- **T-032**: context.model passed to classifyError is the RESOLVED/sent model (not raw config.model); the mismatch guard compares extracted-vs-sent case-insensitively, which is exactly the internal-call signature with effectively zero false positives.
- **T-029 matcher design is DATA-DRIVEN** from 3 live two-provider runs (note N-002): line drift 0-2, category vocab genuinely unstable, same-line clusters exist. Chosen: LINE_WINDOW=2 (observed max drift; distinct bugs sit >=3 lines apart) + greedy 1:1 pairing where same-normalized-category merges within the window but different-category merges ONLY at the exact same line (Δ0). This deviates from the ticket's original 'category-agnostic' suggestion because the cluster data proved category is needed to disambiguate — a plan-review finding reinforced this (different-category cross-line pairing would false-merge and silently discard a finding).
- **T-029 committed as TWO commits** (ISS-019 hotfix, then matcher) for rollback clarity, per a plan-review recommendation.
- Codex was rate-limited for most of the session, so plan/code reviews were served via the Gemini failover; the T-029 code review and live probes ran with Codex live (headroom returned ~evening).

## Housekeeping
- Resolved issues: ISS-003 (T-032), ISS-004 (T-031 — was left open despite the fix shipping; closed this session), ISS-013 + ISS-019 (T-029). Earlier tickets already resolved ISS-010..017.
- New artifacts: note N-001 (probe kit), note N-002 (T-029 drift data), issue ISS-019.

## What's next
- **ISS-018** [low] remains OPEN (out of scope this session): the CLI cross-provider guard is cwd-dependent because reviews.db resolves relative — the guard fails open when the CLI runs outside the server's cwd. Candidate for a follow-up ticket.
- **Consider a release**: main now has T-026..T-032 + the ISS-019 hotfix, none of which are in the published npm 1.4.0. The ISS-019 fix in particular means live Codex structured reviews (and deliberate-deep) only actually work on unreleased main — a version bump + publish would ship the whole hardening phase and unbreak Codex for installed users who pull @latest.
- **Untracked file**: .story/handovers/2026-07-01-07-checkpoint.md (a compaction-hook checkpoint artifact) is uncommitted; safe to delete or commit as session bookkeeping.
- Probe kit lives at scratchpad/probe-deliberation/ (payment.js + probe.diff + config variants) per note N-001 — reusable for future deliberation probes.