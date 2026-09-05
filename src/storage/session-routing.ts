import type { SessionProviderLookup } from '../backends/failover.js';
import type { ModelIdentity } from '../review/types.js';
import type { LookupResult, StorageDurability } from './db.js';
import type { SessionModelMetadata } from './sessions.js';
import type { SessionRegistry } from './session-registry.js';
import type { ReviewProvider } from '../config/types.js';

export interface SessionRoutingOptions {
  registry: SessionRegistry;
  durability: StorageDurability;
  providerLookup: (sessionId: string) => LookupResult<ReviewProvider | null>;
  modelLookup: (sessionId: string) => LookupResult<SessionModelMetadata>;
  maxTombstones?: number;
  tombstoneTtlMs?: number;
  now?: () => number;
}

export interface SessionRouting {
  lookupProvider: SessionProviderLookup;
  lookupResultSession: SessionProviderLookup;
  lookupModel(sessionId: string): ModelIdentity | null;
  markOutcomePersistenceFailure(sessionId: string): void;
  markOutcomePersisted(sessionId: string): void;
}

export function createSessionRouting(options: SessionRoutingOptions): SessionRouting {
  const { registry, durability, providerLookup, modelLookup } = options;
  const maxTombstones = Math.max(1, options.maxTombstones ?? 1_024);
  const tombstoneTtlMs = options.tombstoneTtlMs ?? 24 * 60 * 60 * 1_000;
  const now = options.now ?? Date.now;
  const tombstones = new Map<string, number>();
  let hasLostTombstone = false;

  const pruneTombstones = (): void => {
    const cutoff = now() - tombstoneTtlMs;
    for (const [sessionId, lastAccess] of tombstones) {
      if (lastAccess >= cutoff) continue;
      tombstones.delete(sessionId);
      hasLostTombstone = true;
    }
  };

  const rememberTombstone = (sessionId: string): void => {
    pruneTombstones();
    if (tombstones.has(sessionId)) tombstones.delete(sessionId);
    while (tombstones.size >= maxTombstones) {
      const oldest = tombstones.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      tombstones.delete(oldest);
      hasLostTombstone = true;
    }
    tombstones.set(sessionId, now());
  };

  const hasTombstone = (sessionId: string): boolean => {
    pruneTombstones();
    if (!tombstones.has(sessionId)) return false;
    tombstones.delete(sessionId);
    tombstones.set(sessionId, now());
    return true;
  };

  return {
    lookupProvider(sessionId) {
      const memory = registry.lookupProvider(sessionId);
      if (memory.status === 'found') return memory;
      if (durability === 'memory_only') return { status: 'unavailable' };
      const persisted = providerLookup(sessionId);
      if (persisted.status === 'unavailable') return persisted;
      if (persisted.status === 'found' && persisted.value !== null) {
        tombstones.delete(sessionId);
        return persisted;
      }
      // An exact tombstone identifies a successful result that never reached
      // durable storage. If bounded retention ever loses such an id, all raw
      // absent/legacy misses become ambiguous and therefore fail closed.
      if (hasTombstone(sessionId) || hasLostTombstone) {
        return { status: 'unavailable' };
      }
      return persisted;
    },

    lookupResultSession(sessionId) {
      const memory = registry.getStatus(sessionId);
      if (memory) return { status: 'found', value: memory.provider };
      // A configured in-memory database has no ownership beyond the registry,
      // so registry absence is sufficient proof that a generated result id is
      // fresh. Durable storage performs a raw existence lookup, then also
      // rejects exact retained tombstones so an evicted unpersisted id cannot
      // be reused as a supposedly fresh provider result.
      if (durability === 'memory_only') return { status: 'absent' };
      const persisted = providerLookup(sessionId);
      if (persisted.status === 'unavailable') return persisted;
      if (persisted.status === 'found' && persisted.value !== null) {
        tombstones.delete(sessionId);
        return persisted;
      }
      if (hasTombstone(sessionId) || hasLostTombstone) {
        return { status: 'unavailable' };
      }
      return persisted;
    },

    lookupModel(sessionId) {
      const memory = registry.lookupModel(sessionId);
      if (memory.status === 'found') return memory.value;
      if (durability === 'memory_only') return null;
      const stored = modelLookup(sessionId);
      if (stored.status !== 'found' || stored.value.status !== 'recorded') return null;
      return stored.value.model;
    },

    markOutcomePersistenceFailure(sessionId) {
      if (durability === 'memory_only') return;
      try {
        const persisted = providerLookup(sessionId);
        // A resumed durable row still owns this id even though its latest
        // history snapshot failed; registry eviction cannot misroute it.
        if (persisted.status === 'found' && persisted.value !== null) {
          tombstones.delete(sessionId);
          return;
        }
      } catch {
        // An unavailable existence check is ambiguous, so retain the id.
      }
      rememberTombstone(sessionId);
    },

    markOutcomePersisted(sessionId) {
      tombstones.delete(sessionId);
    },
  };
}
