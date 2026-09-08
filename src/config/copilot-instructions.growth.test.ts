import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The size check and the read are two steps on one handle. A file that grows in
// between must be caught by the READ — otherwise it is read in full and
// accounted at its old size, and both limits are bypassed. The growth window is
// simulated by a handle whose stat() reports a single byte over a file that is
// far larger. This needs a module-level mock of node:fs/promises, which is why
// it lives apart from the real-filesystem tests.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === 'stat') {
            return async () => {
              const real = await target.stat();
              return { ...real, isFile: () => real.isFile(), size: 1 };
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

import { loadCopilotInstructions, MAX_INSTRUCTION_FILE_BYTES } from './copilot-instructions.js';

const created: string[] = [];
afterAll(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

describe('instruction file growth after the size check', () => {
  it('rejects a repo-wide file that is over the limit at read time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rb-instr-growth-'));
    created.push(root);
    await mkdir(join(root, '.github'), { recursive: true });
    await writeFile(
      join(root, '.github', 'copilot-instructions.md'),
      'x'.repeat(MAX_INSTRUCTION_FILE_BYTES + 1),
    );

    const result = await loadCopilotInstructions(root);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^INVALID_INPUT:.*per-file limit/);
  });

  it('accounts the bytes actually read, not the size reported before the read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rb-instr-growth-'));
    created.push(root);
    // Four scoped files that each stat as 1 byte but are 65 KiB of real
    // content: individually under the per-file limit, together over the
    // 256 KiB aggregate. Only honest accounting catches it.
    const dir = join(root, '.github', 'instructions');
    await mkdir(dir, { recursive: true });
    const body = `---\napplyTo: '**/*.ts'\n---\n${'y'.repeat(MAX_INSTRUCTION_FILE_BYTES - 64)}`;
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await writeFile(join(dir, `${name}.instructions.md`), body);
    }

    const result = await loadCopilotInstructions(root);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^INVALID_INPUT:.*total limit/);
  });
});
