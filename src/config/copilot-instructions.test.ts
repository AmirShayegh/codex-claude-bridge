import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import {
  parseFrontmatter,
  loadCopilotInstructions,
  filterByFiles,
  formatForPrompt,
  MAX_SCOPED_INSTRUCTION_FILES,
  MAX_INSTRUCTION_FILE_BYTES,
  MAX_INSTRUCTION_AGGREGATE_BYTES,
} from './copilot-instructions.js';
import type { CopilotInstructions } from './copilot-instructions.js';

// Real directories. This module's entire job is reading a tree the CALLER names,
// and the size and count bounds only mean anything against real files — a mocked
// fs would happily "enforce" a limit on numbers the test made up.
const created: string[] = [];
async function projectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rb-instr-'));
  created.push(dir);
  return dir;
}

async function writeRepoWide(root: string, body: string): Promise<void> {
  await mkdir(join(root, '.github'), { recursive: true });
  await writeFile(join(root, '.github', 'copilot-instructions.md'), body);
}

async function writeScoped(root: string, filename: string, body: string): Promise<void> {
  await mkdir(join(root, '.github', 'instructions'), { recursive: true });
  await writeFile(join(root, '.github', 'instructions', filename), body);
}

function scopedFile(applyTo: string, body: string): string {
  return `---\napplyTo: '${applyTo}'\n---\n${body}`;
}

// chmod-based permission tests are silently vacuous under root.
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

// Some tests chmod a file or directory to 0o000; rm cannot descend past that,
// so permissions are restored top-down before removal.
async function restorePermissions(path: string): Promise<void> {
  await chmod(path, 0o755).catch(() => {});
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await restorePermissions(child);
    else await chmod(child, 0o644).catch(() => {});
  }
}

afterAll(async () => {
  for (const dir of created) {
    await restorePermissions(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  it('parses valid frontmatter', () => {
    const content = `---
applyTo: '**/*.ts'
description: 'TypeScript rules'
---

# Rules
Use strict mode.`;

    const result = parseFrontmatter(content);
    expect(result.frontmatter.applyTo).toBe('**/*.ts');
    expect(result.frontmatter.description).toBe('TypeScript rules');
    expect(result.body).toContain('# Rules');
    expect(result.body).toContain('Use strict mode.');
  });

  it('strips double quotes from values', () => {
    const content = `---
applyTo: "src/**/*.ts"
---
body`;
    expect(parseFrontmatter(content).frontmatter.applyTo).toBe('src/**/*.ts');
  });

  it('returns empty frontmatter when no delimiters', () => {
    const content = '# Just markdown\nNo frontmatter here.';
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(content);
  });

  it('returns empty frontmatter when only opening delimiter', () => {
    const content = '---\napplyTo: "**"\nno closing delimiter';
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({});
  });

  it('handles empty body after frontmatter', () => {
    const content = `---
applyTo: '**/*.ts'
---`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.applyTo).toBe('**/*.ts');
    expect(result.body).toBe('');
  });

  it('handles excludeAgent field', () => {
    const content = `---
applyTo: '**/*.ts'
excludeAgent: 'code-review'
---
body`;
    expect(parseFrontmatter(content).frontmatter.excludeAgent).toBe('code-review');
  });

  it('does not match --- inside body content', () => {
    const content = `---
applyTo: '**/*.ts'
---
Some text
---
More text after horizontal rule`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.applyTo).toBe('**/*.ts');
    expect(result.body).toContain('Some text');
    expect(result.body).toContain('---');
    expect(result.body).toContain('More text after horizontal rule');
  });
});

// ---------------------------------------------------------------------------
// loadCopilotInstructions
// ---------------------------------------------------------------------------

