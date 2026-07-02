# Handover — v1.5.1 verified live: all 3 test recipes pass (pin path, auto-discovery, pin sanity)

## TL;DR
Pure verification session, zero code changes. Ran the 3-part test plan from the previous handover (`2026-07-02-01-v151-codex-autodiscovery.md`) against the **published** `codex-claude-bridge@1.5.1`. **All three passed.** The ISS-021 auto-discovery fix works in the wild: the fresh npx install's bundled codex binary was already quarantined again by XProtect, discovery found `/Users/amirshayegh/.local/bin/codex`, retried, and codex served the review. Tree is clean on `main` (`7e15de7`), nothing committed this session.

## Test results (probe: small planted-bug diff — SQL injection + `=` vs `===`)

1. **MCP path, pinned config, `deliberate: true`** ✅ — Published 1.5.1 server via the `codex-bridge` MCP tools. Result: `review_mode: deliberate`, providers `["codex","gemini"]`, no degraded marker. Both planted bugs caught by BOTH providers and merged into `agreed[]` with `divergent: []` — a live validation of the T-029 semantic agreement matcher on top of the machine fix. Verdicts split (codex `request_changes`, gemini `reject` → agreement `conflict`); that's honest surfacing, not a defect.
2. **Auto-discovery (the 1.5.1 feature)** ✅ — `RB_CONFIG_PATH=<config-without-codex_path> npx -y codex-claude-bridge@latest review-code --diff … --json` from a non-repo cwd. stderr showed exactly the designed narration: "bundled codex binary is unusable (macOS XProtect may have quarantined it); using discovered /Users/amirshayegh/.local/bin/codex…". Confirms the fresh npx install's bundled binary is re-quarantined on this machine — discovery is load-bearing, not theoretical. Review served by codex on gpt-5.5, both bugs found, exit 0.
3. **Pin sanity** ✅ — Same CLI call without RB_CONFIG_PATH from a directory with no project config: cascade picked `~/.reviewbridge.json` (stderr: "config source: user"), NO discovery narration (pin short-circuits), codex served the review directly.

## New observation on ISS-023
The CLI runs under the default two-provider config came back `review_mode: failover` **with** the `provider` field present. So ISS-023 (single-mode results omit `provider`) is scoped strictly to true single-provider configs — it does not affect the default two-provider setup. Still worth the ~2-line fix in withSingleMode + test, but low urgency confirmed.

## Machine state (unchanged, reconfirmed)
- Repo + `~/.reviewbridge.json` both pin `codex_path: /Users/amirshayegh/.local/bin/codex`; default model resolves gpt-5.5.
- npm `latest` = 1.5.1; npx cache warm.
- XProtect actively re-quarantines fresh bundled binaries — every new npx install dir will hit discovery unless pinned. Root cause remains upstream (npm-vendored codex binary lacks notarization); still worth reporting to OpenAI eventually.

## What's next
- **ISS-023** [low] — quick win: stamp `provider` in withSingleMode + test (~2 lines). Scope now confirmed narrow (single-provider configs only).
- **T-003** — Fetch PR diff + metadata via gh CLI (`src/utils/github.ts`); next ticket in the team-integration phase (review_pr tool).
- **ISS-018 / ISS-020 / ISS-022** [low] remain open with full context in prior handovers (ISS-018 fix plan reviewed in note N-003 — mind the WAL-sidecar migration caveats).
- No release needed; nothing changed since v1.5.1.