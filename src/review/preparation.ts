import { err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';

// Preparation is the filesystem-and-git work a review does BEFORE it calls a
// provider: canonicalizing the requested directory, discovering the repository,
// capturing a diff, reading instruction files. Every one of those is bounded
// work against a caller-named path, and none of it is covered by the session
// registry — that limits reviews in flight at a provider, which is a different
// and much slower resource.
//
// Without its own ceiling, a burst of requests naming huge or slow directories
// would fan out into unbounded concurrent filesystem and git work. The limit is
// deliberately small and NEVER queues: a caller that cannot be served right now
// is told so immediately, with the same REVIEW_BUSY the session registry uses.
const DEFAULT_MAX_CONCURRENT = 4;

export interface PreparationLimiter {
  // Run one preparation phase under a permit. The permit is released before this
  // resolves, so it is structurally impossible to still hold it during the
  // provider call that follows.
  run<T>(work: () => Promise<Result<T>>): Promise<Result<T>>;
  activeCount(): number;
}

export interface PreparationLimiterOptions {
  maxConcurrent?: number;
}

export function createPreparationLimiter(
  options: PreparationLimiterOptions = {},
): PreparationLimiter {
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  let active = 0;

  return {
    async run<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
      if (active >= maxConcurrent) {
        return err(
          `${ErrorCode.REVIEW_BUSY}: too many reviews are preparing at once ` +
            `(limit ${maxConcurrent}). Retry in a moment.`,
        );
      }
      active++;
      try {
        return await work();
      } finally {
        // Every exit releases: a returned failure, a synthetic early return, and
        // a thrown error alike. A leaked permit would permanently shrink the
        // server's capacity, so this is the one thing that must never be skipped.
        active--;
      }
    },
    activeCount() {
      return active;
    },
  };
}
