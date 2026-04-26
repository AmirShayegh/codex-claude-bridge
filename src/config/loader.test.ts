import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig, formatConfigSource } from './loader.js';
import { DEFAULT_CONFIG } from './types.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/Users/test'),
}));

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockHomedir = vi.mocked(homedir);

// Helper: build an fs layout where each path either has content,
// throws ENOENT, or throws another error code.
type Layout = Record<string, string | { error: 'ENOENT' | 'EACCES' | string }>;

function applyLayout(layout: Layout) {
  mockReadFileSync.mockImplementation((path: unknown) => {
    const key = String(path);
    const entry = layout[key];
    if (entry === undefined) {
      const e = new Error(`ENOENT: no such file or directory, open '${key}'`);
      (e as NodeJS.ErrnoException).code = 'ENOENT';
      throw e;
    }
    if (typeof entry === 'object') {
      const e = new Error(`${entry.error}: synthetic`);
      (e as NodeJS.ErrnoException).code = entry.error;
      throw e;
    }
    return entry as unknown as string;
  });

  mockExistsSync.mockImplementation((path: unknown) => {
    return Object.prototype.hasOwnProperty.call(layout, String(path));
  });
}

const ORIGINAL_ENV = process.env.RB_CONFIG_PATH;
const ORIGINAL_CWD = process.cwd;

beforeEach(() => {
  vi.resetAllMocks();
  mockHomedir.mockReturnValue('/Users/test');
  delete process.env.RB_CONFIG_PATH;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.RB_CONFIG_PATH;
  else process.env.RB_CONFIG_PATH = ORIGINAL_ENV;
  process.cwd = ORIGINAL_CWD;
});

describe('loadConfig — explicit mode (cwd argument supplied)', () => {
  it('loads from cwd/.reviewbridge.json when present', () => {
    applyLayout({
      '/some/project/.reviewbridge.json': JSON.stringify({ model: 'gpt-5.4' }),
    });

    const result = loadConfig('/some/project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.config.model).toBe('gpt-5.4');
      expect(result.data.source).toEqual({
        kind: 'project',
        path: '/some/project/.reviewbridge.json',
      });
    }
  });

  it('returns default source on ENOENT (does not consult env or $HOME)', () => {
    process.env.RB_CONFIG_PATH = '/should/be/ignored.json';
    applyLayout({
      '/Users/test/.reviewbridge.json': JSON.stringify({ model: 'gpt-5.4' }),
    });

    const result = loadConfig('/some/project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toEqual({ kind: 'default' });
      expect(result.data.config).toEqual(DEFAULT_CONFIG);
    }
  });

  it('aborts on EACCES', () => {
    applyLayout({
      '/some/project/.reviewbridge.json': { error: 'EACCES' },
    });

    const result = loadConfig('/some/project');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CONFIG_ERROR');
      expect(result.error).toContain('/some/project/.reviewbridge.json');
    }
  });

  it('aborts on invalid JSON', () => {
    applyLayout({
      '/some/project/.reviewbridge.json': '{ not valid json }}}',
    });

    const result = loadConfig('/some/project');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CONFIG_ERROR');
      expect(result.error).toContain('invalid JSON');
    }
  });

  it('aborts on schema validation failure', () => {
    applyLayout({
      '/some/project/.reviewbridge.json': JSON.stringify({ timeout_seconds: -1 }),
    });

    const result = loadConfig('/some/project');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CONFIG_ERROR');
    }
  });

  it('merges partial config with defaults', () => {
    applyLayout({
      '/some/project/.reviewbridge.json': JSON.stringify({
        model: 'gpt-5.4',
        timeout_seconds: 120,
      }),
    });

    const result = loadConfig('/some/project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.config.model).toBe('gpt-5.4');
      expect(result.data.config.timeout_seconds).toBe(120);
      expect(result.data.config.reasoning_effort).toBe('medium');
      expect(result.data.config.review_standards.plan_review.depth).toBe('thorough');
    }
  });
});

describe('loadConfig — implicit mode, env override (RB_CONFIG_PATH)', () => {
  it('loads from RB_CONFIG_PATH when set', () => {
    process.env.RB_CONFIG_PATH = '/etc/reviewbridge.json';
    applyLayout({
      '/etc/reviewbridge.json': JSON.stringify({ model: 'gpt-5.4' }),
    });

    const result = loadConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toEqual({ kind: 'env', path: '/etc/reviewbridge.json' });
      expect(result.data.config.model).toBe('gpt-5.4');
    }
  });

  it('aborts when RB_CONFIG_PATH file is missing (ENOENT)', () => {
    process.env.RB_CONFIG_PATH = '/missing.json';
    applyLayout({}); // nothing exists

    const result = loadConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CONFIG_ERROR');
      expect(result.error).toContain('RB_CONFIG_PATH');
      expect(result.error).toContain('/missing.json');
    }
  });

  it('aborts on EACCES at env path', () => {
    process.env.RB_CONFIG_PATH = '/etc/locked.json';
    applyLayout({ '/etc/locked.json': { error: 'EACCES' } });

    const result = loadConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CONFIG_ERROR');
    }
  });

  it('aborts on invalid JSON at env path', () => {
    process.env.RB_CONFIG_PATH = '/etc/bad.json';
    applyLayout({ '/etc/bad.json': '{ not valid json' });

    const result = loadConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('invalid JSON');
    }
  });

  it('treats empty-string env var as unset', () => {
    process.env.RB_CONFIG_PATH = '';
    applyLayout({}); // no config anywhere
    process.cwd = () => '/tmp/empty';

    const result = loadConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toEqual({ kind: 'default' });
    }
  });
});

