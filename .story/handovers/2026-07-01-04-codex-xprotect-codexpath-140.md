## Session handover — codex binary XProtect trap diagnosed + fixed; v1.4.0 shipped

### State at handoff
- **HEAD `d5b0f28` = origin/main** (all pushed). Working tree clean (CLAUDE.md is gitignored).
- **npm `codex-claude-bridge@1.4.0` is live** (`npm view … version` → 1.4.0).
- **705 tests** pass · typecheck · lint all green.
- No active autonomous session.

### Headline: why the deliberation feature was failing (a machine/environment problem, not our code)
The user tried to use the bridge's deliberation on the AgentKit_UI project and it repeatedly died — first "codex process killed (SIGKILL)", then ENOENT. After investigation the root cause is definitive and was caught live:

**macOS XProtect is flagging the `codex` binary bundled by `@openai/codex-sdk` (v0.128.0, the ~200MB signed Mach-O in `node_modules/@openai/codex-darwin-arm64/vendor/...`) as malware and moving it to Trash.** The user's screenshot showed the "Malware Blocked and Moved to Trash: 'codex'" popup. I watched the npx copy of the binary get emptied mid-session (a `cp` failed because XProtect deleted the source between two shell commands). This deleted the binary from the local repo, the global `@openai/codex`, and the npx cache → every Codex review failed with ENOENT (already trashed) or SIGKILL (killed on spawn before removal).

It is a **false positive**: the user's standalone-installer codex at `~/.local/bin/codex` (v0.142.5, a different build macOS trusts) runs fine, and `agy`/Gemini is completely unaffected.

**Earlier wrong guesses (retracted):** it was NOT payload size, NOT OOM/memory pressure, and NOT a transient Gatekeeper first-launch. It's XProtect actively deleting the specific 0.128.0 vendored binary.

### What v1.4.0 shipped (two commits + bump, all pushed)
- `7042902` **feat: codex_path / CODEX_PATH override.** New `codex_path` config option (env fallback `CODEX_PATH`) passed to the SDK as `codexPathOverride`, so the bridge can spawn a working system codex instead of the trashed vendored one. **Verified live**: a real Codex review ran through the bridge (verdict `revise`, 4 findings) via `~/.local/bin/codex`. Codex-provider only; unset → the SDK's bundled binary unchanged.
- `853fddb` **fix: classify a dead codex binary + fail over.** A missing/killed/quarantined binary used to surface as an unclassified `UNKNOWN_ERROR`, which is NOT failover-eligible → it hard-failed instead of degrading to the working Gemini. Added a new `ErrorCode.PROVIDER_UNAVAILABLE` (matches ENOENT / "spawn codex" / "unable to locate codex" / SIGKILL / "was killed" / "killed with signal") with an actionable message, and made that code failover-eligible. Now a trashed Codex auto-degrades to Gemini under failover/deliberation.
- `d5b0f28` chore: bump to 1.4.0.

### How to actually run Codex on this machine now
In the target project's `.reviewbridge.json`:
```json
{ "provider": "codex", "codex_path": "/Users/amirshayegh/.local/bin/codex" }
```
Then **restart Claude Code** so the `codex-bridge-local` MCP server reloads the rebuilt code (MCP doesn't hot-reload, L-013). After that, `review_plan`/`review_code` run Codex normally; set `"mode": "deliberate-deep"` for real two-model deliberation (Codex + Gemini). Without the override, a trashed Codex now degrades to Gemini automatically instead of hard-failing.

Memory saved: `codex-binary-xprotect.md` (indexed in MEMORY.md) captures the trap + the codex_path workaround for future sessions. Also updated the stale "config must not import codex layer" note → "review layer" (post-m6 reorg).

### Still open
1. **Per-call deliberation toggle (finding #3) — NOT done.** Deliberation is still config-mode-only; there's no `deliberate` param on the tools and no field in results telling the caller which mode ran. This is why "use the deliberation feature" in a fresh project silently ran a single-provider review (default is failover). Worth adding a per-call toggle + surfacing the active mode/providers in every result.
2. **XProtect may re-trash the binary** on any reinstall — `codex_path` pointing at the standalone `~/.local/bin/codex` is the durable workaround. The real upstream fix is OpenAI re-notarizing / Apple correcting the XProtect definition (a macOS update may fix it). Don't fight XProtect by force-running the quarantined binary.
3. **Rotate the npm token** — used across 1.3.0/1.3.1/1.4.0 publishes this session run; hygiene.
4. **LLM-eval idea (discussed, not built):** the user asked how to *measure* whether deliberation beats a single model. Sketched a plan — planted-bug / git-history golden set, precision/recall/F1 per config (single vs deliberate vs deliberate-deep), cross-review adjudication accuracy vs hand labels, bootstrap CIs, and watch out for LLM-judge self-preference (Codex judging Gemini and vice-versa). Offered to build an eval harness using the CLI + review history; not started.
5. **Roadmap remainder:** Team Integration (review_pr via `gh`), Polish (presets + MCP progress notifications), 4 open issues to triage.
