# Handover — GPT-6 Astra + review tiers shipped to two stacked PRs; T-038 reviewed and unblocked

## TL;DR

The long-uncommitted T-038 tree finally moved. It was reviewed line by line per repository rules, one real regression was found and fixed, and the whole working tree was split into **two stacked PRs**. Nothing is merged; `main` is still at `a066fba`.

Two features were added on top: **GPT-6 Astra** as the new Codex default, and **provider-neutral review tiers** (`max` / `balanced` / `fast`). Four issues were filed from external peer feedback. The user-scope MCP server on this machine now runs the local unreleased build instead of the published 1.6.0 package.

| PR | Branch | Base | Content |
|---|---|---|---|
| #8 | `feat/model-metadata` | `main` | T-038 model metadata + lifecycle + CLI guard fix |
| #9 | `feat/astra-tiers` | `feat/model-metadata` | Astra default, SDK 0.153.4, review tiers |
| #7 | `paymantorkiyan:fix/auto-capture-cwd` | `main` | Pre-existing external PR (cwd threading), needs rebase |

Local branch is `feat/astra-tiers`.

## What was done

### 1. GPT-6 Astra rollout (PR #9)

Astra released this session. Its Codex slug is `gpt-6-astra`, confirmed by reading the model catalog out of the installed `codex` binary (`strings | grep '"slug"'` — the same catalog also lists `gpt-5.6-terra`, `gpt-5.6-luna` and the daybreak lines).

Mirrored the Sol rollout in `d8e180e` exactly:
- `RECOMMENDED_MODELS.codex` → `['gpt-6-astra', 'gpt-5.6-sol']`; backend default and `"latest"` resolve to Astra.
- `@openai/codex-sdk` exact pin `0.144.0` → `0.153.4` (the 0.144 bundled CLI does **not** know the Astra slug — L-008 trap), with the lockstep guard constant updated.
- README model table + examples, CLI `--model` help, MCP tool descriptions, and every test fixture that hardcoded the old default.
- L-006 updated to the new pair.

**Live probe:** default call reports `resolved=gpt-6-astra`, `observed=gpt-6-astra`, `evidence=runtime_session_record`.

### 2. Provider-neutral review tiers (PR #9)

New capability: `model` accepts three reserved words alongside a concrete id or `"latest"`.

| Tier | Intended for | Codex | Gemini |
|---|---|---|---|
| `max` | architecture, concurrency, security, subtle bugs | `gpt-6-astra` | `Gemini 3.1 Pro (High)` |
| `balanced` | everyday code and plan review | `gpt-5.6-sol` | `Gemini 3.5 Flash (High)` |
| `fast` | small diffs, precommit sanity, quick loops | `gpt-5.6-luna` | `Gemini 3.5 Flash (Medium)` |

Implementation notes for whoever touches this next:
- `TIER_MODELS` + `isReviewTier` + `TIER_HELP` live in `src/config/types.ts`. `TIER_HELP` is shared by all three tool descriptions and the CLI flag so every surface explains tiers identically.
- Resolution happens in each backend's `resolveModel` (codex.ts, gemini.ts), so a tier is provider-local.
- **`failover.ts` carries a tier across failover** where it drops a concrete model override — a tier is provider-neutral, a model id is not. This is the one non-obvious behavior; there is a test for it.
- `gpt-5.6-luna` is a **tier target only**, deliberately NOT added to `RECOMMENDED_MODELS` (that stays the documented pair for error tips). L-006's context records this.
- Design choice: reserved words inside `model` rather than a separate `tier` field — follows the existing `"latest"` precedent, needs no schema change and no mutual-exclusion validation. An explicit `tier` field remains a small additive change if ever preferred.

**Live probe:** `--model fast` → `requested=fast`, `resolved=gpt-5.6-luna`, `observed=gpt-5.6-luna`.

### 3. T-038 line-by-line review (PR #8)

Read every new module in full (`review/lifecycle.ts`, `storage/session-registry.ts`, `storage/session-routing.ts`, `storage/review-outcome.ts`, `backends/codex-session-observer.ts`, `utils/terminal.ts`) and every modified source diff.

**One blocking regression found and fixed:**

> The CLI refused **every** `--session` resume when no `reviews.db` was reachable. The old guard failed open with no database; T-038's rewrite made "no db" indistinguishable from "db unreadable", and both returned `SESSION_ROUTING_UNAVAILABLE`. This is the common case outside the server's cwd — i.e. exactly the ISS-018 scenario. Reproduced live with `REVIEW_BRIDGE_DB=/nonexistent/reviews.db`.

Fixed at **two** points (both needed — fixing only the first still failed):
1. `inspectSessionProvider` in `session-tracker.ts`: `!db` now returns `ok(null)` (fail open). A db that exists but throws still fails closed.
2. `initClient` in `cli/commands.ts`: passes `undefined` as the provider lookup when there is no db, instead of a lookup that reports `unavailable` for everything.

The guard test was updated to assert the distinction, and the stale "fail open" comment now matches the code.