describe('loadCopilotInstructions', () => {
  it('loads repo-wide instructions', async () => {
    const root = await projectDir();
    await writeRepoWide(root, '# Global rules');

    const result = await loadCopilotInstructions(root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.repoWide).toBe('# Global rules');
      expect(result.data.scoped).toEqual([]);
    }
  });

  it('loads scoped instructions', async () => {
    const root = await projectDir();
    await writeScoped(root, 'ts.instructions.md', scopedFile('**/*.ts', 'Use strict TypeScript.'));

    const result = await loadCopilotInstructions(root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.repoWide).toBeNull();
      expect(result.data.scoped).toHaveLength(1);
      expect(result.data.scoped[0].applyTo).toBe('**/*.ts');
      expect(result.data.scoped[0].body).toContain('Use strict TypeScript.');
    }
  });

  it('reads the tree under the ROOT it is given, not the process directory', async () => {
    // The whole point of ISS-027: a review of repository B must pick up B's
    // instructions even though the server was started somewhere else entirely.
    const a = await projectDir();
    const b = await projectDir();
    await writeRepoWide(a, '# Repository A');
    await writeRepoWide(b, '# Repository B');

    const result = await loadCopilotInstructions(b);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.repoWide).toBe('# Repository B');
  });

  it('skips files with excludeAgent code-review', async () => {
    const root = await projectDir();
    await writeScoped(
      root,
      'ci.instructions.md',
      `---\napplyTo: '**/*.yml'\nexcludeAgent: 'code-review'\n---\nCI only rules.`,
    );
    await writeScoped(root, 'ts.instructions.md', scopedFile('**/*.ts', 'TS rules.'));

    const result = await loadCopilotInstructions(root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.scoped).toHaveLength(1);
      expect(result.data.scoped[0].filename).toBe('ts.instructions.md');
    }
  });

  it('skips files with excludeAgent containing code-review in comma-separated list', async () => {
    const root = await projectDir();
    await writeScoped(
      root,
      'multi.instructions.md',
      `---\napplyTo: '**/*.yml'\nexcludeAgent: 'coding-agent, code-review'\n---\nMulti-excluded.`,
    );
    await writeScoped(root, 'ts.instructions.md', scopedFile('**/*.ts', 'TS rules.'));

    const result = await loadCopilotInstructions(root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.scoped).toHaveLength(1);
      expect(result.data.scoped[0].filename).toBe('ts.instructions.md');
    }
  });

  it('skips files without applyTo', async () => {
    const root = await projectDir();
    await writeScoped(
      root,
      'no-scope.instructions.md',
      `---\ndescription: 'No applyTo field'\n---\nSome body.`,
    );

    const result = await loadCopilotInstructions(root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.scoped).toEqual([]);
  });

  it('ignores files that are not *.instructions.md', async () => {
    const root = await projectDir();
    await writeScoped(root, 'README.md', scopedFile('**/*.ts', 'Not an instruction file.'));

    const result = await loadCopilotInstructions(root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.scoped).toEqual([]);
  });

  it('returns empty instructions when .github does not exist', async () => {
    const root = await projectDir();

    const result = await loadCopilotInstructions(root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.repoWide).toBeNull();
      expect(result.data.scoped).toEqual([]);
    }
  });

  it('treats a non-directory .github/instructions as no instructions', async () => {
    const root = await projectDir();
    await mkdir(join(root, '.github'), { recursive: true });
    await writeFile(join(root, '.github', 'instructions'), 'not a directory');

    const result = await loadCopilotInstructions(root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.scoped).toEqual([]);
  });

  it('treats a directory named copilot-instructions.md as absent', async () => {
    const root = await projectDir();
    await mkdir(join(root, '.github', 'copilot-instructions.md'), { recursive: true });

    const result = await loadCopilotInstructions(root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.repoWide).toBeNull();
  });

  it.skipIf(asRoot)(
    'returns error on permission failure reading copilot-instructions.md',
    async () => {
      const root = await projectDir();
      await writeRepoWide(root, '# Global');
      await chmod(join(root, '.github', 'copilot-instructions.md'), 0o000);

      const result = await loadCopilotInstructions(root);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('CONFIG_ERROR');
    },
  );

  it.skipIf(asRoot)(
    'returns error on permission failure reading instructions directory',
    async () => {
      const root = await projectDir();
      await writeScoped(root, 'ts.instructions.md', scopedFile('**/*.ts', 'TS rules.'));
      await chmod(join(root, '.github', 'instructions'), 0o000);

      const result = await loadCopilotInstructions(root);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('CONFIG_ERROR');
    },
  );

  it.skipIf(asRoot)('skips individual unreadable instruction files gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = await projectDir();
    await writeScoped(root, 'bad.instructions.md', scopedFile('**/*.ts', 'Unreadable.'));
    await writeScoped(root, 'good.instructions.md', scopedFile('**/*.ts', 'Good file.'));
    await chmod(join(root, '.github', 'instructions', 'bad.instructions.md'), 0o000);

    const result = await loadCopilotInstructions(root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.scoped).toHaveLength(1);
      expect(result.data.scoped[0].filename).toBe('good.instructions.md');
    }
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('bad.instructions.md'));
    consoleSpy.mockRestore();
  });

  it('loads both repo-wide and scoped together', async () => {
    const root = await projectDir();
    await writeRepoWide(root, '# Global');
    await writeScoped(root, 'ts.instructions.md', scopedFile('**/*.ts', 'TS rules.'));

    const result = await loadCopilotInstructions(root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.repoWide).toBe('# Global');
      expect(result.data.scoped).toHaveLength(1);
    }
  });

  it('orders scoped instructions by filename so the prompt is stable', async () => {
    // Directory order is filesystem-dependent; an unstable prompt would defeat
    // provider-side caching and make review output non-reproducible.
    const root = await projectDir();
    for (const name of ['zulu', 'alpha', 'mike']) {
      await writeScoped(root, `${name}.instructions.md`, scopedFile('**/*.ts', `${name} rules.`));
    }

    const result = await loadCopilotInstructions(root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.scoped.map((s) => s.filename)).toEqual([
        'alpha.instructions.md',
        'mike.instructions.md',
        'zulu.instructions.md',
      ]);
    }
  });

  it('freezes the result so concurrent requests cannot alter each other', async () => {
    const root = await projectDir();
    await writeScoped(root, 'ts.instructions.md', scopedFile('**/*.ts', 'TS rules.'));

    const result = await loadCopilotInstructions(root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.data)).toBe(true);
      expect(Object.isFrozen(result.data.scoped)).toBe(true);
    }
  });

  describe('bounds', () => {
    it('rejects a repo-wide file over the per-file limit', async () => {
      const root = await projectDir();
      await writeRepoWide(root, 'x'.repeat(MAX_INSTRUCTION_FILE_BYTES + 1));

      const result = await loadCopilotInstructions(root);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/^INVALID_INPUT:/);
        expect(result.error).toContain('per-file limit');
      }
    });

    it('accepts a repo-wide file exactly at the per-file limit', async () => {
      const root = await projectDir();
      await writeRepoWide(root, 'x'.repeat(MAX_INSTRUCTION_FILE_BYTES));
      expect((await loadCopilotInstructions(root)).ok).toBe(true);
    });

    it('rejects a scoped file over the per-file limit', async () => {
      const root = await projectDir();
      await writeScoped(
        root,
        'big.instructions.md',
        scopedFile('**/*.ts', 'x'.repeat(MAX_INSTRUCTION_FILE_BYTES)),
      );

      const result = await loadCopilotInstructions(root);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/^INVALID_INPUT:/);
    });

    it('rejects more scoped files than the count limit', async () => {
      const root = await projectDir();
      for (let i = 0; i <= MAX_SCOPED_INSTRUCTION_FILES; i++) {
        await writeScoped(root, `f${i}.instructions.md`, scopedFile('**/*.ts', `rule ${i}`));
      }

      const result = await loadCopilotInstructions(root);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/^INVALID_INPUT:/);
        expect(result.error).toContain('file limit');
      }
    });

    it('accepts exactly the count limit', async () => {
      const root = await projectDir();
      for (let i = 0; i < MAX_SCOPED_INSTRUCTION_FILES; i++) {
        await writeScoped(root, `f${i}.instructions.md`, scopedFile('**/*.ts', `rule ${i}`));
      }

      const result = await loadCopilotInstructions(root);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.scoped).toHaveLength(MAX_SCOPED_INSTRUCTION_FILES);
    });

    it('rejects files that are each legal but together exceed the aggregate limit', async () => {
      const root = await projectDir();
      const size = MAX_INSTRUCTION_FILE_BYTES - 64;
      const needed = Math.ceil(MAX_INSTRUCTION_AGGREGATE_BYTES / size);
      for (let i = 0; i <= needed; i++) {
        await writeScoped(root, `f${i}.instructions.md`, scopedFile('**/*.ts', 'x'.repeat(size)));
      }

      const result = await loadCopilotInstructions(root);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/^INVALID_INPUT:/);
        expect(result.error).toContain('total limit');
      }
    });

    it('escapes control characters in a limit message', async () => {
      // A limit message names the file, and the file name comes off a disk the
      // caller pointed us at — it must not be able to repaint a terminal.
      const esc = String.fromCharCode(27);
      const root = await projectDir();
      await writeScoped(
        root,
        `we${esc}[31mird.instructions.md`,
        scopedFile('**/*.ts', 'x'.repeat(MAX_INSTRUCTION_FILE_BYTES)),
      );

      const result = await loadCopilotInstructions(root);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('\\x1B');
        expect(result.error).not.toContain(esc);
      }
    });
  });

  // A named pipe where an instruction file is expected. open() on a FIFO blocks
  // until a writer appears — which may be never — and this load runs while a
  // preparation permit is held, so blocking here wedges the server permanently.
  // A 5s test timeout turns a regression into a failure rather than a hang.
  describe('non-regular files', () => {
    async function mkfifo(path: string): Promise<boolean> {
      try {
        await promisify(execFile)('mkfifo', [path]);
        return true;
      } catch {
        return false;
      }
    }

    it('skips a FIFO where the repo-wide file belongs instead of blocking on it', async () => {
      const root = await projectDir();
      await mkdir(join(root, '.github'), { recursive: true });
      if (!(await mkfifo(join(root, '.github', 'copilot-instructions.md')))) return;

      const result = await loadCopilotInstructions(root);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.repoWide).toBeNull();
    });

    it('skips a FIFO among the scoped files and still reads the real ones', async () => {
      const root = await projectDir();
      await writeScoped(root, 'real.instructions.md', scopedFile('**/*.ts', 'real body'));
      if (!(await mkfifo(join(root, '.github', 'instructions', 'pipe.instructions.md')))) return;

      const result = await loadCopilotInstructions(root);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.scoped.map((s) => s.filename)).toEqual(['real.instructions.md']);
      }
    });
  });

  describe('coalescing', () => {
    it('serves concurrent loads of one root from a single read', async () => {
      const root = await projectDir();
      await writeRepoWide(root, '# Global');

      const first = loadCopilotInstructions(root);
      const second = loadCopilotInstructions(root);
      expect(first).toBe(second);
      expect(await first).toBe(await second);
    });

    it('does not share a load between different roots', async () => {
      const a = await projectDir();
      const b = await projectDir();
      await writeRepoWide(a, '# A');
      await writeRepoWide(b, '# B');

      const [ra, rb] = await Promise.all([loadCopilotInstructions(a), loadCopilotInstructions(b)]);
      expect(ra.ok && ra.data.repoWide).toBe('# A');
      expect(rb.ok && rb.data.repoWide).toBe('# B');
    });

    it('drops the in-flight entry once the load settles', async () => {
      const root = await projectDir();
      await writeRepoWide(root, '# Global');

      const first = loadCopilotInstructions(root);
      await first;
      expect(loadCopilotInstructions(root)).not.toBe(first);
    });

    it('picks up an edited instruction file on the next review', async () => {
      // Coalescing must not become caching: a fix to the review guidelines has
      // to take effect without restarting the server.
      const root = await projectDir();
      await writeRepoWide(root, '# One');
      const before = await loadCopilotInstructions(root);
      await writeRepoWide(root, '# Two');
      const after = await loadCopilotInstructions(root);

      expect(before.ok && before.data.repoWide).toBe('# One');
      expect(after.ok && after.data.repoWide).toBe('# Two');
    });

    it('does not pin a failure for every later request', async () => {
      const root = await projectDir();
      await writeRepoWide(root, 'x'.repeat(MAX_INSTRUCTION_FILE_BYTES + 1));
      expect((await loadCopilotInstructions(root)).ok).toBe(false);

      await writeRepoWide(root, '# Fixed');
      const retried = await loadCopilotInstructions(root);
      expect(retried.ok).toBe(true);
      if (retried.ok) expect(retried.data.repoWide).toBe('# Fixed');
    });
  });
});

