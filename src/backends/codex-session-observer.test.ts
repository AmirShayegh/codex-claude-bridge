import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCodexSessionObserver,
  type CodexSessionObserverOptions,
} from './codex-session-observer.js';

const execFileAsync = promisify(execFile);
const HAS_MKFIFO = spawnSync('mkfifo', []).error === undefined;
const SESSION_ID = '019f5a26-4fef-7e41-ba94-07c09465cd50';
const SECOND_SESSION_ID = '019f5a26-4ff0-7e41-ba94-07c09465cd51';
const SESSION_TIME = Number.parseInt(SESSION_ID.replaceAll('-', '').slice(0, 12), 16);

const temporaryHomes: string[] = [];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function localParts(timestamp = SESSION_TIME): {
  date: string;
  time: string;
  year: string;
  month: string;
  day: string;
} {
  const date = new Date(timestamp);
  const year = String(date.getFullYear());
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  return {
    date: `${year}-${month}-${day}`,
    time: `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`,
    year,
    month,
    day,
  };
}

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codex-observer-'));
  temporaryHomes.push(home);
  return home;
}

async function activePath(home: string, sessionId = SESSION_ID, dayOffset = 0): Promise<string> {
  const timestamp = Number.parseInt(sessionId.replaceAll('-', '').slice(0, 12), 16);
  const shifted = new Date(timestamp);
  shifted.setDate(shifted.getDate() + dayOffset);
  const directoryParts = localParts(shifted.getTime());
  const filenameParts = localParts(timestamp);
  const directory = join(
    home,
    'sessions',
    directoryParts.year,
    directoryParts.month,
    directoryParts.day,
  );
  await mkdir(directory, { recursive: true });
  return join(directory, `rollout-${filenameParts.date}T${filenameParts.time}-${sessionId}.jsonl`);
}

async function archivedPath(home: string, sessionId = SESSION_ID): Promise<string> {
  const timestamp = Number.parseInt(sessionId.replaceAll('-', '').slice(0, 12), 16);
  const parts = localParts(timestamp);
  const directory = join(home, 'archived_sessions');
  await mkdir(directory, { recursive: true });
  return join(directory, `rollout-${parts.date}T${parts.time}-${sessionId}.jsonl`);
}

function turnContext(model: string): string {
  return JSON.stringify({ type: 'turn_context', payload: { model } });
}

function threadSettings(model: string): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: { type: 'thread_settings_applied', thread_settings: { model } },
  });
}

