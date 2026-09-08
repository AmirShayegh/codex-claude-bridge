# v1.7.0 released

Reviewed and merged PR #8 (responding-model metadata/lifecycle), #9 (Astra and provider-neutral tiers), and #10 (caller-selected cwd, transport and release fixes). Main and annotated tag v1.7.0 point to a3c6705d5bdeb0737e0a9ee9175d32cc1545d31d. Published codex-claude-bridge@1.7.0 to npm latest; registry SHA1 33b4c32edca53970de49d73761ef97b3c6eef0c6 matches the clean-installed tarball.

## Review and fixes

Six lenses reviewed the combined stack, followed by six-lens approval of the release fixes. Fixed malformed Gemini result.error crashing the subprocess callback (ISS-038), replaced retired Gemini Flash 3.5 tier/default labels with 3.8 after a real provider failure (ISS-039), and removed real-time deadline dependence from observer functional tests (ISS-041). ISS-029 is now resolved after a successful live stream-json review. Auto-filed ISS-040 duplicates ISS-037 and was closed as duplicate, not claimed fixed.

## Validation

1226 tests / 52 files; build, typecheck, eslint, diff checks green. PR #8 and #9 updated heads were independently installed and preflighted. Actual Codex fast review resolved/observed gpt-5.6-luna; actual Gemini fast review resolved Gemini 3.8 Flash (Medium). Published tarball clean-installed with native dependencies. CLI version and MCP initialization, five tools, cross-directory empty capture, provenance, history pagination shape, and invalid cwd smoke checks passed. No GitHub Actions workflows exist. Review artifacts and preflight logs are under /tmp/bridge-release-review (ephemeral).

## Remaining

Running MCP servers were not restarted: code is loaded at spawn; reconnect/restart is still needed. Known ISS-037 Gemini cwd-cache conversation-ID race remains, as do ISS-030 degraded-result rendering, ISS-035 DB location, and ISS-022/ISS-036 config scope. Release notes disclose existing behavior. Original untracked .codex/ and AGENTS.md left alone. Temporary detached PR review worktrees can be removed after this handover; release install/probe artifacts are outside the repository.
