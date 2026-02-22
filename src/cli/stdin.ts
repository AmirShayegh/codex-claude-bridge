import { readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { ok, err } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';

let stdinConsumed = false;

export function resetStdinGuard(): void {
  stdinConsumed = false;
}

export async function readInput(
  source: string,
  options?: { stdin?: Readable; timeoutMs?: number },
): Promise<Result<string>> {
  if (source === '-') {
    return readStdin(options);
  }
  return readFileSafe(source);
}

async function readStdin(options?: {
  stdin?: Readable;
  timeoutMs?: number;
}): Promise<Result<string>> {
  if (stdinConsumed) {
    return err('stdin already consumed in this invocation');
  }
  stdinConsumed = true;

  const stream = options?.stdin ?? process.stdin;
  const timeoutMs = options?.timeoutMs ?? 5000;

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    function resetTimer(): void {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          stream.removeAllListeners('data');
          stream.removeAllListeners('end');
          stream.removeAllListeners('error');
          if (chunks.length > 0) {
            resolve(ok(Buffer.concat(chunks).toString('utf-8')));
          } else {
            resolve(err('stdin timeout: no input received within ' + timeoutMs + 'ms'));
          }
        }
      }, timeoutMs);
    }

    resetTimer();

    stream.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      resetTimer();
    });

    stream.on('end', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(ok(Buffer.concat(chunks).toString('utf-8')));
      }
    });

    stream.on('error', (e: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(err(`stdin error: ${e.message}`));
      }
    });
  });
}

async function readFileSafe(path: string): Promise<Result<string>> {
  try {
    const content = await readFile(path, 'utf-8');
    return ok(content);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Failed to read file "${path}": ${msg}`);
  }
}
