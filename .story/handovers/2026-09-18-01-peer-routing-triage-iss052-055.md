<!-- storybloq-handover v1 -->

# Session Handover — peer routing reports triaged into ISS-052/053/054/055, no code changed

## Worker state

- On `main` at 0d9d868, tree clean apart from the standing untracked files (`.codex/`, `AGENTS.md`, `.story/` additions). **No code was written this session** — no commits, no branch, no edits to `src/`.
- Session id of this worker: `4efde2c7-556c-48ee-bc27-33406cbcfb3b`.
- Work done: triaged two peer field reports (cpm-c6 the CPM storybloq pen, cpm-6c its worker) about Gemini routing on the bridge, verified every claim against the 1.8.0 source, filed four issues, created L-021. Both peer threads are closed; cpm-6c has returned to its own queue.
- Next action agreed with owner: plan ISS-054 first (see "Next session").

## Blocked

- (none)

## Owner rulings

- (none new). Still unruled from prior sessions: the `Claude-Session:` commit trailer conflicts with CLAUDE.md's "no AI tool names in commits" rule. Raised again this session because this session's attribution instructions ask for that exact trailer. No commits were made, so nothing was decided by default.

## Carried forward

- ISS-035 / ISS-018: cross-instance `review_history` lookup by session_id.
- ISS-036 / ISS-022: config read once at spawn from the server's launch directory. Directly implicated in this session's investigation — see the repro probe on ISS-052.
- ISS-037: Gemini conversation ids come from agy's shared cwd cache.
- Six pre-existing prettier-dirty files remain untouched: `codex-binary.ts`, `codex-binary.test.ts`, `sdk-version.test.ts`, `loader.test.ts`, `prompts.test.ts`, `chunking.test.ts`.
- **Owner decision pending, machine-wide:** `~/.reviewbridge.json` is `{"provider":"gemini","fallback":true,"timeout_seconds":1800}` with no `model` key. Every repo on this machine lacking its own `.reviewbridge.json` therefore reviews at Gemini's cheapest tier. Adding `"model": "max"` (or `"balanced"`) closes it today, ahead of any code fix. Owner's file; not touched.

## The investigation (what was actually established)

Reported: reviews silently degrading Gemini Pro -> Flash, attributed by the reporters to a Codex usage cap forcing failover plus a size- or quota-based downgrade rule.

Every OBSERVABLE was accurate. Every MECHANISM claim was wrong. Confirmed chain:

1. `~/.reviewbridge.json` sets `"provider": "gemini"`, so **Gemini was the configured PRIMARY**. Codex was never attempted; no cap was involved; **no failover ever occurred**. `provider: "gemini"` on all eight peer results confirmed it.
2. The caller passed `tier: "max"` on every call. **There is no `tier` parameter** — `grep -rn "tier" src/tools/` returns nothing. The tier selector is a VALUE of `model`. `registerTool`'s inputSchema is a plain Zod shape, so the unknown key was stripped silently, no error. -> ISS-054.
3. With no selector reaching the resolver, `resolveLatestGeminiModel()` returned `GEMINI_DEFAULT_MODEL = 'Gemini 3.8 Flash (Medium)'` — our `fast` tier — while `CODEX_DEFAULT_MODEL = RECOMMENDED_MODELS.codex[0]` is the strongest. -> ISS-052.
4. `review_mode: "failover"` appeared on every response because `stamp()` (composite.ts:77-84) writes it from the CONFIGURED mode, unconditionally. It means "the failover composition is configured", not "a failover occurred". This is what led the reporters to their wrong theory. -> ISS-055.
5. A/B that settled it (cpm-6c): same session, same cwd, `tier: "max"` held constant; adding `model: "max"` flipped Flash -> `Gemini 3.1 Pro (High)` immediately.

Consequence on the reporting side: a plan review went revise/revise on Pro then approve/approve on Flash — the weaker model overturning the stronger one, with nothing in the response saying so except a model label. Not banked, only because the caller was inspecting `models[].observed` every round.

