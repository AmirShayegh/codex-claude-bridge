import { describe, expect, it, vi } from 'vitest';
import { createSessionRegistry } from './session-registry.js';
import type { ModelIdentity } from '../review/types.js';

const MODEL: ModelIdentity = {
  provider: 'codex',
  role: 'review',
  requested: null,
  resolved: 'gpt-5.6-sol',
  observed: 'gpt-5.6-sol',
  evidence: 'runtime_session_record',
};

describe('session registry admission', () => {
  it('rejects overlapping work for the same session and releases the key', () => {
    const registry = createSessionRegistry();
    const first = registry.admit('session-1');
    expect(first.ok).toBe(true);

    const overlap = registry.admit('session-1');
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) expect(overlap.error).toMatch(/^REVIEW_BUSY:/);

    if (first.ok) first.data.release();
    expect(registry.admit('session-1').ok).toBe(true);
  });

  it('permits four different logical reviews and rejects the fifth immediately', () => {
    const registry = createSessionRegistry();
    const admissions = ['a', 'b', 'c', 'd'].map((id) => registry.admit(id));
    expect(admissions.every((entry) => entry.ok)).toBe(true);
    const fifth = registry.admit('e');
    expect(fifth.ok).toBe(false);
    if (!fifth.ok) expect(fifth.error).toMatch(/^REVIEW_BUSY:/);
  });

  it('release is idempotent', () => {
    const registry = createSessionRegistry();
    const admission = registry.admit('session-1');
    if (!admission.ok) throw new Error(admission.error);
    admission.data.release();
    admission.data.release();
    expect(registry.activeCount()).toBe(0);
  });
});

describe('session registry identity and eviction', () => {
  it('exposes completed memory-only owner, model, and status', () => {
    const registry = createSessionRegistry();
    registry.complete('old-id', 'new-id', 'codex', MODEL);

    expect(registry.lookupProvider('new-id')).toEqual({ status: 'found', value: 'codex' });
    expect(registry.lookupModel('new-id')).toEqual({ status: 'found', value: MODEL });
    expect(registry.getStatus('new-id')).toMatchObject({ status: 'completed', provider: 'codex' });
    expect(registry.getStatus('old-id')).toMatchObject({ status: 'failed' });
  });

  it('never evicts an active entry and evicts the least-recent inactive entry', () => {
    let now = 0;
    const registry = createSessionRegistry({ maxEntries: 3, now: () => now });
    const active = registry.admit('active');
    registry.complete(undefined, 'oldest', 'codex', MODEL);
    now += 1;
    registry.complete(undefined, 'newer', 'codex', MODEL);
    now += 1;
    registry.complete(undefined, 'newest', 'codex', MODEL);

    expect(registry.getStatus('active')).not.toBeNull();
    expect(registry.getStatus('oldest')).toBeNull();
    expect(registry.getStatus('newer')).not.toBeNull();
    if (active.ok) active.data.release();
  });

  it('expires inactive entries after the TTL but retains active entries', () => {
    let now = 0;
    const registry = createSessionRegistry({ ttlMs: 10, now: () => now });
    registry.complete(undefined, 'done', 'codex', MODEL);
    const active = registry.admit('active');
    now = 11;

    expect(registry.getStatus('done')).toBeNull();
    expect(registry.getStatus('active')).not.toBeNull();
    if (active.ok) active.data.release();
  });

  it('does not hide durable ownership while an admitted entry has no owner yet', () => {
    const registry = createSessionRegistry();
    const admission = registry.admit('legacy-or-durable');
    expect(registry.lookupProvider('legacy-or-durable')).toEqual({ status: 'absent' });
    expect(registry.lookupModel('legacy-or-durable')).toEqual({ status: 'absent' });
    if (admission.ok) admission.data.release();
  });

  it('marks a provider failure and always clears admission through finally-style release', () => {
    const registry = createSessionRegistry();
    const admission = registry.admit('session-1');
    registry.fail('session-1');
    if (admission.ok) admission.data.release();
    expect(registry.getStatus('session-1')).toMatchObject({ status: 'failed' });
    expect(registry.activeCount()).toBe(0);
  });

  it('uses the injected clock for deterministic status timing', () => {
    const now = vi.fn(() => 5_000);
    const registry = createSessionRegistry({ now });
    const admission = registry.admit('session-1');
    expect(registry.getStatus('session-1')?.startedAt).toBe(5_000);
    if (admission.ok) admission.data.release();
  });

  it('seeds a resumed admission with its known durable owner', () => {
    const registry = createSessionRegistry();
    const admission = registry.admit('durable-owner', 'gemini');

    expect(registry.lookupProvider('durable-owner')).toEqual({
      status: 'found',
      value: 'gemini',
    });
    registry.fail('durable-owner');
    if (admission.ok) admission.data.release();
    expect(registry.getStatus('durable-owner')).toMatchObject({
      status: 'failed',
      provider: 'gemini',
    });
  });
});
