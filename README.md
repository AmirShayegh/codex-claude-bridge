# Claude ↔ Codex Review Bridge

MCP server for automated code review. Claude Code writes, Codex reviews.

## Install

```bash
claude mcp add codex-bridge -- npx -y codex-claude-bridge
```

## Prerequisites

- [Claude Code](https://claude.ai/claude-code) installed
- [Codex CLI](https://github.com/openai/codex) installed and authenticated (`OPENAI_API_KEY` set)
- Node.js 18+

## Tools

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
  "model": "o4-mini",
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