describe('loadConfig — implicit mode, walk-up', () => {
  it('finds .reviewbridge.json in process.cwd()', () => {
    process.cwd = () => '/repo';
    applyLayout({
      '/repo/.reviewbridge.json': JSON.stringify({ model: 'gpt-5.4' }),
    });

    const result = loadConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toEqual({
        kind: 'project',
        path: '/repo/.reviewbridge.json',
      });
    }
  });

  it('walks up to ancestor when no .git boundary blocks it', () => {
    process.cwd = () => '/a/b/c';
    applyLayout({
      '/a/.reviewbridge.json': JSON.stringify({ model: 'gpt-5.4' }),
    });

    const result = loadConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toEqual({
        kind: 'project',
        path: '/a/.reviewbridge.json',
      });
    }
  });

  it('stops walk-up at .git boundary', () => {
    process.cwd = () => '/repo/sub/dir';
    applyLayout({
      '/repo/.git': '', // .git file (worktree) at /repo
      '/.reviewbridge.json': JSON.stringify({ model: 'gpt-5.4' }), // above git boundary
      '/Users/test/.reviewbridge.json': JSON.stringify({ model: 'gpt-5.4' }),
    });

    const result = loadConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Walk-up should stop at /repo (.git found there), then fall through to $HOME.
      expect(result.data.source.kind).toBe('user');
    }
  });

  it('aborts when walk-up finds a malformed .reviewbridge.json (does NOT continue cascading)', () => {
    process.cwd = () => '/repo';
    applyLayout({
      '/repo/.reviewbridge.json': '{ broken',
      '/Users/test/.reviewbridge.json': JSON.stringify({ model: 'gpt-5.4' }),
    });

    const result = loadConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('invalid JSON');
      expect(result.error).toContain('/repo/.reviewbridge.json');
    }
  });
});

describe('loadConfig — implicit mode, $HOME fallback', () => {
  it('uses $HOME/.reviewbridge.json when walk-up finds nothing', () => {
    process.cwd = () => '/tmp/some/dir';
    applyLayout({
      '/Users/test/.reviewbridge.json': JSON.stringify({ model: 'gpt-5.4' }),
    });

    const result = loadConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toEqual({
        kind: 'user',
        path: '/Users/test/.reviewbridge.json',
      });
      expect(result.data.config.model).toBe('gpt-5.4');
    }
  });

  it('aborts when $HOME file exists but is malformed', () => {
    process.cwd = () => '/tmp/empty';
    applyLayout({
      '/Users/test/.reviewbridge.json': '{ broken',
    });

    const result = loadConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('invalid JSON');
      expect(result.error).toContain('/Users/test/.reviewbridge.json');
    }
  });

  it('merges partial $HOME config with defaults', () => {
    process.cwd = () => '/tmp/empty';
    applyLayout({
      '/Users/test/.reviewbridge.json': JSON.stringify({ model: 'gpt-5.4' }),
    });

    const result = loadConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.config.model).toBe('gpt-5.4');
      expect(result.data.config.timeout_seconds).toBe(300); // default
    }
  });
});

describe('loadConfig — default fallthrough', () => {
  it('returns default source when nothing is found anywhere', () => {
    process.cwd = () => '/tmp/empty';
    applyLayout({}); // nothing

    const result = loadConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toEqual({ kind: 'default' });
      expect(result.data.config).toEqual(DEFAULT_CONFIG);
    }
  });

  it('returns isolated config objects on repeated default-branch calls', () => {
    process.cwd = () => '/tmp/empty';
    applyLayout({});

    const r1 = loadConfig();
    const r2 = loadConfig();
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      r1.data.config.model = 'mutated';
      r1.data.config.review_standards.precommit.block_on.push('minor');
      expect(r2.data.config.model).toBe('gpt-5.5');
      expect(r2.data.config.review_standards.precommit.block_on).toEqual([
        'critical',
        'major',
      ]);
    }
  });
});

describe('loadConfig — precedence', () => {
  it('env var wins over walk-up project config', () => {
    process.env.RB_CONFIG_PATH = '/etc/reviewbridge.json';
    process.cwd = () => '/repo';
    applyLayout({
      '/etc/reviewbridge.json': JSON.stringify({ model: 'env-model' }),
      '/repo/.reviewbridge.json': JSON.stringify({ model: 'project-model' }),
    });

    const result = loadConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source.kind).toBe('env');
      expect(result.data.config.model).toBe('env-model');
    }
  });

  it('walk-up project config wins over $HOME', () => {
    process.cwd = () => '/repo';
    applyLayout({
      '/repo/.reviewbridge.json': JSON.stringify({ model: 'project-model' }),
      '/Users/test/.reviewbridge.json': JSON.stringify({ model: 'user-model' }),
    });

    const result = loadConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source.kind).toBe('project');
      expect(result.data.config.model).toBe('project-model');
    }
  });
});

describe('formatConfigSource', () => {
  it('formats default as "default"', () => {
    expect(formatConfigSource({ kind: 'default' })).toBe('default');
  });

  it('formats env with path', () => {
    expect(formatConfigSource({ kind: 'env', path: '/etc/x.json' })).toBe(
      'env (/etc/x.json)',
    );
  });

  it('formats project with path', () => {
    expect(formatConfigSource({ kind: 'project', path: '/repo/.reviewbridge.json' })).toBe(
      'project (/repo/.reviewbridge.json)',
    );
  });

  it('formats user with path', () => {
    expect(formatConfigSource({ kind: 'user', path: '/Users/me/.reviewbridge.json' })).toBe(
      'user (/Users/me/.reviewbridge.json)',
    );
  });
});
