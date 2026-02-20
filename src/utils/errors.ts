export enum ErrorCode {
  CODEX_TIMEOUT = 'CODEX_TIMEOUT',
  CODEX_PARSE_ERROR = 'CODEX_PARSE_ERROR',
  GIT_ERROR = 'GIT_ERROR',
  CONFIG_ERROR = 'CONFIG_ERROR',
  STORAGE_ERROR = 'STORAGE_ERROR',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  AUTH_ERROR = 'AUTH_ERROR',
  MODEL_ERROR = 'MODEL_ERROR',
  RATE_LIMITED = 'RATE_LIMITED',
  NETWORK_ERROR = 'NETWORK_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function err<T>(error: string): Result<T> {
  return { ok: false, error };
}
