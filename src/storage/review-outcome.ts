import type Database from 'better-sqlite3';
import { ModelIdentitySchema } from '../review/types.js';
import type { ModelIdentity } from '../review/types.js';
import { err, ErrorCode, ok } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';
import { saveReview } from './reviews.js';
import type { SaveReviewInput } from './reviews.js';
import { parseSessionModelIdentityJson } from './sessions.js';
import { toReviewProvider } from '../config/types.js';
import type { ReviewProvider } from '../config/types.js';

export interface RecordReviewOutcomeInput {
  preflightSessionId?: string;
  preflightProvider?: ReviewProvider;
  resultSessionId: string;
  servingProvider: ReviewProvider;
  ownerModelIdentity?: unknown;
  review: SaveReviewInput;
}

export interface RecordReviewRetryOptions {
  sleep?: (milliseconds: number) => Promise<void>;
}

export const BUSY_RETRY_DELAY_MS = 25;

function parseIdentity(value: unknown): ModelIdentity | null {
  const parsed = ModelIdentitySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function evidenceRank(evidence: ModelIdentity['evidence']): number {
  switch (evidence) {
    case 'runtime_session_record':
      return 2;
    case 'bridge_selection':
      return 1;
    case 'unavailable':
      return 0;
  }
}

function mergeOwnerIdentity(
  existingJson: string | null,
  incoming: ModelIdentity | null,
  servingProvider: ReviewProvider,
): string | null {
  const existingState = parseSessionModelIdentityJson(existingJson, servingProvider);
  if (!incoming) return existingState.status === 'recorded' ? existingJson : null;
  if (existingState.status !== 'recorded') return JSON.stringify(incoming);
  const existing = existingState.model;

  // Gemini applies a model each call, so its latest successful identity owns
  // the conversation even when observed remains honestly null.
  if (incoming.provider === 'gemini') return JSON.stringify(incoming);

  const evidence =
    evidenceRank(incoming.evidence) >= evidenceRank(existing.evidence)
      ? incoming.evidence
      : existing.evidence;
  return JSON.stringify({
    provider: incoming.provider,
    role: incoming.role,
    requested: incoming.requested ?? existing.requested,
    resolved: incoming.resolved ?? existing.resolved,
    observed: incoming.observed ?? existing.observed,
    evidence,
  } satisfies ModelIdentity);
}

function storageError(error: unknown): string {
  if (error instanceof Error) {
    for (const code of [ErrorCode.STORAGE_ERROR, ErrorCode.SESSION_ROUTING_UNAVAILABLE]) {
      if (error.message.startsWith(`${code}:`)) return error.message;
    }
  }
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? `${error.code}: `
      : '';
  const message = error instanceof Error ? error.message : String(error);
  return `${ErrorCode.STORAGE_ERROR}: ${code}${message}`;
}

function requireOk(result: Result<unknown>): void {
  if (!result.ok) throw new Error(result.error);
}

function storageInvariant(message: string): never {
  throw new Error(`${ErrorCode.STORAGE_ERROR}: ${message}`);
}

function routingInvariant(message: string): never {
  throw new Error(`${ErrorCode.SESSION_ROUTING_UNAVAILABLE}: ${message}`);
}

function validateServingProvider(value: string): ReviewProvider {
  const provider = toReviewProvider(value);
  if (!provider) storageInvariant('invalid serving provider for review outcome');
  return provider;
}

function validateOwnerIdentity(
  value: unknown,
  servingProvider: ReviewProvider,
): ModelIdentity | null {
  if (value === undefined || value === null) return null;
  const identity = parseIdentity(value);
  if (!identity) storageInvariant('invalid owner model identity for review outcome');
  if (identity.provider !== servingProvider || identity.role !== 'review') {
    storageInvariant('owner model identity contradicts the serving provider');
  }
  return identity;
}

interface PriorOwner {
  sessionId: string;
  provider: ReviewProvider;
}

interface PreparedOutcome {
  servingProvider: ReviewProvider;
  identityJson: string | null;
  priorOwner?: PriorOwner;
}

function prepareResultIdentity(
  db: Database.Database,
  input: RecordReviewOutcomeInput,
  servingProvider: ReviewProvider,
  incomingIdentity: ModelIdentity | null,
): string | null {
  const existing = db
    .prepare('SELECT provider, model_identity_json FROM sessions WHERE session_id = ?')
    .get(input.resultSessionId) as
    | { provider: string | null; model_identity_json: string | null }
    | undefined;
  const isFreshResult = input.preflightSessionId !== input.resultSessionId;
  if (isFreshResult && existing) {
    routingInvariant('returned session id is already recorded');
  }
  if (existing?.provider !== null && existing?.provider !== undefined) {
    if (existing.provider !== servingProvider) {
      routingInvariant('result session is already owned by another provider');
    }
  }
  return mergeOwnerIdentity(
    existing?.model_identity_json ?? null,
    incomingIdentity,
    servingProvider,
  );
}

function preparePriorOwner(
  db: Database.Database,
  input: RecordReviewOutcomeInput,
): PriorOwner | undefined {
  const sessionId = input.preflightSessionId;
  if (sessionId === undefined || sessionId === input.resultSessionId) return undefined;
  if (!input.preflightProvider) {
    storageInvariant('missing preflight provider for survivor transition');
  }
  const provider = validateServingProvider(input.preflightProvider);
  const preflight = db
    .prepare('SELECT provider FROM sessions WHERE session_id = ?')
    .get(sessionId) as { provider: string | null } | undefined;
  if (preflight && preflight.provider !== null && preflight.provider !== provider) {
    routingInvariant('preflight session is already owned by another provider');
  }
  return { sessionId, provider };
}

function prepareOutcome(db: Database.Database, input: RecordReviewOutcomeInput): PreparedOutcome {
  const servingProvider = validateServingProvider(input.servingProvider);
  const incomingIdentity = validateOwnerIdentity(input.ownerModelIdentity, servingProvider);
  return {
    servingProvider,
    identityJson: prepareResultIdentity(db, input, servingProvider, incomingIdentity),
    priorOwner: preparePriorOwner(db, input),
  };
}

function upsertResultSession(
  db: Database.Database,
  input: RecordReviewOutcomeInput,
  prepared: PreparedOutcome,
): void {
  db.prepare(
    `
    INSERT INTO sessions
      (session_id, status, completed_at, provider, model_identity_json)
    VALUES (?, 'in_progress', NULL, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      status = 'in_progress',
      completed_at = NULL,
      provider = COALESCE(sessions.provider, excluded.provider),
      model_identity_json = excluded.model_identity_json
  `,
  ).run(input.resultSessionId, prepared.servingProvider, prepared.identityJson);
}

function failPriorOwner(db: Database.Database, priorOwner: PriorOwner | undefined): void {
  if (!priorOwner) return;
  db.prepare(
    `
      INSERT INTO sessions (session_id, status, completed_at, provider, model_identity_json)
      VALUES (?, 'failed', datetime('now'), ?, NULL)
      ON CONFLICT(session_id) DO UPDATE SET
        status = 'failed',
        completed_at = datetime('now'),
        provider = COALESCE(sessions.provider, excluded.provider)
    `,
  ).run(priorOwner.sessionId, priorOwner.provider);
}

function saveSnapshotAndComplete(db: Database.Database, input: RecordReviewOutcomeInput): void {
  requireOk(saveReview(db, { ...input.review, session_id: input.resultSessionId }));
  db.prepare(
    "UPDATE sessions SET status = 'completed', completed_at = datetime('now') WHERE session_id = ?",
  ).run(input.resultSessionId);
}

function recordInTransaction(db: Database.Database, input: RecordReviewOutcomeInput): void {
  const prepared = prepareOutcome(db, input);
  upsertResultSession(db, input, prepared);
  failPriorOwner(db, prepared.priorOwner);
  saveSnapshotAndComplete(db, input);
}

export function recordReviewOutcome(
  db: Database.Database,
  input: RecordReviewOutcomeInput,
): Result<void> {
  try {
    db.exec('BEGIN IMMEDIATE');
    recordInTransaction(db, input);
    db.exec('COMMIT');
    return ok(undefined);
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    return err(storageError(error));
  }
}

function isBusyError(error: string): boolean {
  return /SQLITE_BUSY(?:_SNAPSHOT)?\b/.test(error);
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function recordReviewOutcomeWithRetry(
  db: Database.Database,
  input: RecordReviewOutcomeInput,
  options: RecordReviewRetryOptions = {},
): Promise<Result<void>> {
  const first = recordReviewOutcome(db, input);
  if (first.ok || !isBusyError(first.error)) return first;

  await (options.sleep ?? defaultSleep)(BUSY_RETRY_DELAY_MS);
  return recordReviewOutcome(db, input);
}
