# Handover: peer field reports fixed, probe-loop rounds run

**Branch:** `fix/peer-reports-sep16` (7 commits ahead of main, not pushed, no PR yet). `.codex/`, `AGENTS.md`, and `.story/issues/ISS-042..049.json` are untracked and must stay out of `git add`.

## What happened
Three peer Claude sessions (care2talk-ba, ledger-integrity-protocol, cpm-f2) sent v1.7.1 field reports. Filed as ISS-042..ISS-049; all eight resolved this session with per-issue resolutions in the ledger.

| Commit | Issue | Change |
|---|---|---|
| 064ce87 | ISS-045 (critical, root cause) | Codex resume re-sends the recorded model; `model` + `session_id` allowed mid-session |
| d1f8a20 | ISS-043/044/048 | `failover` block on results, tier carried across providers, Gemini `init.model` observed, 503 → PROVIDER_UNAVAILABLE |
| a6f3644 | ISS-046 | `review_deadline_seconds` whole-review ceiling; status/history expose wall-clock source and session state |
| 3efd186 | ISS-042 | Server stays up without storage; `STORAGE_UNAVAILABLE` from history/status; README Node-upgrade rebuild note |
| 254b06f | ISS-047 | `require_cwd` (default **true**): MCP auto-capture without `cwd` is refused. **Behavior change for anyone relying on the launch directory** |
| 5661197 | ISS-049 | `base`/`head` range on `review_code`; CLI `--base/--head`, `--diff` optional |
| 2bfd9a2 | probe-loop finding | Fresh-review failures name the started thread; failed rows stamped with admission time |

## Probe-loop (two rounds, real MCP stdio against dist, real git, live Codex/Gemini)
Scaffolding lived in the session scratchpad (`probe/mcp-call.mjs` drives the built bundle over stdio; `break-sqlite.mjs` resolves better-sqlite3 to a copy without its native build). Probes: storage-addon failure, require_cwd refusals, CLI/MCP ref validation, empty range, live range review, 3s and 20s deadlines, failover with bogus Codex and Gemini models, cross-process resume on the fast tier (rollout shows only gpt-5.6-luna, never the machine default), 4-chunk range review on the fast tier (18 model records, all luna).

**Found and fixed:** timed-out fresh review left no session row and no id in the error (cross-layer trust violation, codex.ts → lifecycle). **Minor fixed:** MCP empty range said "no changes in <dir>" without naming refs. **Observed limitation, not fixed:** a fresh *Gemini* review that fails before agy caches its conversation id still has no id to report.

## Next
1. Read the seven-commit diff once more, then open the PR to `main` and cut v1.8.0 (require_cwd default change and new config fields belong in release notes).
2. Reply to the three peer sessions with the fix summary and ask them to retest on the release.
3. ISS-047's second ask (cross-instance history lookup) stays deferred to ISS-035/ISS-018.
4. Six pre-existing prettier-dirty files remain untouched (codex-binary*, sdk-version.test, loader.test, prompts.test, chunking.test).

## Note for the user
CLAUDE.md forbids AI tool names in commits, so the `Claude-Session:` trailer the harness asks for was omitted on every commit this session.