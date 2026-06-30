# Handover — Provider failover shipped + 1.1.0 release prepped

## TL;DR
Long session, three arcs: (1) full **probe-loop** verification of the Gemini backend → fixed ISS-006/007 (committed + **pushed**, at `cf66932`); (2) discovered Codex is **out of usage** → found and fixed two error-classification bugs (ISS-008, ISS-009); (3) designed + built **automatic provider failover** (T-022) — when the configured provider is out of usage/unavailable, the bridge transparently retries the review on the other provider. Failover is **live-verified end-to-end** (codex out of usage → falls over to gemini → real verdict). **651 tests green, typecheck + lint clean.** The 3 failover commits are on `main` but **NOT pushed**. Next: push, then do the README/metadata docs (T-021) and cut/publish v1.1.0 (T-023).

## State / branch
- Branch `main`, HEAD **`260cde8`**. `origin/main` is at **`cf66932`** → **3 unpushed commits**:
  - `09fa68e` fix: classify usage-limit errors as RATE_LIMITED + fix the model tip (ISS-008, ISS-009)
  - `f11b014` feat: auto-fallback to the other review provider when one is out of usage (T-022)
  - `260cde8` chore: track failover feature and release tickets
- Working tree **clean**. `dist` rebuilt at `260cde8`.
- Earlier this session (already pushed in `cf66932`): the probe-loop hardening — ISS-006 (silent model substitution → non-blocking warning), ISS-007 (m3 effort note, m4 STORAGE_ERROR, runSerialized race test), lessons L-011 reinforced + L-012, and `docs/hardening-probes.md` (gitignored, local only).

## Environment facts (important context)
- **Codex is out of usage on this account.** `gpt-5.5` → "You've hit your usage limit ... try again at **Jul 28th, 2026**"; `gpt-5.4` → "not supported when using Codex with a ChatGPT account". Today is 2026-06-29. So any codex review fails right now — which is exactly what makes failover demoable.
- **Gemini (agy 1.0.13) works** end-to-end ($0, Google AI Pro).
- The local `.reviewbridge.json` pins `{"model":"gpt-5.4"}` (gitignored, this machine only) — stale, but failover now covers it.

## What shipped this session (T-022 + ISS-008 + ISS-009)