// ---------------------------------------------------------------------------
// filterByFiles
// ---------------------------------------------------------------------------

describe('filterByFiles', () => {
  const instructions: CopilotInstructions = {
    repoWide: '# Global',
    scoped: [
      { applyTo: '**/*.ts', body: 'TS rules', filename: 'ts.instructions.md' },
      { applyTo: '**/*.py', body: 'Python rules', filename: 'py.instructions.md' },
      { applyTo: 'src/config/**', body: 'Config rules', filename: 'config.instructions.md' },
    ],
  };

  it('filters to matching scoped instructions', () => {
    const result = filterByFiles(instructions, ['src/foo.ts', 'src/bar.ts']);
    expect(result.repoWide).toBe('# Global');
    expect(result.scoped).toHaveLength(1);
    expect(result.scoped[0].filename).toBe('ts.instructions.md');
  });

  it('matches multiple scoped instructions', () => {
    const result = filterByFiles(instructions, ['src/config/loader.ts']);
    expect(result.scoped).toHaveLength(2);
    const filenames = result.scoped.map((s) => s.filename);
    expect(filenames).toContain('ts.instructions.md');
    expect(filenames).toContain('config.instructions.md');
  });

  it('returns no scoped when no files match', () => {
    const result = filterByFiles(instructions, ['README.md']);
    expect(result.repoWide).toBe('# Global');
    expect(result.scoped).toEqual([]);
  });

  it('returns empty for empty file list', () => {
    const result = filterByFiles(instructions, []);
    expect(result.scoped).toEqual([]);
  });

  it('returns empty for undefined instructions', () => {
    const result = filterByFiles(undefined, ['src/foo.ts']);
    expect(result.repoWide).toBeNull();
    expect(result.scoped).toEqual([]);
  });

  it('handles comma-separated applyTo patterns', () => {
    const instr: CopilotInstructions = {
      repoWide: null,
      scoped: [
        { applyTo: '**/*.ts, **/*.tsx', body: 'TS/TSX rules', filename: 'tsx.instructions.md' },
      ],
    };
    const result = filterByFiles(instr, ['src/App.tsx']);
    expect(result.scoped).toHaveLength(1);
  });

  it('handles non-matching glob patterns gracefully', () => {
    const instr: CopilotInstructions = {
      repoWide: null,
      scoped: [
        { applyTo: '[invalid', body: 'Bad glob', filename: 'bad.instructions.md' },
        { applyTo: '**/*.ts', body: 'Good glob', filename: 'good.instructions.md' },
      ],
    };
    const result = filterByFiles(instr, ['src/foo.ts']);
    expect(result.scoped).toHaveLength(1);
    expect(result.scoped[0].filename).toBe('good.instructions.md');
  });

  it('passes through instructions with no scoped entries', () => {
    const instr: CopilotInstructions = { repoWide: '# Global', scoped: [] };
    const result = filterByFiles(instr, ['any-file.ts']);
    expect(result).toBe(instr);
  });
});

