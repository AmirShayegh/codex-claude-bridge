import { describe, it, expect } from 'vitest';
import { createPreparationLimiter } from './preparation.js';
import { ok, err } from '../utils/errors.js';

// A promise a test can settle by hand, so concurrency is deterministic instead
// of timing-dependent.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createPreparationLimiter', () => {
  it('runs work and returns its result', async () => {
    const limiter = createPreparationLimiter();
    expect(await limiter.run(async () => ok('done'))).toEqual({ ok: true, data: 'done' });
  });

  it('passes a failing preparation straight through', async () => {
    const limiter = createPreparationLimiter();
    const result = await limiter.run(async () => err<string>('GIT_ERROR: nope'));
    expect(result).toEqual({ ok: false, error: 'GIT_ERROR: nope' });
  });

  it('allows work up to the limit concurrently', async () => {
    const limiter = createPreparationLimiter({ maxConcurrent: 4 });
    const gates = Array.from({ length: 4 }, () => deferred<void>());
    const running = gates.map((gate) =>
      limiter.run(async () => {
        await gate.promise;
        return ok('done');
      }),
    );

    expect(limiter.activeCount()).toBe(4);
    gates.forEach((gate) => gate.resolve());
    expect(await Promise.all(running)).toEqual(Array(4).fill({ ok: true, data: 'done' }));
  });

  it('defaults to four concurrent preparations', async () => {
    const limiter = createPreparationLimiter();
    const gate = deferred<void>();
    const running = Array.from({ length: 4 }, () =>
      limiter.run(async () => {
        await gate.promise;
        return ok('done');
      }),
    );

    expect((await limiter.run(async () => ok('extra'))).ok).toBe(false);
    gate.resolve();
    await Promise.all(running);
  });

  it('rejects excess work with REVIEW_BUSY instead of queueing it', async () => {
    // Queueing would turn a burst into an unbounded backlog of pending
    // filesystem work; the caller is told immediately instead.
    const limiter = createPreparationLimiter({ maxConcurrent: 1 });
    const gate = deferred<void>();
    const first = limiter.run(async () => {
      await gate.promise;
      return ok('first');
    });

    let secondStarted = false;
    const second = await limiter.run(async () => {
      secondStarted = true;
      return ok('second');
    });

    expect(secondStarted).toBe(false);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toMatch(/^REVIEW_BUSY:/);
      expect(second.error).toContain('limit 1');
    }

    gate.resolve();
    await first;
  });

  it('does not consume a permit for the work it refuses', async () => {
    const limiter = createPreparationLimiter({ maxConcurrent: 1 });
    const gate = deferred<void>();
    const first = limiter.run(async () => {
      await gate.promise;
      return ok('first');
    });

    await limiter.run(async () => ok('refused'));
    expect(limiter.activeCount()).toBe(1);

    gate.resolve();
    await first;
    expect(limiter.activeCount()).toBe(0);
  });

  it('frees the permit after a successful preparation', async () => {
    const limiter = createPreparationLimiter({ maxConcurrent: 1 });
    await limiter.run(async () => ok('one'));
    expect(limiter.activeCount()).toBe(0);
    expect((await limiter.run(async () => ok('two'))).ok).toBe(true);
  });

  it('frees the permit after a failed preparation', async () => {
    // A validation failure or a synthetic "nothing to review" return exits the
    // same way a success does, and must not cost the server a slot.
    const limiter = createPreparationLimiter({ maxConcurrent: 1 });
    await limiter.run(async () => err<string>('INVALID_INPUT: bad cwd'));
    expect(limiter.activeCount()).toBe(0);
    expect((await limiter.run(async () => ok('next'))).ok).toBe(true);
  });

  it('frees the permit when the work throws', async () => {
    const limiter = createPreparationLimiter({ maxConcurrent: 1 });
    await expect(
      limiter.run(async () => {
        throw new Error('unexpected');
      }),
    ).rejects.toThrow('unexpected');
    expect(limiter.activeCount()).toBe(0);
    expect((await limiter.run(async () => ok('next'))).ok).toBe(true);
  });

  it('frees the permit when the work throws synchronously', async () => {
    const limiter = createPreparationLimiter({ maxConcurrent: 1 });
    await expect(
      limiter.run(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(limiter.activeCount()).toBe(0);
  });

  it('releases before the caller can start a provider call', async () => {
    // The permit covers preparation ONLY. If it were still held while a review
    // ran at the provider, four slow reviews would block every new request.
    const limiter = createPreparationLimiter({ maxConcurrent: 1 });
    await limiter.run(async () => ok('prepared'));
    expect(limiter.activeCount()).toBe(0);
  });

  it('keeps separate limiters independent', async () => {
    const a = createPreparationLimiter({ maxConcurrent: 1 });
    const b = createPreparationLimiter({ maxConcurrent: 1 });
    const gate = deferred<void>();
    const held = a.run(async () => {
      await gate.promise;
      return ok('held');
    });

    expect((await b.run(async () => ok('other'))).ok).toBe(true);
    gate.resolve();
    await held;
  });
});