### ISS-008 — usage-limit → RATE_LIMITED (`09fa68e`)
`classifyError` in `src/backends/codex.ts` rate-limit branch now also matches `usage limit` / `hit your usage limit` / `quota` (the ChatGPT-tier cap isn't a 429). Without this, the real error was `UNKNOWN_ERROR` and wouldn't trigger failover. Prerequisite for failover.

### ISS-009 — circular model tip (`09fa68e`)
The MODEL_ERROR tip hardcoded "fall back to gpt-5.4", so a failing gpt-5.4 was told to fall back to gpt-5.4. Now recommends a model *other* than the one that failed (`altModel = modelName === 'gpt-5.5' ? 'gpt-5.4' : 'gpt-5.5'`) and points at `"provider": "gemini"`.

### T-022 — auto-fallback failover backend (`f11b014`)
**Decisions (locked with user):** auto / zero-config, on by default; opt-out `"fallback": false`. Triggers: `RATE_LIMITED`, `MODEL_ERROR`, `AUTH_ERROR` (never `INVALID_INPUT` / `RESPONSE_PARSE_ERROR` / `REVIEW_TIMEOUT`).

**Design — decorator at the `createBackend` seam:**
- New `src/backends/failover.ts` → `createFailoverBackend(primary, secondary)`. Runs primary; on a failover-eligible error (`isFailoverEligible` tests the `${ErrorCode}:` string prefix — there is no `code` field on `Result`), narrates on stderr and retries the same input on secondary; both fail → combined error led by the primary's. `tag()` stamps the serving provider on success.
- `src/backends/index.ts` — extracted `createLeafBackend` (the old switch); `createBackend` builds the primary leaf and, when `config.fallback`, builds the secondary leaf **directly** (no recursion) with `{ ...config, provider: <other>, model: undefined }` (clearing the model pin so a codex model isn't forced on gemini), then wraps in the failover composite. Composite presents the **primary's** `provider` + `allowsModelOverrideOnResume`.
- **Fresh-only:** a resumed session lives in the primary's conversation store, so on `session_id` present the composite delegates to the primary, no failover.
- **Provenance:** optional `provider` added to the 3 result schemas (`src/codex/types.ts`); omitted from the orchestrator response schemas so the model can't inject it; `recordSuccess(sessionId, review, servingProvider?)` (`src/storage/session-tracker.ts`) tags a fresh session with the actual serving provider; the 3 tools pass `result.data.provider`. Keeps the cross-provider resume guard correct.

**Live verification (fresh dist, CLI):**
- `{"provider":"codex"}` (or the real `gpt-5.4` config) → `codex unavailable (MODEL_ERROR|RATE_LIMITED); falling back to gemini` → Gemini verdict, `provider: gemini`.
- `{"provider":"codex","fallback":false}` → bare `RATE_LIMITED`, no failover.

## Gotcha discovered (now L-013)
**The running `codex-bridge-local` MCP server is serving STALE code.** MCP servers load their code once at spawn (session start) and do NOT hot-reload on `dist` rebuild. Proof: `mcp__codex-bridge-local__review_code` returned the *old* circular gpt-5.4 tip and didn't fail over, while the CLI on the same fresh dist failed over fine. **To exercise failover through the MCP tool, restart Claude Code** (re-spawns the server from current dist) or reconnect via `/mcp`. Use the CLI to verify mid-session.

## Verify before resuming
`npm test` (651, 32 files) · `npm run typecheck` · `npm run lint` — all green at `260cde8`. `npm run build` succeeds. agy 1.0.13 installed + signed in. Codex still out of usage (until at least Jul 28).

## Next steps (in order)
1. **Push** the 3 commits (`git push origin main`). npm auth ok (owner `ashayegh`).
2. **T-021** (`release-1-1` phase) — README + package.json multi-provider docs. Audit done this session: README is 100% Codex; must add a Gemini Quick Start, document `provider` + Gemini models, fix the `model`/`session_id` "Incompatible" line (now Codex-only — Gemini allows override on resume), fix stale `CODEX_TIMEOUT` → `REVIEW_TIMEOUT`, neutralize package.json description + add "gemini" keyword. **Now also document failover** (`"fallback"`, the auto behavior, data-egress note) — it's part of 1.1.0. **OPEN QUESTION:** the repo never records an `agy` install command — confirm the canonical install reference with the user before writing that section (don't fabricate).
3. **T-023** (blocked by T-021) — cut v1.1.0: bump package.json `1.0.0`→`1.1.0`, commit, annotated tag `git tag -a v1.1.0 -m "v1.1.0"` (v0.x were annotated; v1.0.0 was lightweight), push, `npm publish` (prepublishOnly runs build+typecheck+lint+test; unscoped → public; 2FA may prompt for an OTP). No test asserts a literal version (server.test.ts reads it dynamically), so the bump is safe.

## Roadmap
- `failover` phase: **T-022 ✅ complete**, ISS-008/009 ✅ resolved.
- `release-1-1` phase: **T-021 open** → **T-023 open** (blocked by T-021).
- Failover plan file (for reference): `~/.claude/plans/lets-do-all-cozy-feather.md`.
- Still open from the broader review (untouched): m2 (timeout semantics), m5 (prompt-injection, disputed), m6 + nitpicks, merge-helper unit-test gaps; and dual/cross-review (run both providers and compare) is still unticketed — note T-022 is single-direction failover, NOT simultaneous dual-review.

## Lessons added/used
- **L-013 (new):** MCP servers don't hot-reload a rebuilt dist — restart to pick up changes.
- **L-012 / L-011:** agy ignores an invalid `--model`; live-validate agy (from the earlier probe-loop arc).
- Pattern worth remembering: detect an `ErrorCode` from a `Result` via `error.startsWith(\`${ErrorCode.X}:\`)` — the code is only a string prefix, there's no structured field.
