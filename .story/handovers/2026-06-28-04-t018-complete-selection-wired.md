# Session Handover (addendum): T-018 complete — backend selection fully wired

**Supersedes the T-018 status in `2026-06-28-03-t013-t018-gemini-backend-shipped.md`** (read that one for full context, architecture, and the verified agy facts). Only the delta is here.

## What changed since the prior handover
T-018 is now **complete** (was "in progress"). Two more commits on `main`:
- `69aaea9` — `src/backends/index.ts`: `createBackend(config, copilot)` selects codex/gemini by `config.provider` (sync, exhaustive switch). Tested in `index.test.ts`.
- `3108e9c` — `server.ts` and `cli/commands.ts` now call `createBackend` instead of `createCodexBackend`; their test mocks target `./backends/index.js`; the CLI's init-failure message is provider-neutral.

`provider: "gemini"` is now reachable end-to-end via MCP + CLI; codex stays the default, unchanged. Suite green: **558 tests, 31 files**. Tree clean at `3108e9c`.

## Verification standing
- Gemini backend: **live-validated** against real agy (earlier this session).
- Selection routing: unit-tested (`index.test.ts`).
- Server/CLI wiring: tested with mocks; codex path also covered by `server.integration.test.ts`.
- Optional remaining proof: a single **live CLI run** with `provider:'gemini'` (build + temp `.reviewbridge.json`) would exercise the built binary end-to-end. Not yet done — high-confidence-but-redundant given the above.

## Next up (multi-provider phase)
- **T-017** provider provenance: tag sessions with their provider so a codex thread-id and an agy conversation-id can't resume under the wrong backend (clear error instead of a confusing failure). Recommended next.
- **T-019** `model: "latest"` resolver per provider (mind L-008: SDK-path "latest" = latest the pinned SDK supports).
- **T-020** dual-backend test suite (was blocked on selection; now unblocked once T-019 lands too).

## Directives unchanged
TDD for everything · latest model per provider (T-019) · per-increment green commits · no AI tool names / co-author tags in commit messages · live-validate risky integrations.