// ---------------------------------------------------------------------------
// formatForPrompt
// ---------------------------------------------------------------------------

describe('formatForPrompt', () => {
  it('formats repo-wide only', () => {
    const result = formatForPrompt({ repoWide: '# Global rules', scoped: [] });
    expect(result).toBe('# Global rules');
  });

  it('formats scoped only', () => {
    const result = formatForPrompt({
      repoWide: null,
      scoped: [{ applyTo: '**/*.ts', body: 'TS rules', filename: 'ts.instructions.md' }],
    });
    expect(result).toBe('TS rules');
  });

  it('formats both repo-wide and scoped', () => {
    const result = formatForPrompt({
      repoWide: '# Global',
      scoped: [
        { applyTo: '**/*.ts', body: 'TS rules', filename: 'ts.instructions.md' },
        { applyTo: '**/*.py', body: 'Python rules', filename: 'py.instructions.md' },
      ],
    });
    expect(result).toBe('# Global\n\nTS rules\n\nPython rules');
  });

  it('returns empty string for no instructions', () => {
    expect(formatForPrompt({ repoWide: null, scoped: [] })).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(formatForPrompt(undefined)).toBe('');
  });

  it('trims whitespace from bodies', () => {
    const result = formatForPrompt({
      repoWide: '  # Global  \n',
      scoped: [{ applyTo: '**', body: '  Rules  \n', filename: 'a.instructions.md' }],
    });
    expect(result).toBe('# Global\n\nRules');
  });
});
