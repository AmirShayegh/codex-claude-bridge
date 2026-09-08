# Claude Review Bridge — Codex + Gemini

MCP server for automated code review. Claude Code writes the code; a second model reviews it and structured feedback comes back inline, no copy-pasting between tools. The reviewer is [OpenAI Codex](https://developers.openai.com/codex) by default, or Google Gemini (via the Antigravity `agy` CLI).

**Works with a subscription you already have — $0 marginal cost.** Codex runs on your ChatGPT plan; Gemini runs on your Google AI Pro plan.

**Out of usage on one provider?** When both are set up, the bridge automatically fails over to the other so a review still comes back — see [Provider failover](#provider-failover).

## Quick Start

Add the MCP server to Claude Code (same for every provider):

```bash
claude mcp add codex-bridge -- npx -y codex-claude-bridge@latest
```

Then set up at least one reviewer. **Codex is the default**; set up both and the bridge fails over between them automatically.

### Codex (default) — your ChatGPT subscription

Install the Codex CLI and sign in:

```bash
npm install -g @openai/codex
codex login
```

The SDK reads OAuth tokens from `~/.codex/auth.json` (created by `codex login`); when no `OPENAI_API_KEY` is set it uses your ChatGPT subscription automatically. To pay per token instead, `export OPENAI_API_KEY=sk-...`.

### Gemini — your Google AI Pro subscription

Install the Antigravity (`agy`) CLI, then run it once to sign in with your Google account (AI Pro):

```bash
agy        # first run prompts a Google sign-in
```

Select Gemini with a `.reviewbridge.json` at your project root:

```json
{ "provider": "gemini" }
```

Restart Claude Code after setup. The review tools are now available.

### Prerequisites

- **Node.js 18+** — [nodejs.org](https://nodejs.org/)
- **Claude Code** — [code.claude.com](https://code.claude.com/docs/en/overview)
- **Codex CLI** (Codex path) — `npm install -g @openai/codex`, then `codex login`
- **Antigravity `agy` CLI** (Gemini path) — install it, then run `agy` to sign in (Google AI Pro)

## What You Get

Once set up, Claude Code gains five new tools:

- **`review_plan`** — Send an implementation plan for architectural review. Get a verdict (approve / revise / reject) with specific findings.
- **`review_code`** — Send a code diff for review. Get findings with file and line references.
- **`review_precommit`** — Quick sanity check before committing. Automatically captures your staged git changes.
- **`review_status`** — Check whether a review is still in progress, completed, or failed.
- **`review_history`** — Look up past reviews by session or count.

All successful review calls return structured JSON with `models[]` (the providers/models that
contributed) and `provenance` (whether the result was durably recorded, memory-only, or synthetic).

### Responding-model evidence

Each `models[]` entry reports:

```json
{
  "provider": "codex",
  "role": "review",
  "requested": null,
  "resolved": "gpt-6-astra",
  "observed": "gpt-6-astra",
  "evidence": "runtime_session_record"
}
```

- `requested` is the per-call/config selector considered for the turn. It is `null` for provider
  defaults and Codex resumes where no model override is applied.
- `resolved` is the concrete label selected or retained by the bridge.
- `observed` is a runtime-recorded label when one is available. Codex can read this from its local
  session record; Gemini currently reports `null` because `agy` has no equivalent observation.
- `role` distinguishes normal review turns from deliberate-deep adjudication turns.
- `evidence` says whether identity came from a runtime session record, bridge selection, or was
  unavailable.

This is control-plane evidence about the model labels selected and recorded by the clients. It is
not cryptographic proof of underlying weights or an audit of a provider's internal routing.
`models[]` lists successful contributors, not every provider that received input, so it is not a
data-egress audit.

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

Send an implementation plan for architectural/feasibility review.

| Parameter    | Type                      | Required | Description                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan`       | string                    | yes      | The implementation plan to review                                                                                                                                                                                                                                           |
| `context`    | string                    | no       | Project context and constraints                                                                                                                                                                                                                                             |
| `focus`      | string[]                  | no       | Review focus areas (e.g. `["architecture", "security"]`)                                                                                                                                                                                                                    |
| `depth`      | `"quick"` \| `"thorough"` | no       | Review depth                                                                                                                                                                                                                                                                |
| `session_id` | string                    | no       | Continue from a previous review session                                                                                                                                                                                                                                     |
| `model`      | string                    | no       | Override the model for this call (e.g. `"gpt-5.6-sol"` or `"latest"`). With Codex this can't be combined with `session_id`; the bridge retains the prior resolved identity and reports any different runtime-observed label. Gemini allows changing model on a resumed session. |

Returns: `{ verdict, summary, findings[], session_id, models[], provenance }`

### `review_code`

Send a code diff for code review.

| Parameter    | Type     | Required | Description                                                                                                                                                                                                                                    |
| ------------ | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `diff`       | string   | yes      | Git diff to review                                                                                                                                                                                                                             |
| `context`    | string   | no       | Intent of the changes                                                                                                                                                                                                                          |
| `session_id` | string   | no       | Continue from previous review (e.g. plan review session)                                                                                                                                                                                       |
| `criteria`   | string[] | no       | Review criteria (e.g. `["bugs", "security", "performance"]`)                                                                                                                                                                                   |
| `model`      | string   | no       | Override the model for this call (e.g. `"gpt-5.6-sol"` or `"latest"`). With Codex this can't be combined with `session_id`; compare `resolved` and `observed` to see what the runtime recorded. Gemini allows changing model on a resumed session. |

Returns: `{ verdict, summary, findings[], session_id, models[], provenance }`

Findings include `file` and `line` references when available.

### `review_precommit`

Quick pre-commit sanity check. Auto-captures staged git changes by default.

| Parameter    | Type     | Required | Description                                                                                                                                                                                                                                    |
| ------------ | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto_diff`  | boolean  | no       | Auto-capture `git diff --staged` (default: `true`)                                                                                                                                                                                             |
| `diff`       | string   | no       | Explicit diff instead of auto-capture                                                                                                                                                                                                          |
| `session_id` | string   | no       | Continue from previous review                                                                                                                                                                                                                  |
| `checklist`  | string[] | no       | Custom pre-commit checks                                                                                                                                                                                                                       |
| `model`      | string   | no       | Override the model for this call (e.g. `"gpt-5.6-sol"` or `"latest"`). With Codex this can't be combined with `session_id`; compare `resolved` and `observed` to see what the runtime recorded. Gemini allows changing model on a resumed session. |

Returns: `{ ready_to_commit, blockers[], warnings[], session_id, models[], provenance }`

### `review_status`

Check status of a review session.

| Parameter    | Type   | Required | Description         |
| ------------ | ------ | -------- | ------------------- |
| `session_id` | string | yes      | Session ID to check |

Returns: `{ status, session_id, elapsed_seconds }`

### `review_history`

Query past reviews.

| Parameter    | Type   | Required | Description                                                        |
| ------------ | ------ | -------- | ------------------------------------------------------------------ |
| `session_id` | string | no       | Query reviews for a specific session                               |
| `last_n`     | number | no       | Return 1–100 reviews (default: 10 recent; 100 for a session)       |
| `cursor`     | string | no       | Decimal row cursor returned as `next_cursor` by the preceding page |

Returns: `{ reviews[], next_cursor }`. Recent pages are newest-first; session pages are oldest-first.
Each entry includes `models` plus `model_metadata_status` (`recorded`, `legacy_unrecorded`, or
`invalid`). Legacy rows are never backfilled from today's defaults, and malformed stored metadata
is returned as `models: null`.

## Configuration

Create `.reviewbridge.json` in your project root to customize review behavior:

```json
{
  "provider": "codex",
  "fallback": true,
  "model": "gpt-6-astra",
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
      "require_tests": true
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

- **`provider`** — `"codex"` (default) or `"gemini"`. Selects which backend reviews.
- **`mode`** — `"failover"` (default), `"single"`, `"deliberate"`, or `"deliberate-deep"`. Picks how the two providers combine; see [Provider failover](#provider-failover) and [Deliberation](#deliberation). When unset it's derived from `fallback`.
- **`fallback`** — `true` (default) auto-fails-over to the other provider when the configured one is out of usage or unavailable. Set `false` (equivalently `"mode": "single"`) for strict single-provider behavior.
- **`reasoning_effort`** — Codex only. Gemini's effort is baked into its model name (e.g. `"Gemini 3.5 Flash (High)"`), so the field is ignored for Gemini.
- **`codex_path`** — absolute path to a codex binary for the Codex SDK to spawn (the `CODEX_PATH` env var works too; the config field wins). Normally unnecessary: when unset, the SDK uses its own bundled binary, and if that binary can't run the bridge **auto-discovers** a working system codex from your PATH and the usual install locations (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`), retries, and logs the substitution on stderr. Set it explicitly to pin a specific binary — an explicit path disables auto-discovery entirely.

### Where the config is discovered

When the MCP server or CLI starts, it looks for `.reviewbridge.json` in this order. The first match wins; nothing is merged.

1. **`RB_CONFIG_PATH` env var** — if set, load exactly that file. Useful when the bridge is launched from a directory that isn't your project (e.g. an MCP host launches it from your home dir). Missing or unreadable file is a hard startup error so typos are surfaced immediately, not silently ignored.
2. **Walk-up from the working directory** — looks for `.reviewbridge.json` in the current directory, then each parent. The walk stops at the first `.git` boundary so a project nested inside an unrelated git repo doesn't accidentally inherit a parent project's config.
3. **`$HOME/.reviewbridge.json`** — a per-machine default. Drop one here to pin a model (e.g. `{"model": "gpt-5.6-sol"}`) for every project on the box without having to touch each one.
4. **Built-in defaults** — what you get if nothing is found anywhere.

A startup log line on stderr names the source (`[codex-bridge] config source: project (/repo/.reviewbridge.json)`) so you can confirm which file is in effect.

The CLI's `--config <dir>` flag is an explicit override: it looks only at `<dir>/.reviewbridge.json` and skips the cascade entirely (env vars and `$HOME` are not consulted in that mode).

> **Selected files must parse cleanly.** Once a `.reviewbridge.json` is found, malformed JSON or schema-invalid values abort startup. The walk-up does **not** silently skip past a broken file to the next candidate — that would hide your typo and leave you running on defaults.

### Model selection

`model` takes a concrete id, `"latest"`, or a **tier**; each provider resolves its own default when the field is unset.

**Tiers** let a caller pick by difficulty or urgency instead of tracking model ids. Each provider maps a tier to its own model, and the tier carries across provider failover:

| Tier       | Pick it for                                                                   | Codex         | Gemini                      |
| ---------- | ----------------------------------------------------------------------------- | ------------- | --------------------------- |
| `max`      | Hardest problems: architecture, concurrency, security, subtle bugs            | `gpt-6-astra` | `Gemini 3.1 Pro (High)`     |
| `balanced` | Everyday code and plan review                                                 | `gpt-5.6-sol` | `Gemini 3.5 Flash (High)`   |
| `fast`     | Small diffs, precommit sanity checks, style passes, quick iteration loops     | `gpt-5.6-luna`| `Gemini 3.5 Flash (Medium)` |

Rule of thumb for an agent: `fast` for a precommit check or a diff under a few hundred lines with no cross-file logic, `max` when the plan or diff touches concurrency, auth, data integrity, or a design you are unsure about, `balanced` otherwise. The tier name is reported back as `requested` in `models`, with the concrete id in `resolved`.

**Codex** — default `gpt-6-astra`. If Astra has not reached your account yet, pin `gpt-5.6-sol`:

| Model         | Description                                                              |
| ------------- | ------------------------------------------------------------------------ |
| `gpt-6-astra` | Latest flagship agentic coding model (default)                           |
| `gpt-5.6-sol` | Previous flagship. Use while Astra is still rolling out to your account. |
| `gpt-5.6-luna`| Cheap and fast line (the `fast` tier).                                   |

**Gemini** — default resolves to the latest Flash via `agy models`. Effort is part of the model name:

| Model                       | Description                |
| --------------------------- | -------------------------- |
| `Gemini 3.5 Flash (Medium)` | Default — fast review line |
| `Gemini 3.5 Flash (High)`   | Higher effort              |
| `Gemini 3.1 Pro (High)`     | Heavier reasoning line     |

`"latest"` resolves to the newest Flash for Gemini, or the SDK-pinned flagship for Codex. These are the models we document and recommend; the `model` field, the `model` tool parameter, and the `--model` CLI flag accept any trimmed, control-free selector up to 200 characters, so you can run others. For Gemini, an unrecognized model triggers a non-blocking stderr warning (agy may silently run a different one) — run `agy models` to see the live list.

### Provider failover

When `fallback` is on (the default) and both providers are set up, a review that fails because the configured provider is **out of usage or unavailable** (rate-limited / usage cap, model not available on your tier, or not signed in) is automatically retried on the other provider. You'll see a one-line note on stderr:

```
[codex-bridge] codex unavailable (RATE_LIMITED); falling back to gemini
```

The result is tagged with the provider that actually served it (`"provider": "gemini"`). Notes:

- **Fresh reviews only.** A resumed session lives in one provider's conversation store, so a `session_id` review is not failed over — start a fresh review on the other provider to continue.
- **Data egress.** Failover can send your diff to the other vendor (e.g. OpenAI → Google) when the primary is down. Set `"fallback": false` to disable this (also good for CI determinism).
- Failover never triggers on a bad diff or a malformed model response — only on genuine provider-unavailability.

### Deliberation

`"mode": "deliberate"` sends `review_plan` and `review_code` to **both** providers independently, then returns where they **agree** vs **diverge** so the caller (Claude Code) can synthesize. Findings both providers flag are high-confidence; findings only one flags need a judgment call.

```json
{ "provider": "codex", "mode": "deliberate" }
```

The result keeps the usual shape (a merged `verdict`/`findings`, worst-verdict wins) plus an additive `deliberation` block:

```json
{
  "verdict": "reject",
  "findings": [
    /* deduped union of both providers */
  ],
  "deliberation": {
    "providers": ["codex", "gemini"],
    "verdicts": [
      { "provider": "codex", "verdict": "request_changes" },
      { "provider": "gemini", "verdict": "reject" }
    ],
    "agreement": "conflict", // agree | mixed | conflict
    "agreed": [
      /* findings BOTH flagged — high confidence */
    ],
    "divergent": [
      {
        "provider": "gemini",
        "finding": {
          /* only one flagged */
        }
      }
    ]
  }
}
```

Notes:

- **Cost/egress:** deliberation always runs both providers and sends the diff to both vendors — best for high-stakes reviews, not every precommit. `review_precommit` stays failover under this mode.
- **Degrades gracefully:** if one provider is out of usage, you get the other's review with `deliberation.degraded` set and `deliberation.agreement: "degraded"` (it subsumes failover).
- **Resumed sessions deliberate too:** passing a `session_id` resumes the review on the provider that owns that session while the _other_ provider reviews fresh, then the two are combined — so plan→code lifecycles keep deliberating instead of silently dropping to one provider. The combined result keeps the resumed session's id.
- **Per-call toggle:** `review_plan`/`review_code` accept a `deliberate` boolean (CLI: `--deliberate` / `--no-deliberate`) that overrides the configured mode for a single call — `true` forces deliberation, `false` forces single-provider failover. Requesting `deliberate: true` under `"mode": "single"` returns an error (no second provider).
- **`review_mode` on every result:** every review result carries a `review_mode` field (`single` / `failover` / `deliberate` / `deliberate-deep`) naming the composition that actually ran, so the absence of a `deliberation` block is never ambiguous.

### Deliberate-deep (cross-review round)

`"mode": "deliberate-deep"` is deliberation plus one more step: after both providers review, each **divergent** finding (one only one provider flagged) is handed to the **other** provider to adjudicate — confirm it's a real issue, dispute it as a false positive, or mark it unsure. Because providers word findings differently and cite different line numbers, semantically-identical issues often land in `divergent` rather than `agreed`; the cross-review round tells you which of those one-sided findings the other provider actually stands behind.

```json
{ "provider": "codex", "mode": "deliberate-deep" }
```

Each divergent item gains an optional `adjudication` (the `agreed` findings and top-level shape are unchanged):

```json
"divergent": [
  {
    "provider": "codex",
    "finding": { "severity": "major", "category": "Null safety", "file": "src/auth.ts", "line": 5, "description": "…" },
    "adjudication": { "by": "gemini", "verdict": "confirmed", "reason": "returns undefined for a header with no space" }
  }
]
```

Notes:

- **`verdict`** is `confirmed` (a real issue), `disputed` (a false positive here), or `unsure` (can't tell from the change). `by` is the provider that adjudicated — always the one that did _not_ raise the finding.
- **Top-level `verdict` is not folded back:** under deliberate-deep the result's `verdict` still reflects both providers' _independent_ reviews (worst-of-both). The per-finding `adjudication`s are advisory input for **your** synthesis — the bridge does not recompute the verdict from them (ISS-015). A `reject` resting on findings the other provider `disputed` still reports `reject`; it's up to you to weigh the adjudications.
- **Cost:** adds up to two more provider calls per review (one per side that has divergent findings). Skipped entirely when there's nothing divergent. The cross-review subject is sliced to just the files the divergent findings touch, so it stays small even on large diffs.
- **Best-effort:** if a provider is out of usage or errors during the cross-review round, its side is simply left un-adjudicated and reported in `deliberation.cross_review_failures` — the deliberation result still returns.

## Storage

Set `REVIEW_BRIDGE_DB` to persist review history and session state:

```bash
export REVIEW_BRIDGE_DB=~/.review-bridge.db
```

Defaults to `reviews.db` in the current directory. Set to `:memory:` for ephemeral storage.

Review execution is admitted before large inputs enter a provider: at most four logical reviews may
run globally and only one may run for a given `session_id`. Excess work returns `REVIEW_BUSY`
immediately. If durable outcome recording fails after a provider succeeds, the successful review is
still returned with `provenance.persistence: "memory_only"` and a sanitized warning. Synthetic
no-change/no-staged results use `not_recorded` and do not create or mutate sessions.

## Troubleshooting

Error codes are provider-neutral. With `fallback` on (default), many of these auto-recover by retrying on the other provider — the messages below apply when there's no second provider set up or `fallback` is off.

| Error                                                     | Fix                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_ERROR` (Codex)                                      | Run `codex login`, or set `OPENAI_API_KEY`. Check that `~/.codex/auth.json` exists.                                                                                                                                                                                                                                                                                         |
| `AUTH_ERROR: agy is not authenticated` (Gemini)           | Run `agy` once to sign in with your Google account (AI Pro), then retry.                                                                                                                                                                                                                                                                                                    |
| `CONFIG_ERROR: 'agy' ... not found on PATH` (Gemini)      | Install the Antigravity `agy` CLI and sign in, or set `"provider": "codex"`.                                                                                                                                                                                                                                                                                                |
| `MODEL_ERROR: Model "X" is not supported`                 | Try a different model, switch `"provider"`, or (Codex) use API-key auth. For Gemini, run `agy models` for valid ids.                                                                                                                                                                                                                                                        |
| `PROVIDER_UNAVAILABLE: The codex binary could not be run` | On macOS, XProtect can false-positively quarantine the SDK's **bundled** codex binary. The bridge auto-discovers a working system codex (PATH, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`) and retries; the stderr log names the binary it picked. If nothing is found, install the Codex CLI (`codex login` machine) or set `"codex_path"` to a working binary. |
| `RATE_LIMITED` (rate limit or usage cap)                  | Wait and retry, or rely on failover to the other provider.                                                                                                                                                                                                                                                                                                                  |
| `NETWORK_ERROR`                                           | Check your internet connection.                                                                                                                                                                                                                                                                                                                                             |
| `PROVIDER_MISMATCH`                                       | The `session_id` was created by a different provider. Start a new session, or switch `"provider"` back to continue it.                                                                                                                                                                                                                                                      |
| `REVIEW_BUSY`                                             | Four reviews are already active, or this session already has a review in progress. Retry after the active call finishes.                                                                                                                                                                                                                                                    |
| `SESSION_ROUTING_UNAVAILABLE`                             | Resume ownership could not be read safely. Restore durable storage or start a fresh review without `session_id`; the bridge will not guess a provider.                                                                                                                                                                                                                      |
| `REVIEW_TIMEOUT: review timed out`                        | Increase `"timeout_seconds"` in `.reviewbridge.json` (default: 300).                                                                                                                                                                                                                                                                                                        |

## Architecture

```
                                  ┌─ @openai/codex-sdk ──► OpenAI Codex
Claude Code ──MCP/CLI──► bridge ──┤
                          │       └─ agy subprocess ─────► Google Gemini
                      SQLite DB
                    (review history)
```

Both providers sit behind one `ReviewBackend` seam. Codex uses `@openai/codex-sdk` (which spawns `codex exec` internally; ChatGPT and API-key auth share the same path); Gemini wraps the `agy --print --sandbox` subprocess. A failover decorator wraps the two so an out-of-usage primary retries on the other.

```
src/
  index.ts          → Entry point (routes to MCP or CLI)
  mcp.ts            → MCP server startup
  server.ts         → Server setup, tool registration
  cli/              → Standalone CLI (Commander.js)
  tools/            → MCP tool handlers (5 tools)
  backends/         → Provider backends behind one seam: codex, gemini (agy),
                      a shared orchestrator, and the failover decorator
  codex/            → Prompts, Zod response schemas, shared types
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

| Command             | Description        |
| ------------------- | ------------------ |
| `npm test`          | Run tests (Vitest) |
| `npm run build`     | Bundle with tsup   |
| `npm run typecheck` | Type checking      |
| `npm run lint`      | ESLint             |
| `npm run format`    | Prettier           |

## License

MIT
