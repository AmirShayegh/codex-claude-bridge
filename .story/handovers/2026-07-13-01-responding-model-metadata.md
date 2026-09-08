# T-038 — Evidence-aware responding-model metadata

## Outcome

Implemented and Story-approved. T-038 is complete. No commit, version bump, publication, staging, or push was performed.

Successful plan, code, and precommit responses now expose host-side model contributions and persistence provenance. History stores immutable model snapshots with explicit recorded / legacy_unrecorded / invalid status and bounded cursor pagination.

## Main implementation

- Added optional public `models` and `provenance` contracts while always emitting them from new successful calls.
- Kept host metadata out of provider-facing structured-output schemas.
- Added secure, bounded Codex rollout observation with UUIDv7/date candidate validation, no-follow descriptor checks, reverse bounded reads, deadlines, and LRU caching.
- Added truthful Gemini selected-only evidence and a five-minute single-flight model catalog cache.
- Added shared lifecycle admission (global 4, per-session 1), explicit routing ownership, memory registry/tombstones, and status integration.
- Added atomic SQLite migrations, BEGIN IMMEDIATE outcome transactions, bounded busy retry, durable-to-memory fallback, survivor-ID transitions, immutable history snapshots, and a verified reviews(session_id,id) index.
- Added strict selector/session validation, terminal control sanitization, CLI human/JSON model rendering, MCP descriptions, and README docs.
- Deliberation now converts rejected reviewer/adjudicator promises to sanitized Results so a successful peer survives and only successful contributors are reported.
- Lifecycle execution was split into admission, normalization, persistence/provenance, and cleanup phases; unexpected backend exceptions stay inside the Result contract.

## Validation

- `npm test -- --run`: 44 files, 939 tests passed.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- Two independent focused audits found no remaining lifecycle or deliberation correctness issue.
- Story CODE_REVIEW round 2: approve, full six-lens coverage, 0 blocking, 0 major, 4 maintainability minors, 1 test suggestion.

## Live acceptance evidence

- Default Codex call reported requested=null, resolved=gpt-5.6-sol, observed=gpt-5.6-sol, evidence=runtime_session_record.
- Fresh explicit gpt-5.5 call reported matching resolved/observed gpt-5.5.
- Persistent resume of that gpt-5.5 thread while Sol was default retained resolved=gpt-5.5 and freshly observed gpt-5.6-sol, with one sanitized mismatch warning. This is control-plane evidence, not proof of underlying weights.
- A live deliberate probe degraded safely to Codex-only because Gemini timed out; automated deliberate/deep tests cover both reviewers and adjudication roles.

## Story state

- T-038: complete.
- ISS-025 (provider promise rejection discarding a survivor): resolved by this work.
- ISS-026 remains open as a non-blocking maintainability issue for duplicated long deliberation flows.
- L-015 records the resolved-vs-observed resume lesson.
- Snapshot taken before this handover: 2026-07-13T10-05-14-440.json.

## Working tree

Expected implementation changes are uncommitted. Pre-existing untracked `.codex/` and `AGENTS.md` were not modified and must remain untouched.
