# Claude ↔ Codex Review Bridge

MCP server for automated code review. Claude Code writes the code, [OpenAI Codex](https://developers.openai.com/codex) reviews it — structured feedback comes back inline, no copy-pasting between tools.

**Works with your ChatGPT subscription — no API costs.**

## Quick Start

### Free (ChatGPT subscription)

Install the Codex CLI and sign in with your ChatGPT account:

```bash
npm install -g @openai/codex
codex login
```

Then add the MCP server to Claude Code:

```bash
claude mcp add codex-bridge -- npx -y codex-claude-bridge
```

### API key (pay per token)

Set your API key:

```bash
export OPENAI_API_KEY=sk-...
```

Then add the MCP server to Claude Code:

```bash
claude mcp add codex-bridge -- npx -y codex-claude-bridge
```

Restart Claude Code after setup. The review tools are now available.

### How auth works

The SDK reads OAuth tokens from `~/.codex/auth.json` (created by `codex login`). When no `OPENAI_API_KEY` is set, it uses your ChatGPT subscription automatically.

### Prerequisites

- **Node.js 18+** — [nodejs.org](https://nodejs.org/)
- **Claude Code** — [code.claude.com](https://code.claude.com/docs/en/overview)
- **Codex CLI** (free path only) — installed via `npm install -g @openai/codex`

## What You Get

Once set up, Claude Code gains five new tools:

- **`review_plan`** — Send an implementation plan for architectural review. Get a verdict (approve / revise / reject) with specific findings.
- **`review_code`** — Send a code diff for review. Get findings with file and line references.
- **`review_precommit`** — Quick sanity check before committing. Automatically captures your staged git changes.
- **`review_status`** — Check whether a review is still in progress, completed, or failed.
- **`review_history`** — Look up past reviews by session or count.

All tools return structured JSON that Claude Code can act on directly.

## Usage (MCP)

In Claude Code, just describe what you want reviewed. Claude Code will pick the right tool:

**Plan review:**
> "Review this implementation plan before I start coding."
> "Check my plan for security issues and scalability risks."

**Code review:**
> "Review the changes I just made." (Claude Code runs `git diff` and passes it)
> "Review this diff for bugs and security issues."

**Pre-commit check:**
> "Run a pre-commit check on my staged changes."
> "Check if these changes are safe to commit."

**Session continuity** — pass the `session_id` from a plan review into a code review to maintain context across the full review lifecycle.

## Standalone CLI

Run reviews directly from the terminal — no MCP setup required.

**Pre-commit check (auto-captures staged changes):**

```bash
npx codex-claude-bridge review-precommit
```

**Block commits on issues (CI-friendly, exits 2 on blockers):**

```bash
npx codex-claude-bridge review-precommit && git commit
```

**Review a plan:**

```bash
npx codex-claude-bridge review-plan --plan plan.md
```

**Review a diff:**

```bash
git diff main | npx codex-claude-bridge review-code --diff -
```

Add `--json` to any command for raw JSON output. Use `--help` to see all options.

## Tools Reference

### `review_plan`

Send an implementation plan to Codex for architectural/feasibility review.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `plan` | string | yes | The implementation plan to review |
| `context` | string | no | Project context and constraints |
| `focus` | string[] | no | Review focus areas (e.g. `["architecture", "security"]`) |
| `depth` | `"quick"` \| `"thorough"` | no | Review depth |
| `session_id` | string | no | Continue from a previous review session |

Returns: `{ verdict, summary, findings[], session_id }`

### `review_code`

Send a code diff to Codex for code review.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `diff` | string | yes | Git diff to review |
| `context` | string | no | Intent of the changes |
| `session_id` | string | no | Continue from previous review (e.g. plan review session) |
| `criteria` | string[] | no | Review criteria (e.g. `["bugs", "security", "performance"]`) |

Returns: `{ verdict, summary, findings[], session_id }`

Findings include `file` and `line` references when available.

### `review_precommit`

Quick pre-commit sanity check. Auto-captures staged git changes by default.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `auto_diff` | boolean | no | Auto-capture `git diff --staged` (default: `true`) |
| `diff` | string | no | Explicit diff instead of auto-capture |
| `session_id` | string | no | Continue from previous review |
| `checklist` | string[] | no | Custom pre-commit checks |

Returns: `{ ready_to_commit, blockers[], warnings[], session_id }`

### `review_status`

Check status of a review session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | yes | Session ID to check |

Returns: `{ status, session_id, elapsed_seconds }`

### `review_history`

Query past reviews.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_id` | string | no | Query reviews for a specific session |
| `last_n` | number | no | Return last N reviews (default: 10) |

Returns: `{ reviews[] }` with `session_id`, `type`, `verdict`, `summary`, `timestamp` per entry.

## Configuration

Create `.reviewbridge.json` in your project root to customize review behavior:

```json
{
  "model": "gpt-5.2-codex",
  "reasoning_effort": "medium",
  "timeout_seconds": 300,
  "max_chunk_tokens": 8000,
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

All fields are optional. Missing fields use the defaults shown above. Large diffs are automatically split into chunks of approximately `max_chunk_tokens` tokens and reviewed sequentially.

**Model options:** The default is `gpt-5.2-codex`. You can also use `gpt-5.3-codex` or other models supported by your account.

## Storage

Set `REVIEW_BRIDGE_DB` to persist review history and session state:

```bash
export REVIEW_BRIDGE_DB=~/.codex-reviews.db
```

Defaults to `reviews.db` in the current directory. Set to `:memory:` for ephemeral storage.

## Troubleshooting

| Error | Fix |
|-------|-----|
| `AUTH_ERROR: No OpenAI API key found` | Run `codex login` to authenticate, or set `OPENAI_API_KEY`. Check that `~/.codex/auth.json` exists. |
| `MODEL_ERROR: Model "X" is not supported` | Try `gpt-5.2-codex` or `gpt-5.3-codex`. Set `"model"` in `.reviewbridge.json`. |
| `NETWORK_ERROR: Could not reach OpenAI API` | Check your internet connection. |
| `RATE_LIMITED: Rate limited by OpenAI` | Wait a moment and retry. |
| `CODEX_TIMEOUT: review timed out` | Increase `"timeout_seconds"` in `.reviewbridge.json` (default: 300). |

## Architecture

```
Claude Code ──MCP──► codex-claude-bridge ──SDK──► OpenAI Codex
                            │
                        SQLite DB
                     (review history)
```

The SDK (`@openai/codex-sdk`) internally spawns `codex exec` as a subprocess — there is no separate "CLI mode." Both ChatGPT subscription auth and API key auth use the same SDK path.

```
src/
  index.ts          → Entry point (routes to MCP or CLI)
  mcp.ts            → MCP server startup
  server.ts         → Server setup, tool registration
  cli/              → Standalone CLI (Commander.js)
  tools/            → MCP tool handlers (5 tools)
  codex/            → Codex SDK wrapper, prompts, types
  config/           → .reviewbridge.json loader
  storage/          → SQLite persistence (reviews, sessions)
  utils/            → Git diff, chunking, error types
```

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

MIT
