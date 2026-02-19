import { ok } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import type { ReviewBridgeConfig } from './types.js';

export function loadConfig(): Result<ReviewBridgeConfig> {
  return ok<ReviewBridgeConfig>({});
}
