# Handover — Gemini stream-json fix, per-chunk file metadata; nothing in effect until servers restart

## State of the branch

`feat/request-cwd` at `e353c76`, stacked on `fix/capture-dir-disclosure` ← `feat/astra-tiers` (#9)
← `feat/model-metadata` (#8). **Nothing pushed from this branch. #8 and #9 unmerged.**
Working tree clean except untracked `.codex/` and `AGENTS.md` (leave them alone).

Gates at HEAD: 1220 tests / 52 files, typecheck, eslint, prettier (touched files), build,
`git diff --check` — all clean. `sdk-version.test.ts` "SDK bundles the matching CLI binary
version" flaked once this arc; environmental, not a regression.

## The one thing to know first

**No running MCP server on this machine has any of this session's fixes.** Every
`node .../codex-claude-bridge/dist/index.js` process predates the Sep 6 20:03 build
(newest started Sep 5 15:53). Node loads modules at start, so the old Gemini argv is still
in memory in every server, including `codex-bridge-local`. Peers keep hitting
`--print took "--sandbox" as its prompt` on the failover path and are recording reviews as
"unavailable". A new Claude session or `/mcp` reconnect picks up the local build; the
published package needs the stack merged and released. I did not restart anything —
it affects other sessions. (Credit: `agentkit-rn-a3` caught this; I had wrongly told them
the local server was fixed after checking the file, not the process.)

## What landed since the previous handover

| Commit | Content |
|---|---|
| `3b0e6ff` (on #8) / `b96f957` (on #9) | Codex PR-review fixes: failed reviews persisted to SQLite via `persistFailure`; deliberation carries provider-neutral tiers to secondary and both adjudicators (`carriedModel`). Stack rebased on top. Codex not yet told. |
| `63fbe12` | First Gemini fix (prompt as `--print` value, last). Superseded. |
| `7759fae` | **Real Gemini fix**: agy 1.1.27 changed `--print` to take the prompt as its value. Now `--sandbox --model X [--conversation id] --input-format stream-json --output-format stream-json`, prompt on stdin as `{"event":"user",...}` NDJSON, last `result` event parsed by `extractAgyResult`. No size cap (a 120 KiB guard would have refused ordinary 106 KB reviews). Validated with real agy calls incl. 252 KiB prompt and a two-turn resume. |
| `98760f9` / `7ad3d08` | L-019 (provider CLI contract drift); ISS-037 (take conversation id from the result event instead of reading agy's session file). |
| `e353c76` | `chunk_files: string[][]` on code/precommit results — files per chunk, only when the diff was split; host-only (omitted from model-facing schemas); deliberation forwards primary's list. Suggested by the peer session tracing T-200. |

## Open items, in order

1. **Push and merge the stack** (owner): `git push --force-with-lease origin feat/model-metadata feat/astra-tiers` (rebased), then push `fix/capture-dir-disclosure` and `feat/request-cwd`; reply to Codex on #8/#9 citing `3b0e6ff` / `b96f957`; merge; bump; publish. Then restart bridge servers.
2. **Commit-trailer policy**: branch commits end with `Claude-Session: https://claude.ai/code/session_01DyzkySCXgJcFZXU4a4EP4J`, which conflicts with the CLAUDE.md "no AI tool names in commits" rule. Kept the branch precedent; owner to decide.
3. **ISS-037** — conversation id from the stream-json result event (small, gemini.ts only).
4. **ISS-036** — per-request `.reviewbridge.json` discovery (PR #7 design). Decide precedence first.
5. **ISS-035** — reviews.db relocation under the reviewed repo.
6. Ergonomic regressions noted, unfiled: UNUSABLE_DIRECTORY collapse, CLI relative-path message, REVIEW_BUSY visibility.

## Lessons this arc

- L-018: `vi.spyOn` cannot intercept a static ESM import; use a separate file with `vi.mock`.
- L-019: provider CLI contracts drift under you; probe the real binary (a bogus model name gives a parse-only run).
- Unfiled: "committed and built" is not "in effect" for a long-running MCP server. Check the process start time against the build time before claiming a fix is live. Worth a lesson entry.
