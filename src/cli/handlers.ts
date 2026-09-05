import type { Result } from '../utils/errors.js';
import { escapeTerminalControls, stringifyTerminalSafeJson } from '../utils/terminal.js';

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

const CLI_PROVENANCE = {
  persistence: 'not_recorded',
  warning: null,
} as const;

function withCliProvenance<TResult>(data: TResult): TResult {
  if (
    typeof data !== 'object' ||
    data === null ||
    !('session_id' in data) ||
    typeof data.session_id !== 'string' ||
    ('provenance' in data && data.provenance !== undefined)
  ) {
    return data;
  }
  return { ...data, provenance: CLI_PROVENANCE };
}

export function createHandler<TResult>(
  config: HandlerConfig<TResult>,
): (io: HandlerIO) => Promise<void> {
  return async (io: HandlerIO) => {
    let result: Result<TResult>;
    try {
      result = await config.execute();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result = { ok: false, error: msg };
    }

    if (!result.ok) {
      if (io.json) {
        io.stderr.write(stringifyTerminalSafeJson({ error: result.error }) + '\n');
      } else {
        io.stderr.write(`Error: ${escapeTerminalControls(result.error)}\n`);
      }
      io.exit(1);
      return;
    }

    const output = withCliProvenance(result.data);
    if (io.json) {
      io.stdout.write(stringifyTerminalSafeJson(output) + '\n');
    } else {
      io.stdout.write(config.format(output, io.color) + '\n');
    }

    io.exit(config.exitCode(output));
  };
}