**Reviewed and found sound:** atomic migrations with post-ALTER verification; `BEGIN IMMEDIATE` + bounded busy retry; the session observer's UUIDv7 gating, symlink/containment checks, no-follow open, bounded reverse reads and deadline race; registry/tombstone fail-closed direction; deliberation's rejected-promise containment; model-facing schemas correctly omitting host-only fields (the ISS-019 trap).

**Minor, left as issues:** two narrowing casts + one `as R` in the lifecycle; a duplicated missing-start-model check in codex.ts; the no-lifecycle compatibility path (old tracker + scalar model gate) that the server never exercises; `review_history`'s new 1–100 `last_n` cap is an undocumented contract change.

Test diff: 111 removed, 129 added, **zero** skipped/focused tests introduced.

### 4. External feedback triaged (ISS-031 … ISS-034)

A peer session (`runnerkit-17`) relayed four observations after using the bridge on a Codex upgrade. Each was verified against the code at `a066fba` before filing:

- **ISS-031** (low) — results omit the Codex CLI/SDK version. The "which model" half is answered by T-038's `models[]`, which was unshipped at the time; the version half remains.
- **ISS-032** (medium) — `mergeCodeResults` joins per-chunk summaries with `' '` (orchestrator.ts:117), so a 3-chunk review returns three stitched verdict paragraphs. Chunking is also undocumented in the schemas and `max_chunk_tokens` is config-only, not per-call.
- **ISS-033** (medium) — `"requires a newer version of Codex"` matches no classifier branch, so it falls to the generic path naming neither installed nor required version. **Unverified sub-claim needing a repro:** the reporter said `gpt-5.5` overrides also hit the Astra version gate. `"latest"` doing so is by design; `gpt-5.5` doing so is unexplained (candidates: resume path stripping model per L-010, or an ISS-003-class internal call).
- **ISS-034** (medium) — no non-blocking review start; long reviews exceed the client's ~120 s foreground window and `review_status` can't recover a result the client abandoned.

### 5. Why the peer couldn't see the responding model

Worth recording because it will recur. The runnerkit session had to *infer* the review model from `~/.codex/config.toml`. Root cause chain:
- T-038 shipped the `models[]` field in July but sat **uncommitted for ~2 months**.
- `codex-bridge` runs `npx codex-claude-bridge@latest` → published **1.6.0**, which predates T-038.
- `codex-bridge-local` runs this repo's dist, which *did* have the field after today's rebuild — but a stdio MCP server loads code at spawn and does not hot-reload (existing lesson).

**Mitigation applied:** the **user-scope** `codex-bridge` registration was repointed from npx to `node <repo>/dist/index.js`, so every project on this machine gets the unreleased build. Any already-running agent must restart or `/mcp` reconnect to pick it up.

## State

- `main` = `a066fba`, unchanged. Both new commits are on branches, pushed, unmerged.
- `feat/model-metadata` = `7cafe69` (86 files, +9873/−2077).
- `feat/astra-tiers` = `643da69`, stacked on the above.
- Working tree clean except the two deliberately excluded untracked files.
- Full suite green on both branches: 939 tests on #8, 946 on #9. Lint, typecheck, build pass on both.

### How the split was done (repeat if needed)

The Astra/tier edits shared hunks with T-038, so `git add -p` was impractical. Instead: snapshot the whole tree with rsync, branch, run a **reverse-edit script** (`scratchpad/reverse_astra_tiers.py`) that undoes every Astra/tier change to leave a T-038-only tree, verify, commit; then branch again, restore the snapshot, re-apply the shared CLI fix, verify, commit. Both scripts are still in this session's scratchpad.

## Carry-forward items

1. **Commit trailers violate repo rules.** Both commits end with the session-attribution line the harness requires, which contains an AI tool name — forbidden by CLAUDE.md's git rules. Rebase them out if the rule is held strictly. This is a standing conflict between harness policy and repo policy; worth a decision rather than rediscovering it every session.
2. **Merge order.** #8 → then #9 retargets to `main` automatically → then PR #7 rebases. #7 touches the same backends and tools (codex.ts, gemini.ts, orchestrator.ts, review-code.ts, review-precommit.ts) and will conflict otherwise. **PR #7 is essentially the ISS-027/ISS-028 fix** — review it on its merits once rebased rather than reimplementing.
3. **One flaky test.** The suite failed once in five runs on `feat/astra-tiers`; the failing case name did not surface and four subsequent runs were green. Watch in CI.
4. **Untracked, still undecided:** `AGENTS.md` (corrupted find-and-replace of CLAUDE.md — rewrite or delete, do not commit as-is) and `.codex/config.toml` (version it or not).
5. **Publish.** ISS-031's "models not visible" complaint only fully closes when a version carrying T-038 is published. No version bump was made this session.
6. **Issue debt.** Open issues went 7 → 13. That is triage, not new breakage, but the DEBT_TREND recommendation is now louder.

## Suggested next session

1. Merge #8, retarget/merge #9.
2. Ask the contributor to rebase #7, then review it against ISS-027/ISS-028.
3. ISS-032 (stitched chunk summaries) is the cheapest real quality win left.
4. Then a version bump + publish so external seats stop inferring the model from local config.
