<!-- storybloq-handover v1 -->

# Session Handover — peer reports fixed, probe-loop, v1.8.0 released

## Worker state

- On `main` at 0d9d868 (merge of PR #12). Tree clean apart from the standing untracked files `.codex/`, `AGENTS.md`, and `.story/` additions, which stay out of `git add`.
- `codex-claude-bridge@1.8.0` is published to npm (`latest`), tagged `v1.8.0`, GitHub release published. Existing MCP servers must reconnect to pick it up.
- Session id of this worker: `cb5d10d8-fce9-4e58-a6c6-7c7d8f90d513`.
- Probe scaffolding (MCP stdio driver `mcp-call.mjs`, broken-sqlite loader hook, scratch repos) lived in this session's scratchpad and is gone with it; the recipe is in lesson L-020 and the `feedback-probe-loop-after-fixes` memory.

## Blocked

- (none)

## Owner rulings

- The `Claude-Session:` commit trailer was omitted on every commit this session because CLAUDE.md forbids AI tool names in commit messages. Owner has not ruled; raise it if trailers are wanted.
- `require_cwd` defaults to **true** (behavior change): an MCP auto-capture without `cwd` is refused. Chosen to close the silent-wrong-diff class from ISS-047; opt-out is `"require_cwd": false`.

## Carried forward

- ISS-035 / ISS-018: cross-instance `review_history` lookup by session_id (second ask in ISS-047) still depends on these.
- ISS-036: config loaded at server startup only.
- ISS-037: Gemini conversation ids come from agy's shared cwd cache. Related new limitation: a fresh Gemini review that fails before agy caches its id has no session id to report (Codex side is fixed in 2bfd9a2).
- Six pre-existing prettier-dirty files untouched: `codex-binary.ts`, `codex-binary.test.ts`, `sdk-version.test.ts`, `loader.test.ts`, `prompts.test.ts`, `chunking.test.ts`.
- Storybloq warned that display ids (L-020) were minted on a branch without git-refs allocation; run `storybloq team init && storybloq team config set idAllocator git-refs` if collisions appear.

## Shipped

- ISS-045 (critical root cause): Codex resume re-sends the recorded model; `model` + `session_id` allowed mid-session (064ce87).
- ISS-043/044/048: `failover` block on results only when failover happened; tiers carried across providers; Gemini runtime model observed; Gemini 503 → PROVIDER_UNAVAILABLE (d1f8a20).
- ISS-046: `review_deadline_seconds`; status/history expose wall-clock source and session state (a6f3644); failures name the started thread and record admission time (2bfd9a2).
- ISS-042: server survives a missing SQLite addon; `STORAGE_UNAVAILABLE`; README rebuild-after-Node-upgrade note (3efd186).
- ISS-047: `require_cwd` config (254b06f).
- ISS-049: `base`/`head` on `review_code`, CLI `--base/--head` (5661197).
- Release: `chore: release v1.8.0`, PR #12, tag, GitHub release, npm publish.
- Ledger: ISS-042..049 resolved with resolutions; lesson L-020; handovers `2026-09-15-01` and `-02`; snapshot saved.

## Next session

1. Message the three peer sessions (care2talk-ba, ledger-integrity-protocol, cpm-f2) to retest on `@latest`; their reports were the source of every issue here.
2. Watch for `require_cwd` friction from single-repo users.
3. Consider a `probe/` directory in-repo (gitignored or documented) so the MCP stdio driver and broken-addon simulation survive between sessions.
