# Session Handover: storybloq project initialization

**Date:** 2026-04-23
**Purpose:** Seed `.story/` for codex-claude-bridge with the project's existing history and forward roadmap.

## What happened this session

Three unrelated pieces of work landed before the seed:

1. **v0.3.0 release.** Default model bumped from `gpt-5.4` to `gpt-5.5` after the OpenAI announcement (PDF of announcement in `temp/`, now gitignored). `@latest` pinned in all README install and CLI usage commands so `npx` re-resolves on every launch instead of serving stale cached versions. Published to npm as `ashayegh`. Commits: `5ea2f56` (feature), `558912d` (version bump), `98eedf5` (chore: gitignore temp/ + `npm pkg fix` bin path).

2. **Classifier bug surfaced.** A second Claude Code session (using the freshly installed `codex-claude-bridge@latest` MCP) attempted a review and hit `MODEL_ERROR: Model "detail" is not supported`. Same misclassification hit me here too. Root cause: `src/codex/client.ts:87-93` runs an unanchored `/["']([^"']+)["']/` against any error text and assumes the first quoted token is a model name. Any error body containing `"detail"` (OpenAI API error shape) gets reclassified as a bogus MODEL_ERROR, swallowing the real message. **Filed as ISS-001 (high).** User opted to file not patch — the fix belongs in a deliberate pass.

3. **Housekeeping.** Force-deleted merged local branch `feat/review-code-auto-diff`. `temp/` added to `.gitignore`. `npm pkg fix` normalized `bin` from `./dist/index.js` to `dist/index.js`, silencing the publish-time warning.

## Storybloq seed decisions

**Phase structure (7 phases).** The historical docs (`roadmap.md`, `phases.md`, `phases_1.1.md`, `roadmap_1.1.md`, `phase_1.2.md`) use three generations of phase numbering that overlap and disagree — I abandoned numeric phase IDs in favour of semantic names mapped to version releases.

| Phase | Version | State |
|-------|---------|-------|
| foundation | v0.1.0 (d67f742) | complete |
| quality | v0.2.0 | complete |
| adoption | v0.1.2 | complete (parallel sprint with quality) |
| reliability | v0.1.2 + v0.2.0 | active — 2 defects open (T-001, T-002) |
| model-currency | v0.3.0 | complete for 5.5, recurring on future OpenAI releases |
| team-integration | not started | — |
| polish | not started | — |

Three gates worth calling out explicitly so future sessions don't re-litigate:
- v0.1.2 and v0.2.0 were **parallel sprints**, not sequential. `adoption` shipped in v0.1.2 while `quality` shipped in v0.2.0. The `phase_1.2.md` numbering restart (Phases 8–12) reflects that — it is not a missing phases 6–7.
- Chunking is **wired** (commit `ce058b3`), even though older docs still speak of "Phase 11: wire up chunking" as pending. Trust git.
- Free-tier auth was **documentation-only** — no code deliverable. The original `provider_mode` CLI adapter plan was cut after a spike. Captured as lesson L-002.

**Tickets (10).** Only forward-looking work. Already-shipped phases carry no tickets — the phase description captures the outcome.

- reliability: T-001 (multi-chunk orphan), T-002 (storage atomicity)
- team-integration: T-003 (github.ts) → T-004 (buildPrReviewPrompt) → T-005 (MCP tool) → T-006 (CLI)
- polish: T-007 (progress spike) → T-010 (progress impl, gated); T-008 (presets built-in) → T-009 (presets custom)

Dependency chains wired in pass 2. T-008 → T-005 is intentional — I want presets to work with `review_pr` from day one rather than retrofit.

**Issues (3).**
- **ISS-001 (high)** — error classifier misidentifies non-MODEL errors. Actively hiding real Codex failures. Filed against `src/codex/client.ts:87-93`. Related to reliability phase.
- **ISS-002 (low)** — `temp/` housekeeping. Addressed in commit `98eedf5`, filing for the record.
- **ISS-003 (low)** — `docs/` is gitignored so handovers and roadmaps don't reach contributors. Decision needed: keep private or start publishing.

**Lessons (4).**
- L-001: Zod v4 nested defaults quirk
- L-002: @openai/codex-sdk already spawns the CLI — do not build an adapter
- L-003: Codex session ID is unknowable pre-flight for new reviews
- L-004: config layer must not import from codex layer

**Autonomous recipe.** Tests-only (`npm test`). No dev server. `prepublishOnly` handles build + typecheck + lint + test at publish time; no need to re-run them per ticket.

## Deferred items

- **Independent Codex review of the seed.** My plan was to send the refined proposal through `review_plan` before creation. Blocked because the bridge's own locally running copy was pre-v0.3.0 and hit ISS-001 on every call. Proceeded without the review — the Explore-agent synthesis of the docs folder was sufficient corroboration.
- **GitHub issue import.** Ran `gh issue list` — zero open issues to import. Noted.
- **Four other local branches** (`docs/improve-presentation`, `feat/standalone-cli`, `feat/wire-chunking`, `fix/user-feedback-v0.1.5`) — left untouched, out of housekeeping scope.

## Next session starting points

1. **Fix ISS-001 first.** It's blocking Codex-backed reviews through the MCP bridge. One-line regex tightening + preserve raw error. Add a regression test with the real "detail" payload shape.
2. **Then T-001 / T-002.** Both are self-contained reliability fixes with clear test shapes. Either order works.
3. **Review the recent commit trail on main** (`git log 7476257..HEAD`) — v0.3.0 + housekeeping landed during this seed session and weren't handed over elsewhere.

## Runtime notes

- npm package `codex-claude-bridge@0.3.0` published today.
- Install command: `claude mcp add codex-bridge -- npx -y codex-claude-bridge@latest`.
- Known users on cached 0.2.0 must `rm -rf ~/.npm/_npx` or re-run the install to pick up the `@latest` pin and gpt-5.5 default.
