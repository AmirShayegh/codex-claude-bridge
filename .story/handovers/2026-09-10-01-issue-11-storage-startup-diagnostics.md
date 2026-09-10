# Issue #11: storage startup diagnostics

## Completed
- Implemented the approved fix in `src/storage/db.ts`: diagnose missing/incompatible better-sqlite3 native bindings, retain the original cause, include manual recovery guidance, and fail without falsely announcing a memory fallback. Explicit :memory: receives the same diagnosis.
- Ordinary persistent failures retain memory fallback; log only after successful initialization. Close failed memory handles and report both failures via AggregateError.
- Added six regression cases in `src/storage/db.test.ts`; observed all six fail before implementation, then pass.
- Added README Troubleshooting instructions for manual npx/native-addon recovery.
- Read the complete implementation, test, and documentation diff. Staged diff is empty.

## Validation
- Build, typecheck, lint, and all 1,232 tests across 52 files passed.
- Isolated install `/tmp/bridge-issue11.qi5B4k` contains dependencies installed with scripts disabled. Replaced only its bridge dist/index.js with this build and ran actual startup for persistent and :memory: configurations. Both exit 1, emit zero stdout, print recovery guidance and one binding-search list, and never claim memory fallback succeeded.
- The first smoke attempt placed the bundle outside its package layout and failed package.json lookup; reran inside the proper isolated package layout successfully.
- Interrupted installation/npm cache reuse itself remains unverified.

## State / Next Steps
- Changes are local and uncommitted, prepared for review; no new release published and no GitHub issue comment posted.
- Model defaults and optional readonly CLI behavior unchanged.
- Existing untracked `.codex/` and `AGENTS.md` left untouched.
- Review and commit the patch; publish separately when requested.
