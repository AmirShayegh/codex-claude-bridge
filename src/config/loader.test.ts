import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadConfig } from './loader.js';
import { DEFAULT_CONFIG } from './types.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from 'node:fs';

const mockReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('loadConfig', () => {
  it('returns DEFAULT_CONFIG when file is missing (ENOENT)', () => {
    const enoent = new Error('ENOENT: no such file or directory');
    (enoent as NodeJS.ErrnoException).code = 'ENOENT';
    mockReadFileSync.mockImplementation(() => {
      throw enoent;
    });

    const result = loadConfig('/some/project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(DEFAULT_CONFIG);
    }
  });

  it('returns err with CONFIG_ERROR for permission denied (EACCES)', () => {
    const eacces = new Error('EACCES: permission denied');
    (eacces as NodeJS.ErrnoException).code = 'EACCES';
    mockReadFileSync.mockImplementation(() => {
      throw eacces;
    });

    const result = loadConfig('/some/project');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CONFIG_ERROR');
      expect(result.error).toContain('.reviewbridge.json');
    }
  });

  it('returns err with CONFIG_ERROR for malformed JSON', () => {
    mockReadFileSync.mockReturnValue('{ not valid json }}}');

    const result = loadConfig('/some/project');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CONFIG_ERROR');
      expect(result.error).toContain('invalid JSON');
    }
  });

  it('returns err with CONFIG_ERROR for invalid values', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ timeout_seconds: -1 }));

    const result = loadConfig('/some/project');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CONFIG_ERROR');
    }
  });

  it('merges partial config with defaults', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ model: 'o3', timeout_seconds: 120 }),
    );

    const result = loadConfig('/some/project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.model).toBe('o3');
      expect(result.data.timeout_seconds).toBe(120);
      expect(result.data.reasoning_effort).toBe('medium');
      expect(result.data.review_standards.plan_review.depth).toBe('thorough');
    }
  });

  it('parses a full valid config file', () => {
    const full = {
      model: 'o3',
      reasoning_effort: 'high',
      timeout_seconds: 600,
      project_context: 'React app',
      review_standards: {
        plan_review: {
          focus: ['security'],
          depth: 'quick',
        },
        code_review: {
          criteria: ['bugs'],
          require_tests: false,
          max_file_size: 1000,
        },
        precommit: {
          auto_diff: false,
          block_on: ['critical'],
        },
      },
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(full));

    const result = loadConfig('/some/project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(full);
    }
  });

  it('reads from correct path based on cwd argument', () => {
    const enoent = new Error('ENOENT');
    (enoent as NodeJS.ErrnoException).code = 'ENOENT';
    mockReadFileSync.mockImplementation(() => {
      throw enoent;
    });

    loadConfig('/my/project');
    expect(mockReadFileSync).toHaveBeenCalledWith(
      '/my/project/.reviewbridge.json',
      'utf-8',
    );
  });
});
