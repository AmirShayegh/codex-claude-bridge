## Session handover — deliberation system reviewed, probe-verified, and drained into a tracked Hardening phase

### State at handoff
- **Working tree: clean.** HEAD `0f48d92` = origin/main (unchanged this session — this was a review/planning session, no code committed). CLAUDE.md is gitignored.
- **npm `codex-claude-bridge@1.4.0` is live.** No publish this session.
- **No active autonomous session.** Guard checked clean at handoff.
- **storybloq validate: 0 errors / 0 warnings.** Snapshot taken (`2026-07-02T01-00-51`).
- **Next intended action (NOT yet started):** a targeted `/story auto` session over the 7 Hardening tickets in dependency order (see "The queued autonomous session" below). The user asked for this handover FIRST; launch the auto session immediately after.

### What this session did (no code — review, verification, and planning)
1. **Reviewed the deliberation subsystem** (`src/backends/deliberation.ts`, `failover.ts`, `backend.ts`, `index.ts`, cross-review in `orchestrator.ts`/`prompts.ts`, schema in `review/types.ts`, tool layer). Found 7 issues → filed **ISS-010…ISS-016**.
2. **Ran a probe-loop** (probe-loop skill) exercising the REAL path: CLI against built `dist` 1.4.0, live Gemini + live Codex, a scratch git repo with a planted-bug diff. **Live-confirmed** the high/medium findings and discovered one more → filed **ISS-017**. Full probe kit preserved as **note N-001** (planted-bug diff, 3 config variants, exact command sequence + expected outputs).
3. **Triaged all 12 open issues**, grouped by shared root cause, resolved **ISS-002** (was a stale confirmation note; gitignore already landed in `98eedf5`).
4. **Created the Hardening phase** (id `hardening`, PHASE 11, positioned after Deliberation) with **7 verification-grade tickets T-026…T-032**. Every file:line in every ticket was re-checked against actual code; every design decision is made IN the ticket (they will be implemented by a less-capable model, so ambiguity was deliberately removed).
5. Cross-linked all 11 remaining issues ↔ source tickets (T-024/T-025) ↔ fixing tickets, both directions.

### Probe-loop findings (what's real, with evidence)
- **ISS-010 CONFIRMED** (silent no-op): a resumed review in deliberate mode returns a single-provider result with NO deliberation block and no marker. Because the MCP instructions tell callers to always thread `session_id` plan→code, deliberation effectively only runs on the FIRST review of any lifecycle.
- **ISS-011 CONFIRMED** (cross-layer trust violation): a degraded deliberation returns the SECONDARY's session_id, but the composite routes the next resume to the (still-dead) PRIMARY → hard `PROVIDER_UNAVAILABLE`, even though the session's real owner is healthy.
- **ISS-016(1) CONFIRMED**: degraded results report `agreement:'agree'` with a single provider — reads as false consensus.
- **ISS-017 NEW** (medium): the cross-provider resume guard lives ONLY in the MCP tool layer (`session-tracker.ts`). The CLI opens no DB and calls the backend directly, so a foreign `session_id` surfaces as a raw provider error instead of a clean rejection.
- **Clean probes:** v1.4.0 `PROVIDER_UNAVAILABLE` classification + failover works exactly as shipped; real `RATE_LIMITED` degradation is graceful; Gemini `agy --conversation` resume continues the same session id.

### The Hardening phase — 7 tickets, dependency-correct order
1. **T-026** — Accept binary-only & rename-only diffs (ISS-005). Unblocked. `looksLikeDiff` at `orchestrator.ts:42`; add binary/rename markers, keep the two-marker principle. Quick isolated win.
2. **T-027** — Session ownership at the backend seam (ISS-011 + ISS-017). Unblocked. THE foundation. Adds `providers[]` to the seam, membership-based guard, a SYNC `lookupSessionProvider`, routes resumes to the owning leaf, and a shared `openReviewDb()` so CLI gets the same guard as MCP. Verification surfaced: **the CLI never opens the DB at all** (`server.ts`-only), and `tag()` in failover.ts stamps `primary.provider` unconditionally (latent bug the routing must fix).
3. **T-028** — Deliberation visibility (ISS-010 + ISS-016 + ISS-012 marker-half). blockedBy T-027. Per-call `deliberate` toggle (MCP + CLI), `review_mode` stamped on ALL result schemas incl. precommit, deliberate-on-resume (resume owner + fresh secondary), `agreement:'degraded'` value, `cross_review_failures[]`, `chunks_reviewed` propagated. Absorbs the long-open "surface active mode/providers" handover item.
4. **T-030** — Deliberate-deep polish (ISS-012 chunking-half + ISS-014 + ISS-015). blockedBy T-028. Slice cross-review subject to referenced files; thread primary model override into adjudication; document verdict-is-pre-adjudication (don't recompute).
5. **T-031** — Config no-op audit (ISS-004). blockedBy T-028. Audit PRE-DONE & grep-verified in the ticket: exactly two no-ops — `max_file_size` (remove) and `precommit.auto_diff` (wire). Warn on unknown keys, never `.strict()`. Sequenced after schema work so it audits once.
6. **T-032** — MODEL_ERROR tip refinement (ISS-003). Unblocked, lowest priority. Scope shrank (half already fixed by ISS-009). Just add the extracted-model ≠ configured-model branch in `classifyError` (`codex.ts:46-76`).
7. **T-029** — Semantic agreement matching (ISS-013). blockedBy T-028 **AND external data**. Placed LAST because it requires live two-provider probe data to design the fuzzy match key — ticket says hand back rather than guess. See Codex-limit note below.

### ⚠️ External blocker for T-029
Codex hit its ChatGPT-tier **usage limit** this session (real, not our bug) — "try again at **5:27 PM**". T-029's step 1 (gather real cross-provider divergence data via the N-001 probe kit) needs BOTH providers live. If Codex is still capped when the auto session reaches T-029, it should gather what it can or hand back — do NOT design the match key from invented data (the ticket enforces this).

### The queued autonomous session
Launch: targeted `/story auto` with `targetWork: [T-026, T-027, T-028, T-030, T-031, T-032, T-029]`. That order respects every `blockedBy` and defers the externally-blocked T-029 to the end. Note storybloq_status shows "10 blocked" — that's the blockedBy chain (T-028/029/030/031 gate on their predecessors), expected and correct; the auto guide will unblock them as predecessors complete.

### House rules the tickets already encode (reminders for the implementer)
TDD (failing test first); ESM `.js` import suffixes; no `any`/`as`; Result<T> (no throws) with ErrorCode prefixes; config layer must NOT import from review layer; Zod v4 nested defaults use function form `.default(() => Schema.parse({}))` (L-001); mock only external boundaries (SDK/git/fs), never internal logic (prod-realistic tests feedback); MCP servers don't hot-reload — restart to pick up rebuilt dist (L-013); recommend gpt-5.5/gpt-5.4 only, never block user model choice (L-006); no AI tool names in commit messages; code review the diff line-by-line before every commit.

### Not done / deferred
- No code written, nothing committed, nothing published this session.
- npm token rotation (flagged across prior sessions) — still pending hygiene.
- The LLM-eval-harness idea (measure whether deliberation beats single-model) — still just a sketch in earlier handovers, not started.
