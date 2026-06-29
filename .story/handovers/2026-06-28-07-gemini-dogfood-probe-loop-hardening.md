# Handover — Gemini backend: dogfood + full probe-loop + hardening fixes

## TL;DR
Dogfooded the shipped Gemini (agy) review backend, then ran a complete **probe-loop** verification of it against **real production paths** (built CLI + live agy 1.0.13 + real MCP-server-over-stdio + real SQLite). 10 probes, **9 clean + 1 finding (F1)**. Fixed F1 plus three lower-tier items (m3/m4/runSerialized race). **Suite 636 green, typecheck + lint clean.** Everything is **uncommitted in the working tree** — nothing committed this session (awaiting go-ahead). HEAD is still `ad552e6`.

## What we did

### 1. Dogfood (it works, and it's sharp)
Ran the Gemini backend end-to-end via the built CLI with a temp `{"provider":"gemini","model":"latest"}` config (`--config`, so the project's codex config was untouched).
- `latest` resolved live to `Gemini 3.5 Flash (Medium)`; clean code → `approve`, a planted-bug diff → `reject` with 5 accurate findings (SQLi, div-by-zero, hardcoded secret, null deref, password leak) + file/line/suggestions. ~11–15s. Real agy conversation UUIDs as `session_id`.

### 2. Probe-loop (probe → verify → discover → fix → lock)
Verified on **actual outputs**, never exit codes: conversation-db byte growth, SQLite rows, parsed JSON, stderr.
- **P3 resume continuity:** resume appended **28 KB to the same `conversations/<id>.db`** — byte-level proof agy actually continued the conversation (the returned id is short-circuited in code, so id-match alone proves nothing).
- **P4/P10 via real MCP-over-stdio** (gemini server + codex server sharing one SQLite DB): provenance row `provider='gemini'`; the **m1 resume-first persist fix** confirmed (invented session_id went through preflight/`activateSession` and is tagged gemini, not NULL); cross-provider resume → `PROVIDER_MISMATCH`; M1 tool gate (session_id+model) → `INVALID_INPUT`. Harness saved at `scratchpad/mcp-probe.mjs`.
- **P6 C1 EPIPE:** 20 MB stdin write vs 1 s abort → structured `REVIEW_TIMEOUT`, no uncaught `write EPIPE`/crash.
- **P7 empty diff:** instant synthetic approve, zero agy calls. **P8 chunking:** 3 chunks, worst-verdict merge, planted bug found, model resolved **once** per review.

### 3. Finding F1 — silent model substitution (→ ISS-006, resolved in tree)
`agy --print --model <bogus>` **exits 0 and silently runs a fallback** — the bridge returned a full successful review on `FakeModel-9000` with no error/warning. So `classifyAgyError`'s `MODEL_ERROR` branch is **unreachable** for the common typo case, and `gemini.test.ts` asserted it with a **hand-invented** stderr string real agy never emits (classic mock-vs-reality gap; reinforces L-011). Undermines T-019's "guarantee the model."
- **Fix (chosen: stderr warning, not blocking — respects L-006):** `resolveModel` now validates an explicit pin **outside `RECOMMENDED_MODELS.gemini`** against `agy models` and warns on a miss, still forwarding the model. Recommended pins (incl. default) skip the query → no latency cost or test churn for the common case. New exports: `parseAgyModels`, `warnIfUnknownModel`. Live-verified.

### 4. Three more hardening items (→ ISS-007, resolved in tree)
- **m3 reasoning_effort:** gemini carries effort in the model name, so `config.reasoning_effort` (codex applies it) was silently dropped. `createGeminiBackend` now emits a one-time startup note when it's non-default; `medium` stays quiet. Live-verified.
- **m4 cache-miss code:** a parsed-fine review whose conversation-id cache was unreadable returned `RESPONSE_PARSE_ERROR` (implies "retry the model"); now `STORAGE_ERROR`.
- **runSerialized race test gap:** added an integration test (mutates the id-cache per run via an `onEmit` mock hook) asserting concurrent fresh reviews capture **distinct, correctly-paired** ids. **Verified it bites:** with serialization bypassed it fails deterministically (both capture `race-id-B`), passes when restored.

## Key files / facts for next session
- All code changes are in **`src/backends/gemini.ts` (+66)** and **`src/backends/gemini.test.ts` (+144)**. 11 new/updated tests.
- **Architecture reminder:** the **CLI path does NOT use the DB/SessionTracker** — session tracking, provider provenance, the cross-provider guard, and the M1 tool gate live **only in the MCP tool path** (`src/tools/*` + `storage/`). DB path = `process.env.REVIEW_BRIDGE_DB ?? 'reviews.db'` (relative to the server's cwd). To probe those, drive the real MCP server over stdio with a shared `REVIEW_BRIDGE_DB`.
- `resolveModel` runs **once per review** (not per chunk); `latest`→`agy models`; explicit recommended pin→forwarded; non-recommended pin→validated+warned.
- `docs/hardening-probes.md` holds the full live-probe checklist (P1–P10) + findings F1–F4 with repro commands. **NB: `docs/` is gitignored** — local-only; the tracked record is `.story/` (ISS-006, ISS-007, L-012).

## State / next steps
- **Branch `main`, HEAD `ad552e6`, NOT pushed, release still 1.0.0.** Working tree dirty and **uncommitted**:
  - `M src/backends/gemini.ts`, `M src/backends/gemini.test.ts` (the fixes + tests)
  - `M .story/lessons/L-011.json` (reinforced), `?? .story/issues/ISS-006.json`, `?? .story/issues/ISS-007.json`, `?? .story/lessons/L-012.json`
- **Immediate next step:** commit the gemini fixes. Per repo rules: **read the full diff line-by-line first**, **no AI tool names / no co-author tags**, describe what/why. Reasonable split: one commit for ISS-006 (model-validation warning) + one for ISS-007 (m3 note + m4 code + race test), or a single hardening commit. Then consider rebuild so `codex-bridge-local` MCP serves it.
- ISS-006 and ISS-007 are marked **resolved**, but the resolving code is only in the working tree — not committed.

## Still open (lower-tier, from the multi-provider review — untouched this session)
- **m2 timeout semantics:** Codex's shared retry deadline can mask a parse failure as `REVIEW_TIMEOUT`; Gemini grants a fresh timeout per attempt (~2× budget). Semantics choice (per-attempt vs total-budget).
- **m5 (disputed):** prompt-injection defense-in-depth (review-only directive) — contested by a skeptic.
- **m6 + nitpicks:** move provider-neutral schemas out of `src/codex/`; dead `threadOpts` fallback; unbounded agy stdout buffer; `mergePrecommitResults` dedup.
- **Test gaps:** direct unit tests for `deduplicateFindings`/`mergeCodeResults`/`mergePrecommitResults` (currently only behind a chunker mock); populated-table migration; runtime history-schema validation.
- **Dual/cross-review** (run both providers, reconcile two verdicts) — still unticketed; the natural next phase if pursued.

## Verify before resuming
`npm test` (636, 31 files) · `npm run typecheck` · `npm run lint` — all green with the working-tree changes applied. `npm run build` succeeds. Live agy 1.0.13 is installed and signed in.

## Lessons
- **L-012 (new):** agy silently ignores an invalid `--model` in `--print` mode — never assume it errors; validate against `agy models` yourself.
- **L-011 reinforced:** live-validate agy; mocked-spawn tests can't catch its real behavior (F1 is the proof).
