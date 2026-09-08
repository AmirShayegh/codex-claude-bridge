# Handover — External usage feedback triaged into ISS-027 / ISS-028; no code changed

## TL;DR

A context-load session that turned into intake. Three external usage reports arrived mid-session from a peer Claude session (`care2talk-9e`) relaying feedback from three Care2Talk seats after a night of heavy bridge use. Two were technical claims; I verified both against the code at `a066fba` and filed them as **ISS-027** (high) and **ISS-028** (medium). A third was an operational heads-up, later corrected by the sender, recorded as note **N-004**.

**No code was written, no tests were run, nothing was committed.** The inherited uncommitted T-038 working tree is untouched and still needs its review.

## What was reported and what was verified

### ISS-027 — auto-capture runs in the server's spawn cwd, not the caller's worktree (high)

Two seats independently, hours apart, hit a false `"No staged changes found"` while a full staged diff sat in their git worktree. `care2talk-39` was in `~/Developer/ReactNative`; `c2t-design-71` was in `~/Developer/c2t-design/.claude/worktrees/t027-package-readiness`. Both burned a review call and diagnosed it from scratch. Reported against both `codex-bridge` and `codex-bridge-local`. Workaround is passing the diff explicitly.

I did not reproduce it, and neither did the reporting session — this is two independent seat accounts plus a code read. The code read is unambiguous:

- Every capture in `src/utils/git.ts` (lines 29, 38, 53, 64, 71-72) calls `execAsync` with **no `cwd` option**, so each git command runs in the directory the client spawned the stdio server in.
- No MCP tool accepts a `cwd` / `repo_path` parameter, and a stdio server has no way to learn the caller's current directory.
- So a session that moves into a worktree after spawn captures the *main checkout's* index. `review_precommit` returns the empty-result path (`src/utils/resolve-diff.ts:24` → `src/tools/review-precommit.ts:70`), and `review_code` with `auto_diff` returns `"No changes found to review."` (`src/tools/review-code.ts:87`).

Fix direction recorded on the issue: accept an optional `cwd`/`repo_path` tool parameter, validate it is an existing directory inside a git work tree, thread it into the `execAsync` calls via `resolve-diff`, and have the CLI default it to `process.cwd()`. Not designed further — see Decision needed below.

### ISS-028 — empty results are silent; name the capture directory (medium)

The reporting session argued this matters more than the bug itself, and I agree with the reasoning. `"No staged changes found"` is indistinguishable from a legitimate empty result and names no directory, so users have no reason to doubt the tool: they check their own git state first, find changes, and only then suspect the bridge. That is why the worktree bug cost two full diagnoses rather than one shrug.

Proposed as the **first** change, ahead of the ISS-027 plumbing: report the absolute directory the git command actually ran in on every auto-captured result, and say so explicitly when it differs from a caller-supplied cwd. Roughly ten lines, no behavior change, and it self-diagnoses whatever the next variant of this class turns out to be.

### N-004 — npx orphan heads-up (corrected) plus positive signal

Original report: a disk cleanup removed most of `~/.npm/_npx`; two running `codex-claude-bridge` processes were executing from deleted directories, alive only on open file descriptors, and a restart would end review capability until npx re-downloaded.

**The sender corrected this before it reached a decision, and the corrected version is what N-004 records.** Reading the config rather than reasoning about it shows two separate servers: `codex-bridge` launches via `npx -y codex-claude-bridge` and does re-download after a restart (a delay and a network dependency), while `codex-bridge-local` launches as `node <repo>/dist/index.js`, was never in the npx cache, exposes the same five tools, and survives a restart with no network. Do not carry the original "permanent loss" framing forward.

Left as a note, not an issue: nothing is broken and this is arguably npx behaving as designed given our documented `npx -y codex-claude-bridge@latest` install recipe. Open question if anyone wants it — should the bridge defend against its own install vanishing (README note, or a startup log of the resolved install path)?

Positive signal from the same report, kept because a feedback record of only complaints is a bad sample. The reviews found three genuine defects that passing test suites had missed: two React Native layout composition errors (the second found while reviewing the fix for the first) and an iOS codegen digest that skipped regeneration when its outputs had been deleted. Two other rounds came back clean and the seats stopped rather than fishing. In one case a seat rejected a suggestion with a reason — declining to default `NODE_BINARY` to `node` in an Xcode script phase, since a wrong Node would silently produce codegen — and the reviewer agreed on the next round.

## State

- `main` = `a066fba`. **Nothing committed this session.**
- The T-038 evidence-aware model-metadata implementation from the previous two sessions is **still uncommitted** across ~55 tracked files, along with its Story records. It was Story-approved with 939 tests green but has NOT had the mandatory line-by-line pre-commit diff review.
- Untracked and pre-existing, both must stay untouched: `AGENTS.md` (a corrupted find-and-replace of CLAUDE.md — rewrite properly or delete, do not commit as-is) and `.codex/config.toml` (pending a decision on whether to version it).
- Ledger changes this session: ISS-027 created, ISS-028 created, N-004 created then updated with the correction. Snapshot `2026-09-04T00-42-20-209.json` taken before this handover.
- Open issues now 7: ISS-018, ISS-020, ISS-022, ISS-024, ISS-026, ISS-027, ISS-028.

## Decision needed

**ISS-027's fix shape is not settled.** An optional `cwd` parameter on the tools is the obvious route, but it is a caller-supplied path handed to a subprocess, so it wants the same scrutiny ISS-022 flagged for runtime-reloadable `codex_path`. Alternatives worth weighing: have the CLI always pass its own cwd (cheap, fixes the CLI path only), or walk up from a supplied path to the git root. Worth a `review_plan` round before implementing.

Note the interaction with ISS-018, which is the same class of bug on a different surface: a cwd-relative `reviews.db` makes the cross-provider guard fail open when the CLI runs outside the server's cwd. ISS-018, ISS-022 and ISS-027 are three faces of one root cause — **the server's spawn-time environment silently standing in for the caller's**. A fix for one should probably be designed knowing about the other two.

## What's next

Nothing is in flight; pick freely.

1. **ISS-028** — ~10 lines, no behavior change, makes the ISS-027 class of failure self-diagnosing. Cheapest real win.
2. **Review and commit T-038** — the largest outstanding debt. Requires reading the full diff line by line per repository rules before any commit.
3. **ISS-027** — plan first, ideally against the ISS-018 / ISS-022 shared root cause.
4. **T-033** remains the phase-order next ticket (plan-finding agreement matching, needs live two-provider plan data).
