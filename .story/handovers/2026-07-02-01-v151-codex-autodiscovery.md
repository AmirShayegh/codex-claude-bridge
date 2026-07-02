# Handover — v1.5.1 shipped: codex binary auto-discovery (ISS-021). Next session: test it.

## TL;DR
Diagnosed and properly fixed "codex not working": macOS XProtect quarantines the `@openai/codex-sdk`'s BUNDLED codex binary (the SDK never uses the PATH one), so fresh installs failed every Codex review. Shipped **v1.5.1** (npm `latest`, tag pushed, GH release) with **auto-discovery**: on PROVIDER_UNAVAILABLE with no explicit override, the backend finds a working system codex (PATH → ~/.local/bin → /opt/homebrew/bin → /usr/local/bin, each `--version`-probed), swaps it in via codexPathOverride, narrates on stderr, retries once. Machine-wide local fix also in place. **The npx cache is warmed with 1.5.1** — the next session's `codex-bridge` MCP spawn runs the new build.

## Commits / release
- `6951339` fix: auto-discover a system codex when the bundled binary cannot run (resolves ISS-021; +21 tests → 807 total; README now documents codex_path + auto-discovery, stale max_file_size removed from example)
- `4e52ceb` chore: bump to 1.5.1 · tag `v1.5.1` · npm dist-tags `{latest: 1.5.1}` · GH release published
- Design notes: recovery is a memoized shared promise (concurrent failing reviews share ONE discovery — review-round finding); a discovery throw resolves to 'not-found' (Result contract holds); explicit codex_path/CODEX_PATH fully disables discovery; no-find appends an "auto-discovery: no working system codex" note to the error.
- Live-verified pre-ship: override-free config in single mode → dead bundled binary → discovered /Users/amirshayegh/.local/bin/codex → retried → codex served the review.

## Machine state (Amir's Mac)
- Repo `.reviewbridge.json`: `{ "codex_path": "/Users/amirshayegh/.local/bin/codex" }` (model pin REMOVED — codex default resolves gpt-5.5; the old gpt-5.4 was a stale local pin, never the codebase default).
- **`~/.reviewbridge.json` (NEW, machine-wide)**: same codex_path — user-level cascade fallback covers every project without its own config. Cascade is first-hit (env RB_CONFIG_PATH → project walk-up → user → defaults), no merging.
- System codex: `/Users/amirshayegh/.local/bin/codex` → standalone installer v0.142.5, notarized, XProtect-safe, accepts gpt-5.5.

## ⚠️ Test-plan gotcha for next session
**An explicit codex_path DISABLES auto-discovery — and BOTH local configs currently pin it.** So MCP calls next session exercise the pin path, not discovery. Test both:
1. **User path (as-configured)**: fresh session → `codex-bridge` MCP tools (published 1.5.1) → run review_code with `deliberate: true` → expect providers ["codex","gemini"], no degraded marker, codex on gpt-5.5. Validates the machine fix end-to-end through MCP.
2. **Auto-discovery (the 1.5.1 feature)**: must bypass the pins. Easiest via CLI: `RB_CONFIG_PATH=<config-without-codex_path> npx -y codex-claude-bridge@latest review-code --diff <file> --json` — expect stderr narration "bundled codex binary is unusable ... using discovered /Users/amirshayegh/.local/bin/codex" then a codex-served result. (The 1.5.1 npx install dir is fresh, so its bundled binary is either absent or awaiting re-quarantine — either way discovery should trigger; if the fresh binary happens to run, the review succeeds without narration, also fine.) For the MCP variant, point the server's env at an override-free config (RB_CONFIG_PATH in the mcp registration) and reconnect.
3. Sanity: with codex_path pinned, stderr must show NO discovery narration (pin short-circuits).

## Open issues (all filed with full context)
- **ISS-018** [low] cwd-dependent reviews.db → guard fails open off-cwd; reviewed fix plan in note N-003 (WAL-sidecar migration caveats!).
- **ISS-020** [low] chunked reviews blind across chunks → false positives (bit us AGAIN this session: both providers claimed `codex` was a const twice; declaration is `let`, outside the diff).
- **ISS-022** [low] MCP server loads config once at spawn; edits silently ignored until reconnect (bit the dogfood session).
- **ISS-023** [low] single-mode results omit `provider` (type says required) — surfaced by the ISS-021 live probe; 2-line fix in withSingleMode + test.

## Context worth keeping
- The review rounds on the ISS-021 diff (deliberate, 2 rounds): 2 real findings accepted+locked (concurrency race, throw containment), 1 nitpick fixed (shadowed `recovery` var), the repeated const-reassignment critical contested (ISS-020 pattern — both providers wrong the same way; agreement matching can't catch same-way-wrong).
- Root cause is upstream: the npm-vendored codex binary lacks the notarization the standalone installer has. Worth reporting to OpenAI eventually.
- Memory file `codex-binary-xprotect.md` updated with both fixes + machine state.