function observer(home: string, options: Partial<CodexSessionObserverOptions> = {}) {
  // Functional assertions should not depend on filesystem work finishing within
  // the production 100ms deadline. Timing tests supply their own controls below.
  return createCodexSessionObserver({
    codexHome: home,
    now: () => 0,
    scheduleTimeout: () => ({ cancel: () => undefined }),
    ...options,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

describe('createCodexSessionObserver', () => {
  it('rejects non-UUIDv7 input without throwing', async () => {
    const home = await makeHome();
    await expect(observer(home).observe('../not-a-session')).resolves.toBeUndefined();
  });

  it('reads the latest valid turn-context model from the derived active-session date', async () => {
    const home = await makeHome();
    const file = await activePath(home);
    await writeFile(
      file,
      [
        threadSettings('settings-fallback'),
        turnContext('gpt-5.5'),
        turnContext('gpt-5.6-sol'),
      ].join('\n'),
    );

    await expect(observer(home).observe(SESSION_ID)).resolves.toEqual({
      model: 'gpt-5.6-sol',
      source: 'turn_context',
    });
  });

  it('checks adjacent local-date directories', async () => {
    const home = await makeHome();
    const file = await activePath(home, SESSION_ID, -1);
    await writeFile(file, turnContext('adjacent-date-model'));

    await expect(observer(home).observe(SESSION_ID)).resolves.toMatchObject({
      model: 'adjacent-date-model',
    });
  });

  it('checks the exact archived rollout candidate', async () => {
    const home = await makeHome();
    const file = await archivedPath(home);
    await writeFile(file, turnContext('archived-model'));

    await expect(observer(home).observe(SESSION_ID)).resolves.toEqual({
      model: 'archived-model',
      source: 'turn_context',
    });
  });

  it('uses thread_settings_applied only when no valid turn context exists', async () => {
    const home = await makeHome();
    const file = await activePath(home);
    await writeFile(
      file,
      [
        threadSettings('settings-fallback'),
        turnContext('bad\nmodel'),
        turnContext('x'.repeat(201)),
      ].join('\n'),
    );

    await expect(observer(home).observe(SESSION_ID)).resolves.toEqual({
      model: 'settings-fallback',
      source: 'thread_settings_applied',
    });
  });

  it('rejects symlinks and candidates whose canonical parent escapes CODEX_HOME', async () => {
    const home = await makeHome();
    const outside = await makeHome();
    const outsideFile = await activePath(outside);
    await writeFile(outsideFile, turnContext('must-not-read'));

    const linkPath = await activePath(home);
    await symlink(outsideFile, linkPath);
    await expect(observer(home).observe(SESSION_ID)).resolves.toBeUndefined();

    await rm(join(home, 'sessions'), { recursive: true });
    await symlink(join(outside, 'sessions'), join(home, 'sessions'));
    await expect(observer(home).observe(SESSION_ID)).resolves.toBeUndefined();
  });

  it('rejects directories without treating them as rollout files', async () => {
    const home = await makeHome();
    const file = await activePath(home);
    await mkdir(file);
    await expect(observer(home).observe(SESSION_ID)).resolves.toBeUndefined();
  });

  it.skipIf(!HAS_MKFIFO)('rejects FIFOs without blocking', async () => {
    const home = await makeHome();
    const file = await activePath(home);
    await execFileAsync('mkfifo', [file]);
    await expect(observer(home).observe(SESSION_ID)).resolves.toBeUndefined();
  });

  it('reverse-reads in bounded blocks and does not inspect content beyond maxBytes', async () => {
    const home = await makeHome();
    const file = await activePath(home);
    await writeFile(file, `${turnContext('too-old')}\n${'x'.repeat(512)}\n`);

    await expect(
      observer(home, { blockSizeBytes: 32, maxReadBytes: 128 }).observe(SESSION_ID),
    ).resolves.toBeUndefined();

    await writeFile(file, `${'x'.repeat(512)}\n${turnContext('near-the-end')}\n`);
    await expect(
      observer(home, { blockSizeBytes: 32, maxReadBytes: 128 }).observe(SESSION_ID),
    ).resolves.toMatchObject({ model: 'near-the-end' });
  });

  it('keeps a genuinely sparse rollout outside the default eight-MiB window unavailable', async () => {
    const home = await makeHome();
    const file = await activePath(home);
    const sparseHandle = await open(file, 'w');
    await sparseHandle.write(`${turnContext('outside-window')}\n`, 0, 'utf8');
    await sparseHandle.truncate(1024 * 1024 * 1024);
    await sparseHandle.close();
    let readBytes = 0;

    await expect(
      observer(home, {
        maxDurationMs: 5_000,
        openFile: async (path, flags) => {
          const handle = await open(path, flags);
          return {
            stat: (options) => handle.stat(options),
            read: async (buffer, offset, length, position) => {
              const result = await handle.read(buffer, offset, length, position);
              readBytes += result.bytesRead;
              return result;
            },
            close: () => handle.close(),
          };
        },
      }).observe(SESSION_ID),
    ).resolves.toBeUndefined();
    expect(readBytes).toBe(8 * 1024 * 1024);
  });

  it('skips pathological giant JSONL records instead of parsing them', async () => {
    const home = await makeHome();
    const file = await activePath(home);
    const pathological = JSON.stringify({
      type: 'turn_context',
      payload: { model: 'pathological-latest' },
      padding: 'x'.repeat(256 * 1024),
    });
    await writeFile(file, `${turnContext('bounded-record')}\n${pathological}\n`);

    await expect(observer(home).observe(SESSION_ID)).resolves.toEqual({
      model: 'bounded-record',
      source: 'turn_context',
    });
  });

  it('bounds caller latency, closes a handle opened after expiry, and avoids stale cache writes', async () => {
    const home = await makeHome();
    const file = await activePath(home);
    await writeFile(file, turnContext('model-a'));

    let releaseOpen: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let openedHandle: Awaited<ReturnType<typeof open>> | undefined;
    let fireDeadline: (() => void) | undefined;
    const instance = observer(home, {
      openFile: async (path, flags) => {
        openedHandle = await open(path, flags);
        await openGate;
        return openedHandle;
      },
      scheduleTimeout: (callback) => {
        fireDeadline = callback;
        return { cancel: () => undefined };
      },
    });

    const pending = instance.observe(SESSION_ID);
    await vi.waitFor(() => expect(openedHandle).toBeDefined());
    expect(fireDeadline).toBeDefined();
    fireDeadline?.();
    await expect(pending).resolves.toBeUndefined();

    await writeFile(file, turnContext('model-b'));
    releaseOpen?.();
    await vi.waitFor(async () => {
      await expect(openedHandle?.stat()).rejects.toThrow();
    });

    await expect(instance.observe(SESSION_ID)).resolves.toEqual({
      model: 'model-b',
      source: 'turn_context',
    });
  });

  it('stops scanning when the injected time budget expires', async () => {
    const home = await makeHome();
    const file = await activePath(home);
    await writeFile(file, `${turnContext('too-slow')}\n${'x'.repeat(256)}\n`);
    let calls = 0;

    await expect(
      observer(home, {
        blockSizeBytes: 16,
        maxDurationMs: 100,
        now: () => (calls++ === 0 ? 1_000 : 1_101),
      }).observe(SESSION_ID),
    ).resolves.toBeUndefined();
  });

  it('caches by session, path, inode, and size, then refreshes when size changes', async () => {
    const home = await makeHome();
    const file = await activePath(home);
    await writeFile(file, turnContext('model-a'));
    const instance = observer(home);

    await expect(instance.observe(SESSION_ID)).resolves.toMatchObject({ model: 'model-a' });
    const original = await readFile(file, 'utf8');
    await writeFile(file, original.replace('model-a', 'model-b'));
    await expect(instance.observe(SESSION_ID)).resolves.toMatchObject({ model: 'model-a' });

    await writeFile(file, `${turnContext('model-b-longer')}\n`);
    await expect(instance.observe(SESSION_ID)).resolves.toMatchObject({ model: 'model-b-longer' });
  });

  it('expires cached observations', async () => {
    const home = await makeHome();
    let now = 1_000;
    const instance = observer(home, { cacheMaxEntries: 1, cacheTtlMs: 100, now: () => now });
    const first = await activePath(home);
    await writeFile(first, turnContext('first-a'));
    await expect(instance.observe(SESSION_ID)).resolves.toMatchObject({ model: 'first-a' });

    await writeFile(first, turnContext('first-b'));
    now = 1_101;
    await expect(instance.observe(SESSION_ID)).resolves.toMatchObject({ model: 'first-b' });
  });

  it('evicts the least-recently-used observation at the configured capacity', async () => {
    const home = await makeHome();
    const instance = observer(home, { cacheMaxEntries: 1 });
    const first = await activePath(home);
    const second = await activePath(home, SECOND_SESSION_ID);
    await writeFile(first, turnContext('first-a'));
    await writeFile(second, turnContext('second'));

    await expect(instance.observe(SESSION_ID)).resolves.toMatchObject({ model: 'first-a' });
    await expect(instance.observe(SECOND_SESSION_ID)).resolves.toMatchObject({ model: 'second' });
    await writeFile(first, turnContext('first-b'));
    await expect(instance.observe(SESSION_ID)).resolves.toMatchObject({ model: 'first-b' });
  });

  it('fails open when CODEX_HOME does not exist or a rollout is malformed', async () => {
    const home = await makeHome();
    const missing = join(home, 'missing');
    await expect(observer(missing).observe(SESSION_ID)).resolves.toBeUndefined();

    const file = await activePath(home);
    await writeFile(file, '{definitely-not-json}\n');
    await expect(observer(home).observe(SESSION_ID)).resolves.toBeUndefined();
  });
});
