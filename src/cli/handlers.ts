import type { Result } from '../utils/errors.js';

export interface HandlerIO {
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
  exit: (code: number) => void;
  color: boolean;
  json: boolean;
}

export interface HandlerConfig<TResult> {
  execute: () => Promise<Result<TResult>>;
  format: (result: TResult, color: boolean) => string;
  exitCode: (result: TResult) => number;
}

export function createHandler<TResult>(config: HandlerConfig<TResult>): (io: HandlerIO) => Promise<void> {
  return async (io: HandlerIO) => {
    const result = await config.execute();

    if (!result.ok) {
      if (io.json) {
        io.stderr.write(JSON.stringify({ error: result.error }) + '\n');
      } else {
        io.stderr.write(`Error: ${result.error}\n`);
      }
      io.exit(1);
      return;
    }

    if (io.json) {
      io.stdout.write(JSON.stringify(result.data) + '\n');
    } else {
      io.stdout.write(config.format(result.data, io.color) + '\n');
    }

    io.exit(config.exitCode(result.data));
  };
}
