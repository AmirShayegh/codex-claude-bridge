import { describe, expect, it, vi } from 'vitest';
import { createSessionRegistry } from './session-registry.js';
import { createSessionRouting } from './session-routing.js';
import type { ModelIdentity } from '../review/types.js';

const MODEL: ModelIdentity = {
  provider: 'gemini',
  role: 'review',
  requested: 'Gemini 3.5 Pro (High)',
  resolved: 'Gemini 3.5 Pro (High)',
  observed: null,
  evidence: 'bridge_selection',
};

describe('session routing composition', () => {
  it('prefers live registry ownership and identity over durable rows', () => {
    const registry = createSessionRegistry();
    registry.complete(undefined, 'live', 'gemini', MODEL);
    const providerLookup = vi.fn().mockReturnValue({ status: 'found', value: 'codex' });
    const modelLookup = vi
      .fn()
      .mockReturnValue({ status: 'found', value: { status: 'legacy_unrecorded' } });
    const routing = createSessionRouting({
      registry,
      durability: 'durable',
      providerLookup,
      modelLookup,
    });

    expect(routing.lookupProvider('live')).toEqual({ status: 'found', value: 'gemini' });
    expect(routing.lookupModel('live')).toEqual(MODEL);
    expect(providerLookup).not.toHaveBeenCalled();
    expect(modelLookup).not.toHaveBeenCalled();
  });

  it('falls back to durable ownership and recorded identity', () => {
    const routing = createSessionRouting({
      registry: createSessionRegistry(),
      durability: 'durable',
      providerLookup: () => ({ status: 'found', value: 'codex' }),
      modelLookup: () => ({
        status: 'found',
        value: { status: 'recorded', model: { ...MODEL, provider: 'codex' } },
      }),
    });

    expect(routing.lookupProvider('durable')).toEqual({ status: 'found', value: 'codex' });
    expect(routing.lookupModel('durable')).toEqual({ ...MODEL, provider: 'codex' });
  });

  it('reports unavailable for unknown memory-only sessions instead of guessing a provider', () => {
    const routing = createSessionRouting({
      registry: createSessionRegistry(),
      durability: 'memory_only',
      providerLookup: () => ({ status: 'absent' }),
      modelLookup: () => ({ status: 'found', value: { status: 'legacy_unrecorded' } }),
    });

    expect(routing.lookupProvider('unknown')).toEqual({ status: 'unavailable' });
    expect(routing.lookupModel('unknown')).toBeNull();
  });

  it('fails closed on a durable miss after an unpersisted outcome survives registry eviction', () => {
    let now = 0;
    const registry = createSessionRegistry({ ttlMs: 10, now: () => now });
    registry.complete(undefined, 'volatile-survivor', 'gemini', MODEL);
    const providerLookup = vi.fn().mockReturnValue({ status: 'absent' });
    const routing = createSessionRouting({
      registry,
      durability: 'durable',
      providerLookup,
      modelLookup: () => ({ status: 'absent' }),
    });

    routing.markOutcomePersistenceFailure('volatile-survivor');
    expect(routing.lookupProvider('volatile-survivor')).toEqual({
      status: 'found',
      value: 'gemini',
    });

    now = 11;
    expect(routing.lookupProvider('volatile-survivor')).toEqual({ status: 'unavailable' });
    expect(routing.lookupProvider('unrelated-new')).toEqual({ status: 'absent' });
    expect(routing.lookupResultSession('genuinely-new')).toEqual({ status: 'absent' });
    expect(providerLookup).toHaveBeenCalledWith('volatile-survivor');
  });

  it('still routes durable rows after an outcome persistence failure', () => {
    const routing = createSessionRouting({
      registry: createSessionRegistry(),
      durability: 'durable',
      providerLookup: (sessionId) =>
        sessionId === 'persisted' ? { status: 'found', value: 'codex' } : { status: 'absent' },
      modelLookup: () => ({ status: 'absent' }),
      maxTombstones: 1,
    });

    routing.markOutcomePersistenceFailure('persisted');
    routing.markOutcomePersistenceFailure('volatile');

    expect(routing.lookupProvider('persisted')).toEqual({ status: 'found', value: 'codex' });
    expect(routing.lookupProvider('unrelated')).toEqual({ status: 'absent' });
  });

  it('preserves absent and legacy fallback for ids unrelated to an unpersisted outcome', () => {
    const routing = createSessionRouting({
      registry: createSessionRegistry(),
      durability: 'durable',
      providerLookup: (sessionId) =>
        sessionId === 'legacy' ? { status: 'found', value: null } : { status: 'absent' },
      modelLookup: () => ({ status: 'absent' }),
    });

    routing.markOutcomePersistenceFailure('volatile');

    expect(routing.lookupProvider('volatile')).toEqual({ status: 'unavailable' });
    expect(routing.lookupProvider('unrelated')).toEqual({ status: 'absent' });
    expect(routing.lookupProvider('legacy')).toEqual({ status: 'found', value: null });
  });

  it('clears an exact tombstone after that result id is persisted', () => {
    const routing = createSessionRouting({
      registry: createSessionRegistry(),
      durability: 'durable',
      providerLookup: () => ({ status: 'absent' }),
      modelLookup: () => ({ status: 'absent' }),
    });
    routing.markOutcomePersistenceFailure('recovered');
    expect(routing.lookupProvider('recovered')).toEqual({ status: 'unavailable' });

    routing.markOutcomePersisted('recovered');

    expect(routing.lookupProvider('recovered')).toEqual({ status: 'absent' });
  });

  it('fails all ambiguous misses closed after a bounded tombstone is evicted', () => {
    const routing = createSessionRouting({
      registry: createSessionRegistry(),
      durability: 'durable',
      providerLookup: () => ({ status: 'absent' }),
      modelLookup: () => ({ status: 'absent' }),
      maxTombstones: 1,
    });

    routing.markOutcomePersistenceFailure('first');
    routing.markOutcomePersistenceFailure('second');

    expect(routing.lookupProvider('unrelated')).toEqual({ status: 'unavailable' });
  });

  it('keeps legacy/invalid model metadata unknown without substituting a default', () => {
    for (const status of ['legacy_unrecorded', 'invalid'] as const) {
      const routing = createSessionRouting({
        registry: createSessionRegistry(),
        durability: 'durable',
        providerLookup: () => ({ status: 'found', value: 'codex' }),
        modelLookup: () => ({ status: 'found', value: { status } }),
      });
      expect(routing.lookupModel(status)).toBeNull();
    }
  });
});
