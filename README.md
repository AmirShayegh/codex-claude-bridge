# codex-claude-bridge

Automated code review powered by [OpenAI Codex](https://developers.openai.com/codex). Run it from the terminal or plug it into Claude Code.

[![npm](https://img.shields.io/npm/v/codex-claude-bridge)](https://www.npmjs.com/package/codex-claude-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/AmirShayegh/codex-claude-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/AmirShayegh/codex-claude-bridge/actions/workflows/ci.yml)

## Try It Now

Stage some changes and run:

```bash
npx codex-claude-bridge review-precommit
```

## Example Output

```
COMMIT BLOCKED

Blockers:
  - Missing error handling in database connection
  - SQL injection vulnerability in query builder

Warnings:
  - Consider adding input validation

Session: a1b2c3d4
```

Exits with code 2 when blockers are found, so you can gate commits:

```bash
npx codex-claude-bridge review-precommit && git commit
```

## What It Does

- **Reviews plans** before you start coding (architecture, feasibility, security)
- **Reviews diffs** for bugs, security issues, and style (with file and line references)
- **Pre-commit checks** that auto-capture staged changes and block on critical issues

Works with your ChatGPT subscription (no API costs) or an OpenAI API key.

## Setup

### Prerequisites

**Node.js 18+** is required. Install from [nodejs.org](https://nodejs.org/).

Install the Codex CLI and sign in with your ChatGPT account:

```bash
npm install -g @openai/codex
codex login
```

The `codex login` step uses your ChatGPT subscription. No API key or per-token billing required.

Alternatively, if you prefer to use an API key instead:

```bash
export OPENAI_API_KEY=sk-...
```

### Standalone CLI

No additional setup needed. Run commands directly with `npx`:

```bash
npx codex-claude-bridge review-precommit
npx codex-claude-bridge review-plan --plan plan.md
git diff main | npx codex-claude-bridge review-code --diff -
```

### Claude Code Integration

Add the MCP server to Claude Code:

```bash
claude mcp add codex-bridge -- npx -y codex-claude-bridge
```

Restart Claude Code after setup. Five review tools become available that Claude Code can call directly.

## CLI Commands

### `review-precommit`

Auto-captures staged changes and checks for issues.

```bash
npx codex-claude-bridge review-precommit
npx codex-claude-bridge review-precommit --diff changes.patch
```

| Flag | Description |
|------|-------------|
| `--diff <path>` | Override auto-capture (file path or `-` for stdin) |
| `--session <id>` | Resume session |
| `--config <path>` | Path to `.reviewbridge.json` directory |
| `--json` | Raw JSON output |

### `review-code`

Reviews a code diff for bugs, security, and style.

```bash
git diff main | npx codex-claude-bridge review-code --diff -
npx codex-claude-bridge review-code --diff changes.patch --focus security,performance
```

| Flag | Description |
|------|-------------|
| `--diff <path>` | File path or `-` for stdin (required) |
| `--focus <items>` | Comma-separated review criteria |
| `--session <id>` | Resume session |
| `--config <path>` | Path to `.reviewbridge.json` directory |
| `--json` | Raw JSON output |

### `review-plan`

Reviews an implementation plan for architecture and feasibility.

```bash
npx codex-claude-bridge review-plan --plan plan.md
npx codex-claude-bridge review-plan --plan - --depth thorough < plan.md
```

| Flag | Description |
|------|-------------|
| `--plan <path>` | File path or `-` for stdin (required) |
| `--focus <items>` | Comma-separated focus areas |
| `--depth <level>` | `quick` or `thorough` |
| `--session <id>` | Resume session |
| `--config <path>` | Path to `.reviewbridge.json` directory |
| `--json` | Raw JSON output |

Add `--json` to any command for machine-readable output.

## MCP Tools

When used as a Claude Code MCP server, these tools are available:

| Tool | Purpose | Returns |
|------|---------|---------|
| `review_plan` | Architectural review of an implementation plan | verdict, findings, session_id |
| `review_code` | Code review of a diff | verdict, findings with file/line refs, session_id |
| `review_precommit` | Pre-commit sanity check on staged changes | ready_to_commit, blockers, warnings, session_id |
| `review_status` | Check progress of a review | status, elapsed_seconds |
| `review_history` | Query past reviews | array of review summaries |

In Claude Code, just describe what you want reviewed. Claude Code picks the right tool:

> "Review this implementation plan before I start coding."
> "Run a pre-commit check on my staged changes."
> "Review this diff for bugs and security issues."

Pass `session_id` between calls to maintain context across the plan-to-commit lifecycle.

<details>
<summary>Full MCP tool parameters</summary>

### `review_plan`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `plan` | string | yes | The implementation plan to review |
| `context` | string | no | Project context and constraints |
| `focus` | string[] | no | Review focus areas (e.g. `["architecture", "security"]`) |
| `depth` | `"quick"` \| `"thorough"` | no | Review depth |
| `session_id` | string | no | Continue from a previous review session |

### `review_code`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `diff` | string | yes | Git diff to review |
| `context` | string | no | Intent of the changes |
| `session_id` | string | no | Continue from previous review |
| `criteria` | string[] | no | Review criteria (e.g. `["bugs", "security", "performance"]`) |

### `review_precommit`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `auto_diff` | boolean | no | Auto-capture `git diff --staged` (default: `true`) |
| `diff` | string | no | Explicit diff instead of auto-capture |
| `session_id` | string | no | Continue from previous review |
| `checklist` | string[] | no | Custom pre-commit checks |

### `review_status`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | yes | Session ID to check |

### `review_history`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | no | Query reviews for a specific session |
| `last_n` | number | no | Return last N reviews (default: 10) |

</details>

## Configuration

Create `.reviewbridge.json` in your project root to customize review behavior:

```json
{
  "model": "gpt-5.2-codex",
  "reasoning_effort": "medium",
  "timeout_seconds": 300,
  "review_standards": {
    "plan_review": {
      "focus": ["architecture", "feasibility"],
      "depth": "thorough"
    },
    "code_review": {
      "criteria": ["bugs", "security", "performance", "style"],
      "require_tests": true,
      "max_file_size": 500
    },
    "precommit": {
      "auto_diff": true,
      "block_on": ["critical", "major"]
    }
  },
  "project_context": "Your project description and constraints."
}
```

All fields are optional. Missing fields use sensible defaults.

Set `REVIEW_BRIDGE_DB` to customize where review history is stored:

```bash
export REVIEW_BRIDGE_DB=~/.codex-reviews.db
```

Defaults to `reviews.db` in the current directory. Set to `:memory:` for ephemeral storage.

## Troubleshooting

| Error | Fix |
|-------|-----|
| `AUTH_ERROR: No OpenAI API key found` | Run `codex login` to authenticate, or set `OPENAI_API_KEY`. |
| `MODEL_ERROR: Model "X" is not supported` | Try `gpt-5.2-codex` or `gpt-5.3-codex`. Set `"model"` in `.reviewbridge.json`. |
| `NETWORK_ERROR: Could not reach OpenAI API` | Check your internet connection. |
| `RATE_LIMITED: Rate limited by OpenAI` | Wait a moment and retry. |
| `CODEX_TIMEOUT: review timed out` | Increase `"timeout_seconds"` in `.reviewbridge.json` (default: 300). |

## Architecture

```
Terminal / Claude Code ──► codex-claude-bridge ──SDK──► OpenAI Codex
                                    │
                                SQLite DB
                             (review history)
```

Both CLI and MCP modes share the same review engine. The SDK uses your ChatGPT subscription auth or API key — both paths go through the same `@openai/codex-sdk`.

## Development

```bash
git clone https://github.com/AmirShayegh/codex-claude-bridge.git
cd codex-claude-bridge
npm install
npm test
npm run build
```

| Command | Description |
|---------|-------------|
| `npm test` | Run tests (Vitest) |
| `npm run build` | Bundle with tsup |
| `npm run typecheck` | Type checking |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |

## License

[MIT](LICENSE)
