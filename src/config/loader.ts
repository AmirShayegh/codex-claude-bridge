import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import {
  ReviewBridgeConfigSchema,
  ReviewStandardsSchema,
  PlanReviewStandardsSchema,
  CodeReviewStandardsSchema,
  PrecommitStandardsSchema,
} from './types.js';
import type { ReviewBridgeConfig } from './types.js';

const CONFIG_FILENAME = '.reviewbridge.json';
const ENV_VAR = 'RB_CONFIG_PATH';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Keys present in `raw` that the schema doesn't recognize. Empty when `raw` isn't
// a plain object, so callers can pass a possibly-missing nested section safely.
function unknownKeys(raw: unknown, known: string[]): string[] {
  return isPlainObject(raw) ? Object.keys(raw).filter((k) => !known.includes(k)) : [];
}

// `${path}:${mtimeMs}` keys already checked for unrecognized keys this
// process lifetime. Config used to load exactly once per process (server
// startup, or one CLI invocation); discoverProjectConfig below makes
// per-call discovery possible from the MCP tool layer, so the SAME on-disk
// file can now be probed many times across many tool calls in one
// long-lived server run — without this, each call would re-emit the
// identical stderr warning. Keying by mtime (not path alone) means a file
// edited mid-process — e.g. someone adds a new typo'd key to a running
// server's .reviewbridge.json — still gets checked and warned about again,
// instead of being silently suppressed forever by the first, now-stale,
// warning. A plain Set is fine here: bounded in practice by the number of
// distinct config files on the machine times how many times each gets
// edited during one server's lifetime, not an unbounded stream. Exported
// ONLY so loader.test.ts can reset it between cases; production code never
// calls resetConfigWarningMemo.
const warnedConfigPaths = new Set<string>();
export function resetConfigWarningMemo(): void {
  warnedConfigPaths.clear();
}

// Warn (never reject) about config keys the schema silently strips, at every
// level — so a stale field like a removed review_standards.code_review.max_file_size
// surfaces instead of being an invisible no-op. STDERR only: the MCP transport's
// JSON-RPC stream is on stdout, so a stdout write would corrupt it. `raw` is
// untrusted JSON.parse output, so every descent is guarded by isPlainObject.
// Checks (and warns for) a given (path, mtime) pair at most once per process
// — see warnedConfigPaths. `mtimeMs` is undefined when it couldn't be
// stat'd (e.g. a race between the successful read and the stat); that
// degrades gracefully to a stable per-path key, matching the simpler
// once-per-path behavior this had before mtime keying.
function warnUnknownConfigKeys(raw: unknown, path: string, mtimeMs: number | undefined): void {
  const memoKey = `${path}:${mtimeMs}`;
  if (warnedConfigPaths.has(memoKey)) return;
  warnedConfigPaths.add(memoKey);
  const warn = (loc: string, keys: string[]): void => {
    if (keys.length > 0) {
      console.error(`[codex-bridge] ignoring unrecognized config field(s) in ${loc} (${path}): ${keys.join(', ')}`);
    }
  };
  if (!isPlainObject(raw)) return;
  warn('<root>', unknownKeys(raw, Object.keys(ReviewBridgeConfigSchema.shape)));
  const rs = raw.review_standards;
  if (!isPlainObject(rs)) return;
  warn('review_standards', unknownKeys(rs, Object.keys(ReviewStandardsSchema.shape)));
  warn('review_standards.plan_review', unknownKeys(rs.plan_review, Object.keys(PlanReviewStandardsSchema.shape)));
  warn('review_standards.code_review', unknownKeys(rs.code_review, Object.keys(CodeReviewStandardsSchema.shape)));
  warn('review_standards.precommit', unknownKeys(rs.precommit, Object.keys(PrecommitStandardsSchema.shape)));
}

export type ConfigSource =
  | { kind: 'env'; path: string }
  | { kind: 'project'; path: string }
  | { kind: 'user'; path: string }
  | { kind: 'default' };

export interface LoadedConfig {
  config: ReviewBridgeConfig;
  source: ConfigSource;
}

type ProbeResult =
  | { hit: false }
  | { hit: true; result: Result<ReviewBridgeConfig> };

