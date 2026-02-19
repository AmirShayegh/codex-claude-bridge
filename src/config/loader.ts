import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import { ReviewBridgeConfigSchema } from './types.js';
import type { ReviewBridgeConfig } from './types.js';

const CONFIG_FILENAME = '.reviewbridge.json';

export function loadConfig(cwd?: string): Result<ReviewBridgeConfig> {
  const configPath = join(cwd ?? process.cwd(), CONFIG_FILENAME);

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (e: unknown) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
      return ok(ReviewBridgeConfigSchema.parse({}));
    }
    const msg = e instanceof Error ? e.message : String(e);
    return err(`${ErrorCode.CONFIG_ERROR}: failed to read ${CONFIG_FILENAME}: ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err(`${ErrorCode.CONFIG_ERROR}: invalid JSON in ${CONFIG_FILENAME}`);
  }

  const result = ReviewBridgeConfigSchema.safeParse(parsed);
  if (!result.success) {
    return err(`${ErrorCode.CONFIG_ERROR}: ${result.error.message}`);
  }

  return ok(result.data);
}
