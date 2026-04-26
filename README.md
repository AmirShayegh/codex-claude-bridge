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
claude mcp add codex-bridge -- npx -y codex-claude-bridge@latest
```

### API key (pay per token)

Set your API key:

```bash
export OPENAI_API_KEY=sk-...
```

Then add the MCP server to Claude Code:

```bash
claude mcp add codex-bridge -- npx -y codex-claude-bridge@latest
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
npx codex-claude-bridge@latest review-precommit
```

**Block commits on issues (CI-friendly, exits 2 on blockers):**

```bash
npx codex-claude-bridge@latest review-precommit && git commit
```

**Review a plan:**

```bash
npx codex-claude-bridge@latest review-plan --plan plan.md
```

**Review a diff:**

```bash
git diff main | npx codex-claude-bridge@latest review-code --diff -
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
| `model` | string | no | Override the configured default model for this call (e.g. `"gpt-5.4"`). Incompatible with `session_id`. |

Returns: `{ verdict, summary, findings[], session_id }`

### `review_code`

Send a code diff to Codex for code review.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `diff` | string | yes | Git diff to review |
| `context` | string | no | Intent of the changes |
| `session_id` | string | no | Continue from previous review (e.g. plan review session) |
| `criteria` | string[] | no | Review criteria (e.g. `["bugs", "security", "performance"]`) |
| `model` | string | no | Override the configured default model for this call (e.g. `"gpt-5.4"`). Incompatible with `session_id`. |

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
| `model` | string | no | Override the configured default model for this call (e.g. `"gpt-5.4"`). Incompatible with `session_id`. |

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
  "model": "gpt-5.5",
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

### Where the config is discovered

When the MCP server or CLI starts, it looks for `.reviewbridge.json` in this order. The first match wins; nothing is merged.

1. **`RB_CONFIG_PATH` env var** — if set, load exactly that file. Useful when the bridge is launched from a directory that isn't your project (e.g. an MCP host launches it from your home dir). Missing or unreadable file is a hard startup error so typos are surfaced immediately, not silently ignored.
2. **Walk-up from the working directory** — looks for `.reviewbridge.json` in the current directory, then each parent. The walk stops at the first `.git` boundary so a project nested inside an unrelated git repo doesn't accidentally inherit a parent project's config.
3. **`$HOME/.reviewbridge.json`** — a per-machine default. Drop one here to pin a model (e.g. `{"model": "gpt-5.4"}`) for every project on the box without having to touch each one.
4. **Built-in defaults** — what you get if nothing is found anywhere.

A startup log line on stderr names the source (`[codex-bridge] config source: project (/repo/.reviewbridge.json)`) so you can confirm which file is in effect.

The CLI's `--config <dir>` flag is an explicit override: it looks only at `<dir>/.reviewbridge.json` and skips the cascade entirely (env vars and `$HOME` are not consulted in that mode).

> **Selected files must parse cleanly.** Once a `.reviewbridge.json` is found, malformed JSON or schema-invalid values abort startup. The walk-up does **not** silently skip past a broken file to the next candidate — that would hide your typo and leave you running on defaults.

### Model selection

The default model is `gpt-5.5`. When the ChatGPT-subscription tier of Codex doesn't yet have a newly-announced flagship, fall back to `gpt-5.4` via `.reviewbridge.json`:

```json
{
  "model": "gpt-5.4"
}
```

| Model | Description |
|-------|-------------|
| `gpt-5.5` | Flagship frontier model (default) — 400K context in Codex |
| `gpt-5.4` | Previous flagship. Use when `gpt-5.5` isn't yet available on your account tier. |

These are the models we document and recommend — the flagship plus one fallback. The `model` field in `.reviewbridge.json`, the `model` tool parameter, and the `--model` CLI flag all accept any string and forward it to Codex as-is, so if you want to run a different model you can. We just don't advertise anything outside the table above.

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
| `MODEL_ERROR: Model "X" is not supported` | Try `gpt-5.5` or `gpt-5.4`. Set `"model"` in `.reviewbridge.json`. |
| `MODEL_ERROR: ... when using Codex with a ChatGPT account` | The model is still rolling out to ChatGPT-tier Codex. Set `"model": "gpt-5.4"` in `.reviewbridge.json`, or switch to API-key auth via `OPENAI_API_KEY`. |
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
