import type { ReviewProvider } from '../config/types.js';
import type { ModelIdentity } from '../review/types.js';
import { err, ErrorCode, ok } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';

const DEFAULT_MAX_ACTIVE = 4;
const DEFAULT_MAX_ENTRIES = 1_024;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;

export type RegistryLookup<T> = { status: 'found'; value: T } | { status: 'absent' };

export interface RegistryStatus {
  sessionId: string;
  status: 'in_progress' | 'completed' | 'failed';
  provider: ReviewProvider | null;
  model: ModelIdentity | null;
  startedAt: number;
  completedAt: number | null;
}

interface RegistryEntry extends RegistryStatus {
  active: boolean;
  lastAccess: number;
}

export interface ReviewAdmission {
  release(): void;
}

export interface SessionRegistry {
  admit(
    sessionId?: string,
    provider?: ReviewProvider,
    model?: ModelIdentity | null,
  ): Result<ReviewAdmission>;
  complete(
    inputSessionId: string | undefined,
    resultSessionId: string,
    provider: ReviewProvider,
    model: ModelIdentity | null,
  ): void;
  fail(...sessionIds: Array<string | undefined>): void;
  discard(sessionId: string): void;
  lookupProvider(sessionId: string): RegistryLookup<ReviewProvider>;
  lookupModel(sessionId: string): RegistryLookup<ModelIdentity>;
  getStatus(sessionId: string): RegistryStatus | null;
  activeCount(): number;
}

export interface SessionRegistryOptions {
  maxActive?: number;
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

export function createSessionRegistry(options: SessionRegistryOptions = {}): SessionRegistry {
  const maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, RegistryEntry>();
  const admissionKeys = new Set<string>();
  let active = 0;

  const prune = (): void => {
    const cutoff = now() - ttlMs;
    for (const [id, entry] of entries) {
      if (!entry.active && entry.lastAccess < cutoff) entries.delete(id);
    }
  };

  const makeRoom = (incomingId: string): void => {
    prune();
    if (entries.has(incomingId) || entries.size < maxEntries) return;
    let oldest: [string, RegistryEntry] | undefined;
    for (const candidate of entries) {
      if (candidate[1].active) continue;
      if (!oldest || candidate[1].lastAccess < oldest[1].lastAccess) oldest = candidate;
    }
    if (oldest) entries.delete(oldest[0]);
  };

  const upsertStatus = (
    sessionId: string,
    status: RegistryStatus['status'],
    provider?: ReviewProvider | null,
    model?: ModelIdentity | null,
  ): RegistryEntry => {
    makeRoom(sessionId);
    const timestamp = now();
    const previous = entries.get(sessionId);
    const entry: RegistryEntry = {
      sessionId,
      status,
      provider: provider === undefined ? (previous?.provider ?? null) : provider,
      model: model === undefined ? (previous?.model ?? null) : model,
      startedAt: status === 'in_progress' ? timestamp : (previous?.startedAt ?? timestamp),
      completedAt: status === 'in_progress' ? null : timestamp,
      active: previous?.active ?? false,
      lastAccess: timestamp,
    };
    entries.set(sessionId, entry);
    return entry;
  };

  return {
    admit(sessionId, provider, model) {
      prune();
      if (active >= maxActive) {
        return err(`${ErrorCode.REVIEW_BUSY}: four reviews are already active`);
      }
      if (sessionId && admissionKeys.has(sessionId)) {
        return err(`${ErrorCode.REVIEW_BUSY}: a review is already active for this session`);
      }

      active += 1;
      if (sessionId) {
        admissionKeys.add(sessionId);
        const entry = upsertStatus(sessionId, 'in_progress', provider, model);
        entry.active = true;
      }

      let released = false;
      return ok({
        release() {
          if (released) return;
          released = true;
          active -= 1;
          if (!sessionId) return;
          admissionKeys.delete(sessionId);
          const entry = entries.get(sessionId);
          if (entry) {
            entry.active = false;
            entry.lastAccess = now();
          }
        },
      });
    },

    complete(inputSessionId, resultSessionId, provider, model) {
      if (inputSessionId && inputSessionId !== resultSessionId) {
        upsertStatus(inputSessionId, 'failed');
      }
      const completed = upsertStatus(resultSessionId, 'completed', provider, model);
      completed.active = inputSessionId === resultSessionId && admissionKeys.has(resultSessionId);
    },

    fail(...sessionIds) {
      for (const sessionId of new Set(sessionIds.filter((id): id is string => Boolean(id)))) {
        upsertStatus(sessionId, 'failed');
      }
    },

    discard(sessionId) {
      if (admissionKeys.has(sessionId)) return;
      entries.delete(sessionId);
    },

    lookupProvider(sessionId) {
      prune();
      const entry = entries.get(sessionId);
      if (!entry?.provider) return { status: 'absent' };
      entry.lastAccess = now();
      return { status: 'found', value: entry.provider };
    },

    lookupModel(sessionId) {
      prune();
      const entry = entries.get(sessionId);
      if (!entry?.model) return { status: 'absent' };
      entry.lastAccess = now();
      return { status: 'found', value: entry.model };
    },

    getStatus(sessionId) {
      prune();
      const entry = entries.get(sessionId);
      if (!entry) return null;
      entry.lastAccess = now();
      const { active: _active, lastAccess: _lastAccess, ...status } = entry;
      return status;
    },

    activeCount: () => active,
  };
}
