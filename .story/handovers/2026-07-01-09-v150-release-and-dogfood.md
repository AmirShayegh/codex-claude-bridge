# Handover — v1.5.0 released (Deliberation Hardening phase + review + dogfood)

This continues the autonomous-session handover (`2026-07-01-08-auto-session.md`), which covers the 7-ticket implementation in detail. This one covers everything AFTER that: the post-phase review, live dogfooding, and the release.

## TL;DR
The Hardening phase (7 tickets) is implemented, reviewed, dogfooded live against both providers, and **released as `codex-claude-bridge@1.5.0`** (npm `latest` + GitHub release + pushed to `origin/main`). Gate green throughout: 786 tests. One open issue remains (ISS-018) plus a new one filed during review (ISS-020).

## Release (v1.5.0)
- Version bump 1.4.0 → **1.5.0** (minor: backward-compatible features + fixes) via `npm version minor` — kept package.json, package-lock.json, commit, and tag `v1.5.0` in sync.
- **npm**: published as `latest` (verified `dist-tags.latest = 1.5.0`). `prepublishOnly` re-ran build+typecheck+lint+test clean before publish.
- **git**: `origin/main` at `71e33ac` (was `0f48d92`), tag `v1.5.0` pushed.
- **GitHub release**: https://github.com/AmirShayegh/codex-claude-bridge/releases/tag/v1.5.0
- WHY it mattered: installs run `npx -y codex-claude-bridge@latest`, so users auto-resolve to 1.5.0. The ISS-019 fix is now in the wild — live Codex structured reviews that were silently degrading to Gemini on 1.4.0 now actually run on Codex.

## Post-phase review (full prod diff, 1,664 lines)
Ran the whole phase diff through the published bridge. Verdict request_changes, 10 findings — **all 10 verified as false positives or documented design choices** (checked each against the code). Examples: "sliceDiffToFiles called with empty set" (the guard is line 1 of the function), "providers may be undefined" (required field on the ReviewBackend interface), "config needs optional chaining" (it's the Zod-validated type). None blocked release.
- **Filed ISS-020 [low]**: the root cause of most false positives is that chunked reviews are BLIND across chunks — a call site and its implementation (or an interface and its implementor) land in different chunks, so the reviewer asserts cross-file claims it can't verify. Candidate mitigations noted in the issue (per-chunk manifest of other chunks' signatures; mark cross-file claims needs-verification; post-merge downgrade pass). Agreement matching can't fix this — both providers are wrong the same way.

## Live dogfooding (dist @ HEAD, both providers live)
Verified each feature end-to-end via the real CLI:
- **T-031 precommit auto_diff**: `--no-auto-diff` and default both return correct structured errors, no provider spawned.
- **T-027 cross-provider guard**: resuming a gemini-owned session (written earlier by the *published* 1.4.0 server) under a codex-only config was rejected with PROVIDER_MISMATCH — ownership survives across product versions sharing one reviews.db.
- **T-028 per-call --deliberate**: `review_mode: deliberate`, both providers ran, mixed agreement, both verdicts surfaced.
- **T-029/T-030 deliberate-deep**: on the planted-bug diff, `agreed[]` = 2 (SQL injection + assignment bug — was structurally impossible pre-ISS-013-fix), every divergent finding carried the other provider's adjudication (confirmed/unsure with honest reasons), no duplicates, no cross_review_failures.
- The dogfood subject was a REAL draft ISS-018 fix plan; deliberation caught substantive problems including a CRITICAL one (a naive file-copy migration loses committed transactions in the WAL sidecar). Saved as **note N-003**.

## Current state
- Branch `main` = `71e33ac`, clean, pushed. Tag `v1.5.0`. npm `latest` = 1.5.0.
- All 786 tests green. Codex has usage headroom again (was rate-limited most of the session).
- Probe kit at `scratchpad/probe-deliberation/` (payment.js + probe.diff + configs) per note N-001 — reusable.

## What's next
- **ISS-018** [low, OPEN] — CLI cross-provider guard is cwd-dependent (relative reviews.db). Reviewed fix plan + findings in **N-003**: use a stable per-user data dir, but MUST handle WAL sidecars in migration (sqlite backup/VACUUM INTO, not file copy), mkdir -p the parent, cover win32, and decide global-vs-project-scoped db (lean project-keyed subdir). Good next ticket.
- **ISS-020** [low, OPEN] — chunked-review cross-chunk blindness (see above).
- **Lesson L-014** captured: model-facing response schemas must have every property `required` (recursively) for OpenAI structured outputs; the SDK-mock test boundary hides this — verify schema changes with a live Codex probe.
- Consider whether ISS-020's false-positive rate warrants prioritizing a cross-chunk context fix before relying on the bridge for large-diff reviews.