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
  INVALID_INPUT = 'INVALID_INPUT',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; session_id?: string };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

// session_id flows back on partial-chunk failures so the tool layer can
// mark the orphaned Codex thread's session as failed (T-001).
export function err<T>(error: string, session_id?: string): Result<T> {
  return session_id ? { ok: false, error, session_id } : { ok: false, error };
}
