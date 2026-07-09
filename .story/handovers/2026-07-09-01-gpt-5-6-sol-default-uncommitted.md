# Handover — GPT-5.6 Sol support implemented and live-verified (uncommitted)

## TL;DR
Added GPT-5.6 Sol support and made `gpt-5.6-sol` the Codex backend default after OpenAI's 2026-07-09 general-availability release. The bridge now recommends Sol first and `gpt-5.5` as fallback, bundles Codex SDK/CLI 0.144.0, and updates all active documentation/help/error guidance. All 809 tests, lint, typecheck, and build pass; two real no-override reviews were served by Sol through the Codex provider. **Nothing has been committed, version-bumped, published, tagged, or pushed.**

## Why this changed
- User supplied the GPT-5.6 preview announcement and requested Sol support plus a new default.
- OpenAI's July 9 GA page confirmed GPT-5.6 availability across Codex and the API: https://openai.com/index/gpt-5-6/
- Codex's refreshed local model catalog confirmed the machine-readable slug `gpt-5.6-sol` with display name `GPT-5.6-Sol` and description “Latest frontier agentic coding model.”
- The installed latest npm package was `@openai/codex-sdk@0.144.0`, which bundles matching `@openai/codex@0.144.0`.

## Implementation
- `src/config/types.ts`
  - Changed `RECOMMENDED_MODELS.codex` from `['gpt-5.5', 'gpt-5.4']` to `['gpt-5.6-sol', 'gpt-5.5']`.
  - Kept the recommend-not-enforce policy: arbitrary user model strings remain valid and are forwarded unchanged.
- `src/backends/codex.ts`
  - `CODEX_DEFAULT_MODEL` now derives from `RECOMMENDED_MODELS.codex[0]`, making Sol the default and the target for `model: "latest"`.
  - MODEL_ERROR fallback selection now chooses the highest-ranked documented model whose ID differs case-insensitively from the failed model. A rejected Sol recommends 5.5; a rejected 5.5 recommends Sol. This avoids reintroducing ISS-009's self-recommending fallback bug.
- `package.json` / `package-lock.json`
  - Exact-pinned `@openai/codex-sdk` from 0.128.0 to 0.144.0; its bundled CLI is also 0.144.0.
- `src/backends/sdk-version.test.ts`
  - Updated the SDK/CLI lockstep regression guard to 0.144.0.
- `src/backends/codex.test.ts` and `src/config/types.test.ts`
  - Updated default/latest/fallback/case-insensitivity expectations and locked the recommended pair to Sol + 5.5.
- `README.md`, `src/cli/commands.ts`, and the three `src/tools/review-*.ts` handlers
  - Updated the default model, fallback guidance, config sample, model table, CLI help, and MCP schema descriptions.
- Storybloq lesson `L-006`
  - Advanced the persistent recommendation policy from 5.5/5.4 to Sol/5.5.
  - Reinforced it after live review, setting `lastValidated` to 2026-07-09.
- Storybloq added `channel-inbox/` to `.story/.gitignore` during this session.

## TDD and verification
1. Tests were changed first. The red run failed exactly where expected: default/latest model, fallback tips, recommendation list, and SDK pin (10 failures).
2. Focused implementation suite: **237/237 passed**.
3. Full gate:
   - `npm test` — **809/809 passed**
   - `npm run lint` — clean
   - `npm run typecheck` — clean
   - `npm run build` — clean
4. Final focused recheck after lesson metadata fix:
   - 139/139 passed
   - typecheck clean
   - `git diff --check` clean

## Live Sol probes
### Bundled CLI path
A temporary strict single-provider config omitted `codex_path`, forcing the new bundled CLI. A no-model-override `review-plan` logged:
- `resolved model: gpt-5.6-sol (requested: default)`
- result: approve
- `provider: codex`
- `review_mode: single`

### Local pinned CLI path
The repo's ignored `.reviewbridge.json` pins `/Users/amirshayegh/.local/bin/codex`. The first normal-config probe correctly resolved Sol but failed because that pinned binary was still 0.142.5 and returned “requires a newer version of Codex.”
- Ran `codex update`; standalone CLI advanced to 0.144.0.
- Re-ran the same no-override review through the normal repo config.
- Result: approve, `provider: codex`, `review_mode: failover`, default resolved to `gpt-5.6-sol`.

### Patch self-review
The built bridge reviewed the actual multi-file patch using Sol:
- verdict: approve
- provider: codex
- 2 chunks reviewed
- one minor valid finding: `L-006.lastValidated` remained 2026-04-23 after updating the policy.
- Fixed via `storybloq_lesson_reinforce`; `lastValidated` is now 2026-07-09 and reinforcement count is 1.

## External/local environment changes
- Updated standalone Codex CLI from 0.142.5 to 0.144.0 at the existing `~/.local/bin/codex` symlink target.
- Registered the official OpenAI developer-docs MCP globally at `https://developers.openai.com/mcp`.
- Codex should be restarted so the current app process fully picks up the CLI update and newly registered docs connector.

## Current git state
- Branch/HEAD: `main` at `b89dc6a` (`chore: add triage-session handover`).
- Model-support changes are unstaged and uncommitted.
- Modified:
  - `.story/.gitignore`
  - `.story/lessons/L-006.json`
  - `README.md`
  - `package.json`, `package-lock.json`
  - `src/backends/codex.ts`, `codex.test.ts`, `sdk-version.test.ts`
  - `src/config/types.ts`, `types.test.ts`
  - `src/cli/commands.ts`
  - `src/tools/review-plan.ts`, `review-code.ts`, `review-precommit.ts`
- Existing untracked files/directories were preserved:
  - `.codex/`
  - `AGENTS.md`
- The temporary `temp/sol-probe/.reviewbridge.json` used for strict bundled-CLI probes was deleted.
- No ticket or issue status was changed for this work.

## Next steps
1. Decide whether this should ship as 1.5.3 or another version; no version bump has been made.
2. Before committing, re-read `git diff` and `git diff --staged` line by line per repo rules, then run `npm test && npm run lint && npm run typecheck`.
3. Commit only the intended model-support and Storybloq metadata files; do not accidentally add the pre-existing untracked `.codex/` or `AGENTS.md` unless explicitly desired.
4. Publish/tag/push only if explicitly requested.
5. Restart Codex to activate the updated CLI/docs-connector environment in the desktop process.
