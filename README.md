# Claude ↔ Codex Review Bridge

MCP server for automated code review. Claude Code writes the code, [OpenAI Codex](https://developers.openai.com/codex) reviews it — structured feedback comes back inline, no copy-pasting between tools.

## Setup

1. **Install Node.js 18+** — download from [nodejs.org](https://nodejs.org/)

2. **Install Claude Code** — follow the guide at [code.claude.com](https://code.claude.com/docs/en/overview)

3. **Get an OpenAI API key** — create one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys), then set it in your terminal:

   ```bash
   export OPENAI_API_KEY=your-key-here
   ```

4. **Add the bridge to Claude Code:**

   ```bash
   claude mcp add codex-bridge -- npx -y codex-claude-bridge
   ```

5. **Restart Claude Code** — the review tools are now available.

## What You Get

Once set up, Claude Code gains five new tools:

- **`review_plan`** — Send an implementation plan for architectural review. Get a verdict (approve / revise / reject) with specific findings.
- **`review_code`** — Send a code diff for review. Get findings with file and line references.
- **`review_precommit`** — Quick sanity check before committing. Automatically captures your staged git changes.
- **`review_status`** — Check whether a review is still in progress, completed, or failed.
- **`review_history`** — Look up past reviews by session or count.

All tools return structured JSON that Claude Code can act on directly.

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

All fields are optional. Missing fields use the defaults shown above.

## Storage

Set `REVIEW_BRIDGE_DB` to persist review history and session state:

```bash
export REVIEW_BRIDGE_DB=~/.codex-reviews.db
```

Defaults to `reviews.db` in the current directory. Set to `:memory:` for ephemeral storage.

## Architecture

```
Claude Code ──MCP──► codex-claude-bridge ──SDK──► OpenAI Codex
                            │
                        SQLite DB
                     (review history)
```

```
src/
  index.ts          → Entry point (stdio transport)
  server.ts         → Server setup, tool registration
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