// ENOENT only → { hit: false }. Anything else (EACCES, parse, validate)
// returns { hit: true } so the caller stops cascading and surfaces it.
function probe(path: string): ProbeResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e: unknown) {
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { hit: false };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return {
      hit: true,
      result: err(`${ErrorCode.CONFIG_ERROR}: failed to read ${path}: ${msg}`),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      hit: true,
      result: err(`${ErrorCode.CONFIG_ERROR}: invalid JSON in ${path}`),
    };
  }

  const validated = ReviewBridgeConfigSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      hit: true,
      result: err(`${ErrorCode.CONFIG_ERROR}: invalid config in ${path}: ${validated.error.message}`),
    };
  }

  // Best-effort: the mtime only sharpens the warning memo (see
  // warnUnknownConfigKeys). A stat failure here — e.g. the file vanished in
  // the brief window since the successful readFileSync above — must never
  // block returning the config we already successfully parsed.
  let mtimeMs: number | undefined;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    mtimeMs = undefined;
  }

  warnUnknownConfigKeys(parsed, path, mtimeMs);
  return { hit: true, result: ok(validated.data) };
}

function defaultLoaded(): LoadedConfig {
  // Fresh parse — never share the DEFAULT_CONFIG instance across callers.
  return { config: ReviewBridgeConfigSchema.parse({}), source: { kind: 'default' } };
}

function* walkUp(start: string): Iterable<string> {
  let dir = start;
  while (true) {
    yield dir;
    const parent = dirname(dir);
    if (parent === dir) return; // filesystem root
    dir = parent;
  }
}

export function loadConfig(cwd?: string): Result<LoadedConfig> {
  // Explicit mode: caller named the dir. Look only there.
  if (cwd !== undefined) {
    const path = join(cwd, CONFIG_FILENAME);
    const p = probe(path);
    if (!p.hit) return ok(defaultLoaded());
    if (!p.result.ok) return p.result;
    return ok({ config: p.result.data, source: { kind: 'project', path } });
  }

  // Implicit mode cascade.

  // 1. Env var override (strict — ENOENT here is fatal).
  const envPath = process.env[ENV_VAR];
  if (envPath && envPath.length > 0) {
    const p = probe(envPath);
    if (!p.hit) {
      return err(`${ErrorCode.CONFIG_ERROR}: ${ENV_VAR}=${envPath} not found`);
    }
    if (!p.result.ok) return p.result;
    return ok({ config: p.result.data, source: { kind: 'env', path: envPath } });
  }

  // 2. Walk-up from process.cwd() to a .reviewbridge.json or .git boundary.
  for (const dir of walkUp(process.cwd())) {
    const path = join(dir, CONFIG_FILENAME);
    const p = probe(path);
    if (p.hit) {
      if (!p.result.ok) return p.result;
      return ok({ config: p.result.data, source: { kind: 'project', path } });
    }
    if (existsSync(join(dir, '.git'))) break;
  }

  // 3. User-level fallback at $HOME/.reviewbridge.json.
  const userPath = join(homedir(), CONFIG_FILENAME);
  const userProbe = probe(userPath);
  if (userProbe.hit) {
    if (!userProbe.result.ok) return userProbe.result;
    return ok({ config: userProbe.result.data, source: { kind: 'user', path: userPath } });
  }

  // 4. Built-in default.
  return ok(defaultLoaded());
}

// Walk up from an arbitrary starting directory — NOT necessarily
// process.cwd() — looking for `.reviewbridge.json`, stopping at the first hit
// or a `.git` boundary. Same algorithm as loadConfig()'s own implicit-mode
// walk-up (step 2 above), just anchored at a caller-supplied start instead of
// process.cwd(). Used by the MCP tool layer's per-call `cwd` param so a
// config discovered from a NAMED repo behaves the way discovery from the
// server's own launch directory would — including finding a repo-root config
// from a cwd that names a SUBDIRECTORY of that repo, which loadConfig(cwd)'s
// own explicit mode deliberately does NOT do (that single-directory lookup is
// the CLI's `--config <dir>` contract — "look only there" — and is
// unmodified here; do not repurpose it for this).
//
// Returns ok(null) — not a config, not an error — when nothing is found
// anywhere up the tree. Callers decide what "not found" means for them:
// falling back to loadConfig()'s built-in schema defaults here would be
// wrong whenever the server's own boot-time config came from RB_CONFIG_PATH,
// $HOME, or its own launch-directory walk-up — none of which this per-cwd
// walk repeats (they're already reflected in whatever config object the
// caller holds as its own fallback). See review-precommit.ts, the current
// caller, for the actual fallback-to-boot-config policy this enables.
export function discoverProjectConfig(startDir: string): Result<LoadedConfig | null> {
  for (const dir of walkUp(startDir)) {
    const path = join(dir, CONFIG_FILENAME);
    const p = probe(path);
    if (p.hit) {
      if (!p.result.ok) return p.result;
      return ok({ config: p.result.data, source: { kind: 'project', path } });
    }
    if (existsSync(join(dir, '.git'))) break;
  }
  return ok(null);
}

export function formatConfigSource(source: ConfigSource): string {
  return source.kind === 'default' ? 'default' : `${source.kind} (${source.path})`;
}
