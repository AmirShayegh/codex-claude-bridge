# Session Handover: Fix ISS-001 (MODEL_ERROR misclassification)

**Date:** 2026-04-23
**Mode:** Targeted autonomous (single issue)
**Result:** ISS-001 resolved in commit `2f17aa2`. 477/477 tests pass.

## What happened

The freshly installed `codex-claude-bridge@0.3.0` MCP returned `MODEL_ERROR: Model "detail" is not supported` on a smoke-test review at the start of session, confirming ISS-001 is live in the published artifact and not just a theoretical concern. Switched to autonomous targeted mode to fix it.

## Root cause

`src/codex/client.ts:87-93` had two compounding flaws:

1. **Loose predicate.** `lower.includes('model') && (lower.includes('not supported') || lower.includes('not found'))` matched any error blob containing both substrings, regardless of whether they were syntactically related. JSON envelopes like `{"detail": "... model ... not supported ..."}` matched even when the words referred to unrelated things.
2. **Unanchored extractor.** `/["']([^"']+)["']/` grabbed the *first* quoted token anywhere in the raw error. For OpenAI API error envelopes, that token is typically a JSON key like `"detail"`, `"error"`, or `"code"` — never the model name.

Result: real Codex failures were silently rebranded as bogus model errors, hiding the underlying cause and falsely advising users to switch models.

## Fix

Single anchored regex replacing both pieces:

```ts
/\bmodel\b(?:\s+["'`]([^"'`]+)["'`])?\s+(?:is\s+|does\s+)?not\s+(?:supported|found|exist)/i
```

- The "not (supported|found|exist)" phrase must follow `model` directly.
- A quoted name (single, double, or backtick) is captured *only from within the matched span* — never from arbitrary JSON keys elsewhere.
- Backtick support added for OpenAI's markdown-style error formatting.
- "does not exist" added to the verb list (OpenAI's standard model-not-found phrasing).

**Defense in depth:** Raw error text is now appended to the MODEL_ERROR message (`Original error: ${raw}`). Even if a borderline case slips through, the underlying error is no longer fully swallowed.

## Tests added (4)

1. Backtick-quoted name with "does not exist" phrasing.
2. **Exact ISS-001 reproduction** — JSON body with `"detail"` first, plus unrelated "model" + "not supported" downstream. Asserts no `Model "detail"` in output and that the real `Schema validation failed` text survives.
3. Raw-text preservation in MODEL_ERROR message.
4. Negative case: "model" and "not supported" in different sentences must not match.

All 67 client tests pass; full suite 477/477.

## Decisions worth remembering

- **Did not refactor the other classifier branches** (AUTH, RATE_LIMITED, NETWORK). They use substring matching too, but their tokens (`api_key`, `401`, `ECONNREFUSED`, `ENOTFOUND`, `fetch failed`, `rate_limit`) are specific enough that false-positive risk is low. ISS-001 was the only documented complaint; scope-creeping into a generic classifier rewrite was rejected.
- **Did not add the storybloq seed (`.story/config.json`, lessons, handovers, roadmap, tickets) to git.** That decision belongs to ISS-003 (docs/ visibility) and is not part of this fix. Only `.story/issues/ISS-001.json` was committed because it represents the resolution record for the bug being fixed.
- **Did not append the raw error to AUTH/RATE/NETWORK/UNKNOWN messages.** UNKNOWN already preserves it; the others have unambiguous tokens and noise from raw bodies would hurt UX.

## Verification

The live MCP needs a republish before the fix takes effect for end users — the bridge in this session is still running pre-fix `0.3.0` from npm. To re-verify in production: bump version, publish, `claude mcp remove codex-bridge && claude mcp add codex-bridge -- npx -y codex-claude-bridge@latest`, then attempt a `review_code` on a diff containing JSON-envelope-style strings.

## Suggested next session

1. **Publish a 0.3.1 patch** so users on cached 0.3.0 get the fix. Same install instruction as before; the `@latest` pin from commit `5ea2f56` ensures `npx` re-resolves.
2. **T-001 / T-002 (reliability).** Both still open; either order works.
3. **ISS-003.** Decide whether `.story/` (handovers, roadmap, tickets) should be tracked. Worth doing before the next contributor lands.
