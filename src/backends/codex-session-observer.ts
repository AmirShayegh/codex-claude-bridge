import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_BLOCK_SIZE_BYTES = 64 * 1024;
const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_DURATION_MS = 100;
const DEFAULT_CACHE_MAX_ENTRIES = 256;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_RECORD_BYTES = 64 * 1024;

export interface CodexSessionObservation {
  model: string;
  source: 'turn_context' | 'thread_settings_applied';
}

export interface CodexSessionObserverOptions {
  codexHome?: string;
  blockSizeBytes?: number;
  maxReadBytes?: number;
  maxDurationMs?: number;
  cacheMaxEntries?: number;
  cacheTtlMs?: number;
  now?: () => number;
  openFile?: (path: string, flags: number) => Promise<CodexSessionObserverFileHandle>;
  scheduleTimeout?: (callback: () => void, delayMs: number) => CodexSessionObserverTimer;
}

export interface CodexSessionObserverFileHandle {
  stat(options: { bigint: true }): Promise<BigIntStats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface CodexSessionObserverTimer {
  cancel(): void;
}

export interface CodexSessionObserver {
  observe(sessionId: string): Promise<CodexSessionObservation | undefined>;
  clearCache(): void;
}

interface NormalizedOptions {
  codexHome: string;
  blockSizeBytes: number;
  maxReadBytes: number;
  maxDurationMs: number;
  cacheMaxEntries: number;
  cacheTtlMs: number;
  now: () => number;
  openFile: (path: string, flags: number) => Promise<CodexSessionObserverFileHandle>;
  scheduleTimeout: (callback: () => void, delayMs: number) => CodexSessionObserverTimer;
}

interface CacheEntry {
  observation: CodexSessionObservation | undefined;
  expiresAt: number;
}

interface SafeCandidate {
  path: string;
  size: number;
  device: bigint;
  inode: bigint;
  handle: CodexSessionObserverFileHandle;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizeOptions(options: CodexSessionObserverOptions): NormalizedOptions {
  return {
    codexHome: options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    blockSizeBytes: positiveInteger(options.blockSizeBytes, DEFAULT_BLOCK_SIZE_BYTES),
    maxReadBytes: positiveInteger(options.maxReadBytes, DEFAULT_MAX_READ_BYTES),
    maxDurationMs: positiveInteger(options.maxDurationMs, DEFAULT_MAX_DURATION_MS),
    cacheMaxEntries: positiveInteger(options.cacheMaxEntries, DEFAULT_CACHE_MAX_ENTRIES),
    cacheTtlMs: positiveInteger(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS),
    now: options.now ?? Date.now,
    openFile: options.openFile ?? open,
    scheduleTimeout:
      options.scheduleTimeout ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return { cancel: () => clearTimeout(timer) };
      }),
  };
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`))
  );
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function sessionTimestamp(sessionId: string): number | undefined {
  if (!UUID_V7_PATTERN.test(sessionId)) return undefined;
  const timestamp = Number.parseInt(sessionId.replaceAll('-', '').slice(0, 12), 16);
  return Number.isSafeInteger(timestamp) ? timestamp : undefined;
}

function rolloutFilename(sessionId: string, timestamp: number): string {
  const date = new Date(timestamp);
  return (
    `rollout-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${sessionId}.jsonl`
  );
}

function activeDirectories(codexHome: string, timestamp: number): string[] {
  return [0, -1, 1].map((dayOffset) => {
    const date = new Date(timestamp);
    date.setDate(date.getDate() + dayOffset);
    return join(
      codexHome,
      'sessions',
      String(date.getFullYear()),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
    );
  });
}

function isExpired(options: NormalizedOptions, startedAt: number): boolean {
  return options.now() - startedAt >= options.maxDurationMs;
}

async function canonicalDirectoryWithin(
  root: string,
  directory: string,
): Promise<string | undefined> {
  try {
    const canonical = await realpath(directory);
    return isWithin(root, canonical) ? canonical : undefined;
  } catch {
    return undefined;
  }
}

async function findCandidatePath(
  root: string,
  sessionId: string,
  timestamp: number,
  isCancelled: () => boolean,
): Promise<string | undefined> {
  const filename = rolloutFilename(sessionId, timestamp);
  for (const directory of activeDirectories(root, timestamp)) {
    if (isCancelled()) return undefined;
    const canonicalDirectory = await canonicalDirectoryWithin(root, directory);
    if (isCancelled()) return undefined;
    if (!canonicalDirectory) continue;
    const activeCandidate = join(canonicalDirectory, filename);
    try {
      await lstat(activeCandidate);
      if (isCancelled()) return undefined;
      return activeCandidate;
    } catch {
      // A missing or unreadable exact candidate is simply unavailable.
    }
  }

  if (isCancelled()) return undefined;
  const archiveDirectory = await canonicalDirectoryWithin(root, join(root, 'archived_sessions'));
  if (isCancelled()) return undefined;
  if (!archiveDirectory) return undefined;
  const archivedCandidate = join(archiveDirectory, filename);
  try {
    await lstat(archivedCandidate);
    if (isCancelled()) return undefined;
    return archivedCandidate;
  } catch {
    return undefined;
  }
}

function sameIdentity(
  left: { dev: bigint | number; ino: bigint | number },
  right: { dev: bigint | number; ino: bigint | number },
): boolean {
  return BigInt(left.dev) === BigInt(right.dev) && BigInt(left.ino) === BigInt(right.ino);
}

async function openSafeCandidate(
  root: string,
  candidate: string,
  options: NormalizedOptions,
  isCancelled: () => boolean,
): Promise<SafeCandidate | undefined> {
  let before;
  try {
    before = await lstat(candidate, { bigint: true });
  } catch {
    return undefined;
  }
  if (isCancelled()) return undefined;
  if (before.isSymbolicLink() || !before.isFile()) return undefined;

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const nonBlocking = constants.O_NONBLOCK ?? 0;
  let handle: CodexSessionObserverFileHandle | undefined;
  try {
    handle = await options.openFile(candidate, constants.O_RDONLY | noFollow | nonBlocking);
    if (isCancelled()) {
      await handle.close();
      return undefined;
    }
    const descriptor = await handle.stat({ bigint: true });
    if (isCancelled()) {
      await handle.close();
      return undefined;
    }
    if (!descriptor.isFile() || !sameIdentity(before, descriptor)) {
      await handle.close();
      return undefined;
    }

    const canonicalCandidate = await realpath(candidate);
    if (isCancelled()) {
      await handle.close();
      return undefined;
    }
    const after = await lstat(candidate, { bigint: true });
    if (isCancelled()) {
      await handle.close();
      return undefined;
    }
    if (
      !isWithin(root, canonicalCandidate) ||
      after.isSymbolicLink() ||
      !after.isFile() ||
      !sameIdentity(descriptor, after)
    ) {
      await handle.close();
      return undefined;
    }

    return {
      path: canonicalCandidate,
      size: Number(descriptor.size),
      device: descriptor.dev,
      inode: descriptor.ino,
      handle,
    };
  } catch {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The observer fails open, including when cleanup races with a file removal.
      }
    }
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function validModel(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    containsControlCharacter(value)
  ) {
    return undefined;
  }
  return value;
}

function inspectRecord(line: string): CodexSessionObservation | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  if (parsed.type === 'turn_context' && isRecord(parsed.payload)) {
    const model = validModel(parsed.payload.model);
    return model ? { model, source: 'turn_context' } : undefined;
  }

  if (parsed.type === 'thread_settings_applied' && isRecord(parsed.thread_settings)) {
    const model = validModel(parsed.thread_settings.model);
    return model ? { model, source: 'thread_settings_applied' } : undefined;
  }

  if (
    parsed.type === 'event_msg' &&
    isRecord(parsed.payload) &&
    parsed.payload.type === 'thread_settings_applied' &&
    isRecord(parsed.payload.thread_settings)
  ) {
    const model = validModel(parsed.payload.thread_settings.model);
    return model ? { model, source: 'thread_settings_applied' } : undefined;
  }
  return undefined;
}

function inspectCompleteLines(
  bytes: Buffer,
  fallback: CodexSessionObservation | undefined,
  isCancelled: () => boolean,
): {
  turnContext?: CodexSessionObservation;
  fallback?: CodexSessionObservation;
  cancelled?: true;
} {
  let latestFallback = fallback;
  let lineEnd = bytes.length;
  while (lineEnd > 0) {
    if (isCancelled()) return { fallback: latestFallback, cancelled: true };
    const newlineIndex = bytes.lastIndexOf(0x0a, lineEnd - 1);
    const lineStart = newlineIndex + 1;
    const contentEnd = lineEnd > lineStart && bytes[lineEnd - 1] === 0x0d ? lineEnd - 1 : lineEnd;
    const lineLength = contentEnd - lineStart;
    let observation: CodexSessionObservation | undefined;
    if (lineLength > 0 && lineLength <= MAX_RECORD_BYTES) {
      observation = inspectRecord(bytes.toString('utf8', lineStart, contentEnd));
      if (isCancelled()) return { fallback: latestFallback, cancelled: true };
    }
    if (observation) {
      if (observation.source === 'turn_context')
        return { turnContext: observation, fallback: latestFallback };
      latestFallback ??= observation;
    }

    if (newlineIndex < 0) break;
    lineEnd = newlineIndex;
  }
  return { fallback: latestFallback };
}

async function readObservation(
  candidate: SafeCandidate,
  options: NormalizedOptions,
  isCancelled: () => boolean,
): Promise<CodexSessionObservation | undefined> {
  let position = candidate.size;
  let bytesReadTotal = 0;
  // Newest blocks are read first. Keep fragments as separate buffers until a
  // newline is found so one very large JSONL record cannot trigger quadratic
  // copying while the bounded window is scanned backwards.
  let carryParts: Buffer[] = [];
  let fallback: CodexSessionObservation | undefined;

  while (position > 0 && bytesReadTotal < options.maxReadBytes) {
    if (isCancelled()) return undefined;
    const length = Math.min(
      options.blockSizeBytes,
      position,
      options.maxReadBytes - bytesReadTotal,
    );
    const start = position - length;
    const block = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      if (isCancelled()) return undefined;
      const result = await candidate.handle.read(block, filled, length - filled, start + filled);
      if (isCancelled()) return undefined;
      if (result.bytesRead === 0) return undefined;
      filled += result.bytesRead;
    }

    bytesReadTotal += filled;
    position = start;
    carryParts.unshift(block);

    if (start === 0) {
      const combined = Buffer.concat(carryParts);
      const inspected = inspectCompleteLines(combined, fallback, isCancelled);
      if (inspected.cancelled) return undefined;
      return inspected.turnContext ?? inspected.fallback;
    }

    if (block.indexOf(0x0a) === -1) continue;

    const combined = Buffer.concat(carryParts);
    const firstNewline = combined.indexOf(0x0a);
    carryParts = [combined.subarray(0, firstNewline)];
    const inspected = inspectCompleteLines(
      combined.subarray(firstNewline + 1),
      fallback,
      isCancelled,
    );
    if (inspected.cancelled) return undefined;
    if (inspected.turnContext) return inspected.turnContext;
    fallback = inspected.fallback;
  }

  // A settings record is useful only if it was fully contained in the bounded
  // scan. A partial leading line is deliberately ignored.
  return isCancelled() ? undefined : fallback;
}

function cacheKey(sessionId: string, candidate: SafeCandidate): string {
  return `${sessionId}\0${candidate.path}\0${candidate.device}:${candidate.inode}:${candidate.size}`;
}

export function createCodexSessionObserver(
  rawOptions: CodexSessionObserverOptions = {},
): CodexSessionObserver {
  const options = normalizeOptions(rawOptions);
  const cache = new Map<string, CacheEntry>();

  function readCache(key: string, now: number): CacheEntry | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      cache.delete(key);
      return undefined;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }

  function writeCache(
    key: string,
    observation: CodexSessionObservation | undefined,
    now: number,
  ): void {
    cache.delete(key);
    cache.set(key, { observation, expiresAt: now + options.cacheTtlMs });
    while (cache.size > options.cacheMaxEntries) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  return {
    async observe(sessionId: string): Promise<CodexSessionObservation | undefined> {
      const timestamp = sessionTimestamp(sessionId);
      if (timestamp === undefined) return undefined;

      const startedAt = options.now();
      let deadlineReached = false;
      let resolveDeadline: (observation: undefined) => void = () => undefined;
      const deadline = new Promise<undefined>((resolve) => {
        resolveDeadline = resolve;
      });
      const timer = options.scheduleTimeout(() => {
        deadlineReached = true;
        resolveDeadline(undefined);
      }, options.maxDurationMs);
      const isCancelled = (): boolean => {
        if (deadlineReached) return true;
        if (!isExpired(options, startedAt)) return false;
        deadlineReached = true;
        return true;
      };

      const operation = (async (): Promise<CodexSessionObservation | undefined> => {
        let candidate: SafeCandidate | undefined;
        try {
          const root = await realpath(options.codexHome);
          if (isCancelled()) return undefined;
          const candidatePath = await findCandidatePath(root, sessionId, timestamp, isCancelled);
          if (!candidatePath || isCancelled()) return undefined;
          candidate = await openSafeCandidate(root, candidatePath, options, isCancelled);
          if (
            !candidate ||
            isCancelled() ||
            !Number.isSafeInteger(candidate.size) ||
            candidate.size < 0
          )
            return undefined;

          const key = cacheKey(sessionId, candidate);
          const cached = readCache(key, startedAt);
          if (cached) return isCancelled() ? undefined : cached.observation;
          const observation = await readObservation(candidate, options, isCancelled);
          if (isCancelled()) return undefined;
          writeCache(key, observation, startedAt);
          return observation;
        } catch {
          return undefined;
        } finally {
          if (candidate) {
            try {
              await candidate.handle.close();
            } catch {
              // Observation is strictly best-effort and must never fail a review.
            }
          }
        }
      })();

      try {
        return await Promise.race([operation, deadline]);
      } finally {
        timer.cancel();
      }
    },
    clearCache(): void {
      cache.clear();
    },
  };
}
