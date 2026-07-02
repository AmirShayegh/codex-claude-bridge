import { existsSync, readFileSync } from 'node:fs';
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

// Warn (never reject) about config keys the schema silently strips, at every
// level — so a stale field like a removed review_standards.code_review.max_file_size
// surfaces instead of being an invisible no-op. STDERR only: the MCP transport's
// JSON-RPC stream is on stdout, so a stdout write would corrupt it. `raw` is
// untrusted JSON.parse output, so every descent is guarded by isPlainObject.
function warnUnknownConfigKeys(raw: unknown, path: string): void {
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

  warnUnknownConfigKeys(parsed, path);
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

export function formatConfigSource(source: ConfigSource): string {
  return source.kind === 'default' ? 'default' : `${source.kind} (${source.path})`;
}