Version/capability inversion worth remembering: in `agy models` the newest version line is Gemini 3.8 Flash, but the most capable model is Gemini 3.1 Pro (High) — a LOWER version number. `pickLatestFlashModel` only scans Flash lines, so a "latest" heuristic can never resolve to Pro.

## Corrections made (mine and theirs)

- **Mine:** told cpm-c6 to check `server_version`. We emit no such field anywhere; its absence proves nothing. Retracted to both sessions.
- **Mine:** filed ISS-052 under the reporters' failover framing. Reframed once the config was confirmed — left as filed, an implementer would have tested the failover path and failed to reproduce. This is the substance of L-021.
- **Theirs (cpm-6c):** "whichever file the server reads, the only one naming a provider says gemini" treats the config lookup as a union. `loader.ts` is FIRST-HIT-WINS: `RB_CONFIG_PATH` -> walk up from `process.cwd()` to the first `.reviewbridge.json`, stopping at a `.git` boundary -> `$HOME/.reviewbridge.json` -> built-in defaults. Exactly one file is ever the config; they never merge. Had the server launched in the bridge repo, that repo's own file would have been the entire config — no `provider` key, so `ProviderSchema.default('codex')` would have made the primary **codex** with `timeout_seconds` 600.
- **Theirs (cpm-c6):** point 1 of the original report (Codex leg dead / everything failed over) withdrawn, along with the failover reading of points 2-4.

## Filed this session

- **ISS-052 [high]** — Gemini's unpinned default is the cheapest tier while Codex's is the strongest; any unpinned Gemini review runs at `fast`. Reframed mid-session; separates the LATENT failover manifestation (code reading only, do not use as the repro) from the CONFIRMED Gemini-as-primary one. Carries a `repro_probe` meta: the `provider` field on a result is the probe for which config file won, so a reproducer must control the server's launch directory, not just the files on disk.
- **ISS-053 [medium]** — no minimum-acceptable-tier gate; `model` is a request, never a floor, so a gate cannot fail closed. Largest of the four (new parameter).
- **ISS-054 [high]** — unknown tool arguments silently stripped, and `TIER_HELP` (embedded in the `model` field's own description) says "pick a tier" while the parameter is named `model`, inviting the exact mistake. Carries an `internal_precedent` meta: `warnUnknownConfigKeys()` in `config/loader.ts` already warns on every stripped CONFIG key "so a stale field surfaces instead of being an invisible no-op" — tool args have no equivalent, so the fix is consistency with an existing in-repo convention, not new policy. Reporter's preferred fix: reject unknown top-level args with an error naming the accepted ones.
- **ISS-055 [medium]** — `review_mode` stamped from configuration rather than events. Note recorded: renaming to `review_composition` is a breaking change to a documented result field (server.ts:73); adding `failover_occurred: false` is additive and should ship first. "single" and "deliberate" describe compositions and read fine; only "failover" reads as an event.
- **L-021** — a field report's observable can be real while its mechanism is wrong; verify in code before filing, and reframe the issue when they diverge.

## Shipped

- (no code shipped — ledger and peer correspondence only)

## Next session

1. **Plan ISS-054 first** (owner-agreed sequencing). Smallest diff, existing in-repo precedent, and it is the one that actually produced a false gate. Open design fork to settle before implementing: hard-reject unknown top-level tool args (reporter's preference) vs. warn-and-echo. Hard rejection changes behavior for any existing caller passing extra keys on a published npm package; check whether any MCP client injects fields of its own. Consider also accepting `tier` as a real alias, and rewording TIER_HELP so the parameter name and the concept name match.
2. Then ISS-055's additive `failover_occurred` boolean (do not rename `review_mode` first).
3. Then ISS-052's default-tier change — a behavior change on a published package, so owner's call on whether Gemini's unpinned default becomes `balanced` (Flash High) or the result merely gains an explicit "this is a fallback default, not your choice" signal.
4. ISS-053 last.
5. TDD is mandatory here (CLAUDE_RULES.md): bug fix = failing test first, colocated `*.test.ts`, mock all external calls.
