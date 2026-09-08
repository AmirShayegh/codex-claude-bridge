export enum ErrorCode {
  REVIEW_TIMEOUT = 'REVIEW_TIMEOUT',
  RESPONSE_PARSE_ERROR = 'RESPONSE_PARSE_ERROR',
  GIT_ERROR = 'GIT_ERROR',
  CONFIG_ERROR = 'CONFIG_ERROR',
  STORAGE_ERROR = 'STORAGE_ERROR',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  PROVIDER_MISMATCH = 'PROVIDER_MISMATCH',
  AUTH_ERROR = 'AUTH_ERROR',
  MODEL_ERROR = 'MODEL_ERROR',
  RATE_LIMITED = 'RATE_LIMITED',
  NETWORK_ERROR = 'NETWORK_ERROR',
  // The provider's binary/process couldn't run at all — missing, killed, or
  // quarantined (e.g. macOS XProtect trashing the codex binary). Distinct from a
  // model/auth/rate error: the provider never started, so it's failover-eligible.
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  REVIEW_BUSY = 'REVIEW_BUSY',
  SESSION_ROUTING_UNAVAILABLE = 'SESSION_ROUTING_UNAVAILABLE',
  INVALID_INPUT = 'INVALID_INPUT',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; session_id?: string };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

// session_id flows back on partial-chunk failures so the tool layer can
// mark the orphaned Codex thread's session as failed (T-001).
export function err<T>(error: string, session_id?: string): Result<T> {
  return session_id ? { ok: false, error, session_id } : { ok: false, error };
}
