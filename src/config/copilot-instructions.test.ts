import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

import { readFileSync, readdirSync } from 'node:fs';
import {
  parseFrontmatter,
  loadCopilotInstructions,
  filterByFiles,
  formatForPrompt,
} from './copilot-instructions.js';
import type { CopilotInstructions } from './copilot-instructions.js';

const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);

function enoent(): Error {
  const e = new Error('ENOENT: no such file or directory');
  (e as NodeJS.ErrnoException).code = 'ENOENT';
  return e;
}

function eacces(): Error {
  const e = new Error('EACCES: permission denied');
  (e as NodeJS.ErrnoException).code = 'EACCES';
  return e;
}

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
  it('loads repo-wide instructions', () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith('copilot-instructions.md')) return '# Global rules';
      throw enoent();
    });
    mockReaddirSync.mockImplementation(() => { throw enoent(); });

    const result = loadCopilotInstructions('/project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.repoWide).toBe('# Global rules');
      expect(result.data.scoped).toEqual([]);
    }
  });

  it('loads scoped instructions', () => {
    mockReadFileSync.mockImplementation((path) => {
      const p = String(path);
      if (p.endsWith('copilot-instructions.md')) throw enoent();
      if (p.endsWith('ts.instructions.md')) {
        return `---
applyTo: '**/*.ts'
---
Use strict TypeScript.`;
      }
      throw enoent();
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReaddirSync.mockReturnValue(['ts.instructions.md'] as any);

    const result = loadCopilotInstructions('/project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.repoWide).toBeNull();
      expect(result.data.scoped).toHaveLength(1);
      expect(result.data.scoped[0].applyTo).toBe('**/*.ts');
      expect(result.data.scoped[0].body).toContain('Use strict TypeScript.');
    }
  });

  it('skips files with excludeAgent code-review', () => {
    mockReadFileSync.mockImplementation((path) => {
      const p = String(path);
      if (p.endsWith('copilot-instructions.md')) throw enoent();
      if (p.endsWith('ci.instructions.md')) {
        return `---
applyTo: '**/*.yml'
excludeAgent: 'code-review'
---
CI only rules.`;
      }
      return `---
applyTo: '**/*.ts'
---
TS rules.`;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReaddirSync.mockReturnValue(['ci.instructions.md', 'ts.instructions.md'] as any);

    const result = loadCopilotInstructions('/project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.scoped).toHaveLength(1);
      expect(result.data.scoped[0].filename).toBe('ts.instructions.md');
    }
  });

  it('skips files without applyTo', () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith('copilot-instructions.md')) throw enoent();
      return `---
description: 'No applyTo field'
---
Some body.`;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReaddirSync.mockReturnValue(['no-scope.instructions.md'] as any);

    const result = loadCopilotInstructions('/project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.scoped).toEqual([]);
    }
  });

  it('returns empty instructions when .github does not exist', () => {
    mockReadFileSync.mockImplementation(() => { throw enoent(); });
    mockReaddirSync.mockImplementation(() => { throw enoent(); });

    const result = loadCopilotInstructions('/project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.repoWide).toBeNull();
      expect(result.data.scoped).toEqual([]);
    }
  });

  it('returns error on permission failure reading copilot-instructions.md', () => {
    mockReadFileSync.mockImplementation(() => { throw eacces(); });

    const result = loadCopilotInstructions('/project');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CONFIG_ERROR');
    }
  });

  it('returns error on permission failure reading instructions directory', () => {
    mockReadFileSync.mockImplementation(() => { throw enoent(); });
    mockReaddirSync.mockImplementation(() => { throw eacces(); });

    const result = loadCopilotInstructions('/project');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CONFIG_ERROR');
    }
  });

  it('skips individual unreadable instruction files gracefully', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockReadFileSync.mockImplementation((path) => {
      const p = String(path);
      if (p.endsWith('copilot-instructions.md')) throw enoent();
      if (p.endsWith('bad.instructions.md')) throw eacces();
      return `---
applyTo: '**/*.ts'
---
Good file.`;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReaddirSync.mockReturnValue(['bad.instructions.md', 'good.instructions.md'] as any);

    const result = loadCopilotInstructions('/project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.scoped).toHaveLength(1);
      expect(result.data.scoped[0].filename).toBe('good.instructions.md');
    }
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('bad.instructions.md'));
    consoleSpy.mockRestore();
  });

  it('loads both repo-wide and scoped together', () => {
    mockReadFileSync.mockImplementation((path) => {
      const p = String(path);
      if (p.endsWith('copilot-instructions.md')) return '# Global';
      if (p.endsWith('ts.instructions.md')) {
        return `---
applyTo: '**/*.ts'
---
TS rules.`;
      }
      throw enoent();
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReaddirSync.mockReturnValue(['ts.instructions.md'] as any);

    const result = loadCopilotInstructions('/project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.repoWide).toBe('# Global');
      expect(result.data.scoped).toHaveLength(1);
    }
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
    const filenames = result.scoped.map(s => s.filename);
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
