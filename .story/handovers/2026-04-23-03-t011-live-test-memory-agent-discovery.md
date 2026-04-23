# Session Handover: T-011 live test surfaces Codex memory-agent MODEL_ERROR leak

**Date:** 2026-04-23
**Mode:** Interactive — smoke-test the just-shipped MCP feature against its own PR, investigate surprise
**Result:** T-011 works as designed. New misclassification bug discovered (cousin of ISS-001). Two minor Codex review findings on PR #6 still open.

## What happened

Goal was simple: use the published `codex-claude-bridge@0.3.3` to ask Codex to review PR #6 (T-011 itself). Two interesting outcomes.

### 1. T-011 validated end-to-end under real failure conditions

First `review_code` call (no `model` param) hit `MODEL_ERROR`. Second call with `model: "gpt-5.4"` (per-call override) succeeded on first try — **no MCP restart, no config edit, no retry loop.** This is the exact scenario T-011's description cited as motivation. The feature composed with the v0.3.2 error tip as designed: tip told Claude Code what to do, override let it do it immediately.

Codex review verdict on the PR diff: **request_changes**, 2 minor findings (see below).

Session ID for the successful review: `019dbc63-6830-70c2-8e4c-8e5eadfb6612`.

### 2. Surprise: MODEL_ERROR surfaces misleading model name

The failing first call returned: `Model "gpt-5.4" is not supported` in the classifier tip, but the raw error body (preserved by the ISS-001 fix in `2f17aa2`) said: `{"detail":"The 'gpt-5.1-codex-mini' model is not supported when using Codex with a ChatGPT account."}`.

Neither our built-in default (`gpt-5.5`), nor the project `.reviewbridge.json` override (`gpt-5.4`), nor `~/.codex/config.toml` (`gpt-5.4`) references `gpt-5.1-codex-mini`. So where did it come from?

**Answer:** It's hardcoded inside the Codex Rust binary at `codex_core::memories::phase1` — the Codex CLI's internal **"memory writing agent"** subsystem. Verified by `strings` on the binary at `/Users/amirshayegh/.nvm/versions/node/v22.18.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex`:

```
gpt-5.1-codex-mini
## Memory Writing Agent: Phase 1 (Single Rollout)
codex_core::memories::phase1::job
codex_core::memories::phase2::agent
```

**Mechanism:** When you run `codex exec` through the SDK, the binary fires a background call on `gpt-5.1-codex-mini` to populate its memory subsystem. ChatGPT-tier accounts don't have access to that model variant, so the background call 500s and surfaces to us as if it were the main call's model error.

**Bug implied:** Our MODEL_ERROR classifier stamps the tip with `resolvedModel` (our configured model, e.g. `gpt-5.4`). When the actual failing call came from a Codex internal subsystem on a *different* model, the tip is wrong — "fall back to gpt-5.4" is terrible advice when you're already on gpt-5.4.

This is a shape-cousin of ISS-001: classifier confidently labels with the wrong extracted name. The tightened regex from `2f17aa2` extracts model names cleanly from matching spans but only uses them for matching — not for the error-context passed into the tip.

## Decisions / deferred items

- **Did not file the memory-agent issue.** User asked for a handover before deciding. Two possible fixes outlined:
  - Extract the quoted model from the raw error (when a `model 'X' not (supported|found|exist)` span matches) and prefer *that* over `resolvedModel` in the tip.
  - Detect the `codex-mini` / memory-agent pattern specifically and emit a different hint ("this is a Codex memory-agent background call, not your review — consider `memory = false` in ~/.codex/config.toml or using OPENAI_API_KEY for full-model access").
  - Either fix should include a regression test with the `{"detail":"The 'gpt-5.1-codex-mini' model is not supported ..."}` raw body as fixture.
- **Did not file PR #6 review findings as issues.** Both are minor and already captured in the active codex session; next session can address directly in a small follow-up PR.

## Open threads for next session

### A. File + fix misleading MODEL_ERROR tip (memory-agent)
Per-session priority: high-ish. Every ChatGPT-tier user hitting the memory-agent failure will see a wrong tip, which defeats the v0.3.2 rollout story. Not a regression — this has always been wrong, just invisible until the raw-error preservation made it diagnosable.

### B. PR #6 review findings (from `019dbc63-...`)
1. **Trim asymmetry (api-design, minor).** MCP schemas use `z.string().min(1)` with no trim; CLI uses `opts.model?.trim() || undefined`. Whitespace-only `"   "` means "use default" via CLI but forwards as an invalid model via MCP. Fix: `z.string().trim().min(1).optional()` in all three `src/tools/review-*.ts` schemas (same three-file change pattern as the `model` field addition itself).
2. **Test coverage gaps (test-coverage, minor).** No CLI tests for `--model` trim/passthrough on any of the three commands. No MCP handler tests for the early `session_id + model` INVALID_INPUT guard on `review_plan` / `review_code` — client-layer test exists and there's one precommit handler test, but the siblings are uncovered. A copy-paste error in the handler-layer guard would slip through.

### C. Previously queued
- T-001 (multi-chunk session orphaning on partial failure) — still open, still next in the reliability phase.
- T-002 (atomicity for saveReview + markSessionCompleted) — still open.
- ISS-002 (temp/ housekeeping, low) — unaddressed.

## Runtime notes

- MCP is running via `npx -y codex-claude-bridge@latest` resolving to **0.3.3** (verified via `claude mcp get codex-bridge`). No changes to the running server during this session.
- Codex CLI: `codex-cli 0.113.0` at `/Users/amirshayegh/.nvm/versions/node/v22.18.0/bin/codex`.
- Storybloq CLI has a 1.1.7 update available; user not prompted to upgrade (not blocking).
- No code changes, no commits, no branch activity this session. Snapshot captured at `.story/snapshots/2026-04-23T23-19-12-555.json`.

## Worth capturing as a lesson later

The Codex Rust binary ships hardcoded defaults for its memory-writing subsystem (`gpt-5.1-codex-mini` in phase1/phase2). Background calls on ChatGPT-tier accounts can fail independently of the main thread model and leak through as MODEL_ERROR with misleading model names. The fix for ISS-001 (preserving raw error in the MODEL_ERROR message) was the only reason this was diagnosable — a reinforcement of that pattern's value, not a refutation of it. Consider creating a lesson once the fix for issue A lands, so the rationale is captured with the evidence.
