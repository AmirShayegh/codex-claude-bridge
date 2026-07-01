# Handover — v1.1.0 published (multi-provider + failover live on npm)

## TL;DR
**`codex-claude-bridge@1.1.0` is published to npm and pushed.** This release ships the Gemini backend + automatic provider failover to users: `npx codex-claude-bridge@latest` now resolves to 1.1.0 (was 1.0.0, Codex-only). The session that built failover, then did the full release (docs → bump → tag → publish). Everything is committed, pushed, and **in sync**; tree clean. Two follow-ups for the user: **rotate the npm token** they pasted in chat, and **restart Claude Code** to swap the running MCP servers onto 1.1.0.

## State
- Branch `main`, HEAD **`a88260b`**, **in sync with origin** (all pushed). Tree clean.
- **npm: `latest = 1.1.0`** (verified: `npm view codex-claude-bridge version` → 1.1.0; `npx -y codex-claude-bridge@latest --version` → 1.1.0).
- Annotated tag **`v1.1.0`** pushed.
- Release commits: `09fa68e` (ISS-008/009) · `f11b014` (T-022 failover) · `260cde8` (track) · `e34a1e5` (docs) · `7ead865` (bump 1.1.0) · `a88260b` (track release).

## What shipped in 1.1.0
- **Gemini backend** (via `agy` CLI) alongside Codex, selectable by `"provider"`. (Built earlier in the multi-provider phase; this is the first release that publishes it.)
- **Automatic provider failover (T-022):** when the configured provider errors with an out-of-usage/unavailable code (`RATE_LIMITED`, `MODEL_ERROR`, `AUTH_ERROR`), the bridge retries the same review on the other provider. On by default; `"fallback": false` opts out. Fresh-reviews-only; serving provider threaded into session provenance; result tagged with `provider`. Design detail is in the prior handover (`2026-06-29-01-provider-failover-and-release-prep.md`).
- **ISS-008** usage-limit → `RATE_LIMITED` (was `UNKNOWN_ERROR`); **ISS-009** fixed the circular "fall back to gpt-5.4" model tip.
- Earlier-this-arc hardening already in: ISS-006 (unknown-model warning), ISS-007 (effort note / STORAGE_ERROR / runSerialized test).
- **Docs (T-021):** README reworked Codex-only → provider-aware (Gemini quick-start, `provider`/`fallback`/`reasoning_effort` config, Gemini model table, a Provider-failover section, neutral architecture diagram); fixed the stale `model`+`session_id` "incompatible" line (now Codex-only) and `CODEX_TIMEOUT`→`REVIEW_TIMEOUT`; package.json description + `gemini`/`google` keywords.

## How the release was cut (for next time)
1. package.json `version` 1.0.0→1.1.0 (sole source of truth; server + CLI read it at runtime — no other literals).
2. Pre-publish gate run manually first (same as `prepublishOnly`): `npm run build && npm run typecheck && npm run lint && npx vitest run` — **651 tests green**.
3. Commit `chore: bump version to 1.1.0`; annotated tag `git tag -a v1.1.0 -m "..."` (matches v0.x; v1.0.0 was lightweight).
4. **Publish:** the user supplied an npm automation token (bypasses 2FA). Used transiently via `npm publish --userconfig <scratchpad/.npmrc-pub>` (token written ONLY to a scratchpad file outside the repo, deleted right after — never committed/echoed to a repo file). `prepublishOnly` re-ran the gate; published `+ codex-claude-bridge@1.1.0`.
5. `git push origin main && git push origin v1.1.0`.

## Verification
- Published 1.1.0 exercised live via `npx -y codex-claude-bridge@latest review-code …` — returned a real review. This run came back **`provider: codex`** (request_changes), i.e. **Codex served it directly — its usage cap appears to have reset since earlier today**, so failover wasn't needed this time. Failover itself was live-proven twice earlier (when Codex was out of usage → fell over to Gemini, `provider: gemini`).
- `npm test` (651, 32 files) / typecheck / lint all green at `a88260b`.

## Action items for the user
1. **Rotate the npm token** `npm_sZGlw1d0…` — it was pasted in chat (now in the transcript). Used once and the scratchpad file was deleted, but it's still valid. Revoke at npmjs.com → Access Tokens.
2. **Restart Claude Code** (this machine AND the quiet-design machine) to swap the running MCP servers onto 1.1.0. MCP servers don't hot-reload (L-013); the `codex-bridge` server is `npx … @latest`, which re-resolves to 1.1.0 on a fresh spawn (already pre-cached on this machine). For failover to actually reach Gemini on a given machine, `agy` must be installed + signed in there.

## Roadmap
- **`failover` phase: complete** — T-022 ✅, ISS-008/009 ✅.
- **`release-1-1` phase: complete** — T-021 ✅, T-023 ✅.
- All prior phases complete. Nothing in progress.

## Still open (untouched, non-blocking)
- Lower-tier review items: **m2** (Codex shared-retry deadline can mask a parse failure as REVIEW_TIMEOUT), **m5** (prompt-injection defense — disputed), **m6 + nitpicks** (move provider-neutral schemas out of `src/codex/`, dead `threadOpts` fallback, unbounded agy stdout buffer, mergePrecommit dedup).
- **Test gaps:** direct unit tests for `deduplicateFindings`/`mergeCodeResults`/`mergePrecommitResults` (only covered behind a chunker mock); populated-table migration; runtime history-schema validation.
- **Dual / cross-review** still unticketed — run BOTH providers and reconcile two verdicts. Distinct from T-022 (single-direction failover). The natural next feature if pursued; would need new tool/schema thought.

## Lessons in play
- **L-013:** MCP servers don't hot-reload a rebuilt dist / a newly published npx version — restart the client to pick it up. Use the CLI (or `npx … @latest`) to verify mid-session.
- **L-012 / L-011:** agy ignores an invalid `--model`; live-validate agy.
- Pattern: detect an `ErrorCode` on a `Result` via `error.startsWith(\`${ErrorCode.X}:\`)` — the code is a string prefix, not a structured field (used by the failover eligibility check).
