# T-038 — Final evidence-aware model metadata handover

## Current state

T-038 is complete and the implementation is ready for the next operator to inspect, commit, or publish only when separately authorized. This handover supersedes no prior record; it confirms the final state after the Story-approved implementation documented in `2026-07-13-01-responding-model-metadata.md`.

No commit, staging, branch creation, version bump, push, PR, or package publication has been performed.

## Delivered behavior

- Every new successful plan, code, and precommit response emits host-side `models` and `provenance`.
- Model contributions distinguish provider, role, requested selector, bridge-resolved label, runtime-observed label, and evidence source.
- Codex runtime observation is UUIDv7/date constrained, containment checked, no-follow/nonblocking where supported, reverse-read with 8 MiB / 100 ms bounds, and cached with a 256-entry one-hour LRU.
- Gemini reports the exact bridge-selected model with `observed: null` and uses a five-minute single-flight catalog cache.
- Single, failover, degraded, deliberate, and deliberate-deep composition reports only successful contributors in deterministic reviewer/adjudicator order.
- Synthetic no-change results report `models: []` and `persistence: not_recorded`.
- The shared lifecycle enforces four global active logical reviews and one per session, explicit safe resume routing, registry-backed memory-only sessions, and immediate REVIEW_BUSY rejection.
- SQLite migrations add `sessions.model_identity_json` and `reviews.models_json` atomically, outcomes use BEGIN IMMEDIATE plus bounded busy retry, and permanent writes degrade successful reviews to honest memory-only provenance.
- History returns immutable model snapshots, malformed-metadata status, bounded keyset pagination, and uses a verified `reviews(session_id,id)` index.
- CLI/MCP descriptions, JSON/human rendering, validation, control escaping, and README documentation are updated.
- Deliberation catches rejected provider promises as sanitized Results so a successful peer and its model contribution survive.

## Validation evidence

- `npm test -- --run`: 44 test files, 939 tests passed.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- Independent lifecycle and deliberation state audits: no findings.
- Final Story CODE_REVIEW: approve with full six-lens coverage, 0 blocking, 0 major, 4 maintainability minors, and 1 optional test suggestion.

## Live probes

- Current default: `requested=null`, `resolved=gpt-5.6-sol`, `observed=gpt-5.6-sol`, runtime-session evidence.
- Fresh explicit thread: matching `resolved` and `observed` `gpt-5.5`.
- Resume of that 5.5 thread while Sol was the default: retained `resolved=gpt-5.5`, freshly recorded `observed=gpt-5.6-sol`, and emitted one sanitized mismatch warning.
- Live deliberate mode safely degraded to Codex-only when Gemini timed out; automated tests cover dual-reviewer and deliberate-deep adjudication identities.

These labels are control-plane evidence and are not proof of underlying model weights or internal routing.

## Story records

- T-038: complete.
- ISS-025: resolved by rejected-promise containment.
- ISS-026: open, non-blocking maintainability cleanup for duplicated long deliberation flows.
- L-015: resolved-vs-observed identity lesson.
- Fresh pre-handover snapshot: `2026-07-13T10-10-19-464.json`.

## Working-tree cautions

All implementation and Story records are uncommitted. Preserve the pre-existing untracked `.codex/` directory and `AGENTS.md`; they were not modified by this work. Review the complete diff line by line before any future commit, per repository rules.
