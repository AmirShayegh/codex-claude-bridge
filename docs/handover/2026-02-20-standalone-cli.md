# Session Handover: Standalone CLI (Phase 9)
**Date:** 2026-02-20
**Duration:** ~1 hour

## Completed
- [x] Installed `commander@13` and `picocolors@1.1.1` as production dependencies
- [x] Added `splitting: false` to `tsup.config.ts` to prevent code-splitting with dynamic imports
- [x] Extracted shared `resolvePrecommitDiff()` to `src/utils/resolve-diff.ts` with `NO_STAGED_CHANGES` sentinel
- [x] Refactored `src/tools/review-precommit.ts` to use shared `resolvePrecommitDiff()`
- [x] Built `src/cli/stdin.ts` — file/stdin reader with consumed guard and timeout
- [x] Built `src/cli/formatter.ts` — terminal output with picocolors, color detection (FORCE_COLOR/NO_COLOR/isTTY)
- [x] Built `src/cli/handlers.ts` — generic `createHandler<T>` factory (execute/format/exitCode)
- [x] Built `src/cli/commands.ts` — Commander setup with 3 subcommands (review-plan, review-code, review-precommit)
- [x] Extracted MCP server startup to `src/mcp.ts`
- [x] Rewrote `src/index.ts` as thin argv router (dynamic imports, no cross-loading)
- [x] Added CLI usage section to README.md
- [x] Updated CLAUDE_RULES.md approved dependencies list
- [x] Bumped version to 0.1.2
- [x] Addressed Codex review findings (3 fixes)
  - Simplified router: any arg → CLI, no args → MCP (prevents unknown args hanging in MCP mode)
  - Added `--depth` validation via `Commander.choices(['quick', 'thorough'])`
  - Added `src/index.test.ts` — 5 router integration tests (uses built dist, skips when not built)

### New files
- `src/mcp.ts` — MCP server startup (extracted from old index.ts)
- `src/utils/resolve-diff.ts` + `resolve-diff.test.ts` — shared precommit diff resolution (8 tests)
- `src/cli/stdin.ts` + `stdin.test.ts` — stdin/file reader with consumed guard (9 tests)
- `src/cli/formatter.ts` + `formatter.test.ts` — terminal output formatting (16 tests)
- `src/cli/handlers.ts` + `handlers.test.ts` — handler factory (6 tests)
- `src/cli/commands.ts` + `commands.test.ts` — CLI command wiring (11 tests)
- `src/index.test.ts` — router integration tests (5 tests, requires build)
- `docs/handover/2026-02-20-standalone-cli.md` — this file

### Modified files
- `src/index.ts` — rewritten as argv router
- `src/tools/review-precommit.ts` — refactored to use `resolvePrecommitDiff()`
- `tsup.config.ts` — added `splitting: false`
- `package.json` — added commander/picocolors, version 0.1.2
- `README.md` — added Standalone CLI section
- `CLAUDE_RULES.md` — commander/picocolors already in approved deps (no diff)

## In Progress
- Nothing — Phase 9 is complete

## Test Status
- `npm test` — 368 tests passing (321 existing + 47 new)
- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm run build` — single `dist/index.js` (50.28 KB) with shebang

## Manual verification
- `node dist/index.js --help` — shows 3 subcommands
- `node dist/index.js --version` — shows 0.1.2
- `node dist/index.js review-precommit --help` — shows precommit options
- `node dist/index.js nonsense` — unknown command error, exit 1
- No args starts MCP server (backward compatible)

## Key design decisions
1. **Dynamic import router** — `index.ts` routes based on `process.argv.length > 2`. Any arg → CLI, no args → MCP. Neither path loads the other's dependencies.
2. **Handler factory** — `createHandler<T>` takes execute/format/exitCode config. Anticipates 4th handler for Phase 10's `review-pr`.
3. **Exit code 2** for blocked precommit — enables `npx codex-claude-bridge review-precommit && git commit`.
4. **Shared diff resolution** — `resolvePrecommitDiff()` used by both MCP handler and CLI. MCP intercepts `NO_STAGED_CHANGES:` prefix for structured response; CLI treats it as exit 1.
5. **`splitting: false`** — prevents tsup from emitting code-splitting chunks with dynamic imports.
6. **Version from package.json at runtime** — walks up from `import.meta.url` to find `package.json`. Works from both `src/` and `dist/`.
7. **Commander `.version(undefined)` returns undefined** — discovered that `.version()` acts as getter when called with undefined. Fixed by using file-based version resolution with fallback to `'0.0.0'`.
8. **`--depth` validated via Commander `.choices()`** — invalid values rejected at parse time instead of silently passed to Codex.
9. **Router tests use built dist** — `node dist/index.js` instead of `tsx src/index.ts`. `describe.skipIf(!hasDist)` skips gracefully when dist isn't built. No flaky timeout-based MCP test.

## Next Steps
1. **Commit and push** Phase 9 changes
2. **Publish** v0.1.2 to npm
3. **Phase 10** — `review-pr` tool (GitHub PR review integration)
4. **Phase 8** — README overhaul (deferred, lower priority than CLI)
