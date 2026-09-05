import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const TEST_TIMEOUT_MS = 20_000;
const BARRIER_TIMEOUT_MS = TEST_TIMEOUT_MS - 2_000;
const migrationModuleUrl = new URL('./db.ts', import.meta.url).href;
const MIGRATION_CHILD_SOURCE = `
  import { openReviewDbWithMetadata } from ${JSON.stringify(migrationModuleUrl)};

  const timeoutMs = Number(process.env.REVIEW_BRIDGE_MIGRATION_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('migration child timeout is not configured');
  }
  if (typeof process.send !== 'function') {
    throw new Error('migration child IPC is not configured');
  }

  function signalReadyAndWaitForGo() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        process.off('message', onMessage);
        process.off('disconnect', onDisconnect);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onMessage = (message) => {
        if (message && message.type === 'go') finish();
      };
      const onDisconnect = () => finish(new Error('migration parent disconnected'));
      const timer = setTimeout(
        () => finish(new Error('timed out waiting for migration IPC barrier')),
        timeoutMs,
      );

      process.on('message', onMessage);
      process.once('disconnect', onDisconnect);
      process.send({ type: 'ready' }, (error) => {
        if (error) finish(error);
      });
    });
  }

  try {
    await signalReadyAndWaitForGo();
    const opened = openReviewDbWithMetadata();
    if (opened.durability !== 'durable' || opened.warning !== null) {
      opened.db.close();
      throw new Error('migration child did not open durable storage');
    }
    opened.db.close();
  } finally {
    if (process.connected) process.disconnect();
  }
`;

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface ChildHandle {
  child: ChildProcess;
  ready: Promise<void>;
  result: Promise<ChildResult>;
}

function startMigrationChild(databasePath: string): ChildHandle {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', MIGRATION_CHILD_SOURCE],
    {
      env: {
        ...process.env,
        REVIEW_BRIDGE_DB: databasePath,
        REVIEW_BRIDGE_MIGRATION_TIMEOUT_MS: String(BARRIER_TIMEOUT_MS),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('error', (error) => {
    stderr += `${error.message}\n`;
  });

  const result = new Promise<ChildResult>((resolve) => {
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });

  const ready = new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('close', onClose);
    };
    const onMessage = (message: unknown): void => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'ready'
      ) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null): void => {
      cleanup();
      reject(new Error(`migration child exited before readiness (code ${String(code)})`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${BARRIER_TIMEOUT_MS}ms waiting for child readiness`));
    }, BARRIER_TIMEOUT_MS);

    child.on('message', onMessage);
    child.once('error', onError);
    child.once('close', onClose);
  });

  return { child, ready, result };
}

function sendGo(handle: ChildHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!handle.child.connected) {
      reject(new Error('migration child disconnected before barrier release'));
      return;
    }
    handle.child.send({ type: 'go' }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function stopChild(handle: ChildHandle): Promise<void> {
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    handle.child.kill();
  }
  const forceKill = setTimeout(() => {
    if (handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.child.kill('SIGKILL');
    }
  }, 1_000);
  forceKill.unref();
  try {
    await handle.result;
  } finally {
    clearTimeout(forceKill);
  }
}

describe('two-process concurrent storage migration', () => {
  it(
    'atomically initializes one legacy database from two independent processes',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'rb-two-process-migration-'));
      const databasePath = join(directory, 'reviews.db');
      const legacy = new Database(databasePath);
      legacy.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'in_progress',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          provider TEXT
        );
        CREATE TABLE reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          verdict TEXT NOT NULL,
          summary TEXT NOT NULL,
          findings_json TEXT NOT NULL,
          timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      legacy.close();
      const children = [startMigrationChild(databasePath), startMigrationChild(databasePath)];

      try {
        await Promise.all(children.map(({ ready }) => ready));
        await Promise.all(children.map(sendGo));
        const results = await Promise.all(children.map(({ result }) => result));

        for (const result of results) {
          expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
        }

        const db = new Database(databasePath, { readonly: true, fileMustExist: true });
        try {
          const sessionColumns = db.pragma('table_info(sessions)') as Array<{ name: string }>;
          const reviewColumns = db.pragma('table_info(reviews)') as Array<{ name: string }>;
          expect(sessionColumns.map((column) => column.name)).toContain('model_identity_json');
          expect(reviewColumns.map((column) => column.name)).toContain('models_json');
        } finally {
          db.close();
        }
      } finally {
        await Promise.all(children.map(stopChild));
        await rm(directory, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
