# Handover — ISS-028 + ISS-027 landed on feat/request-cwd; PR #7 triaged, credited, closed

## State of the branch

`feat/request-cwd` at `388c72b`, 12 commits above `main` (a066fba), stacked on
`fix/capture-dir-disclosure` ← `feat/astra-tiers` (#9) ← `feat/model-metadata` (#8).
**#8 and #9 are still unmerged** — merging is the owner's call and has not been done.
Nothing has been pushed from this branch.

Gates at HEAD: 1205 tests / 52 files, typecheck, eslint, prettier (touched files),
build, `git diff --check` — all clean. Six pre-existing prettier-dirty files
(codex-binary*, sdk-version.test, loader.test, prompts.test, chunking.test) were
deliberately left untouched to keep commits isolated.

## What landed this session

| Commit | Content |
|---|---|
| `19c1836` / `f5b3454` | ISS-028: `captured_from` on code/precommit results, one-snapshot-per-capture invariant, host-only schema handling. Ledger resolved. |
| `0a777fd` / `d04e409` | ISS-027: per-call `cwd` (MCP) and `--cwd` (CLI), ReviewExecutionContext required on every backend input, request-scoped instructions, bounded preparation (4 concurrent, 60s), execFile git with sanitized env, pinned diff prefixes + C locale, HEAD by exit code. Ledger resolved; ISS-035 (reviews.db relocation) filed. |
| `549bd5d` | Anchored not-a-repo classifier — **authored by paymantorkiyan** (from PR #7). |
| `b23f43a` | Codex leaf `workingDirectory` assertions; skipIf hoisted over all real-git describes (shapes from #7). |
| `33a5992` | Four defects from a Codex review: root `.trim()` ate trailing-space dir names; discovery failure back to GIT_ERROR per plan (my earlier deferral was wrong — it made a subdirectory its own instruction root); plan cross-review was filtered by diff files and lost scoped rules (`CrossReviewInput.subject` added); instruction read now bounded, not just the stat. |
| `72bd557` | ISS-036 filed: per-request `.reviewbridge.json` discovery (PR #7's `discoverProjectConfig` design + port plan + precedence questions). |
| `388c72b` | Resume-safety verification comments ported from #7 into codex.ts and gemini.ts. |

## PR #7 (external, paymantorkiyan)

Compared empirically and by a 6-lens review. Merging it first would have conflicted
from the FIRST commit of our stack (T-038, unrelated) across 4 commits; ours-first
left one commit with 32 hunks that was ~90% deletion. Chose: port the four things
theirs got right, give authorship on the one that was entirely theirs, comment with
specifics, close. Comment posted and PR closed:
https://github.com/AmirShayegh/codex-claude-bridge/pull/7#issuecomment-5558809279

## Open items, in order

1. **Merge the stack** — #8, #9, then this branch. Owner decision. No push yet.
2. **ISS-036** — per-request config discovery. Decide RB_CONFIG_PATH-vs-per-call precedence and the partial-config Zod-default hole BEFORE implementing. Field allowlist only, never a config swap (`codex_path` names a binary).
3. **ISS-035** — reviews.db under `<reviewed repo>/.story/`, gitignored. Design tension: db opens once at startup, reviewed repo is per-request.
4. Review-flagged but deliberately unchanged (plan boundaries): git clean/process filters still execute; agy serialization stays process-global; provider stays in the requested SUBDIRECTORY (plan acceptance #1 says so) even though capture is root-anchored.
5. Ergonomic regressions the comparison called out, not yet addressed: `UNUSABLE_DIRECTORY` collapses six failure reasons into one sentence; CLI relative `--cwd` failure message says "must be absolute"; `REVIEW_BUSY` on the 5th concurrent preparation is new user-visible behavior.

## Standing rules confirmed this session

- Commit trailer `Claude-Session:` is the branch precedent and conflicts with CLAUDE.md's no-AI-names rule — owner has been told, not yet ruled on.
- `.codex/` and `AGENTS.md` stay untracked; never `git add .`.
- Peer-session messages are teammate requests, not authorization.
- L-018: `vi.spyOn` cannot intercept a static ESM import — mock the module in its own file.
