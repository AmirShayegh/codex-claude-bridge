import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadConfig,
  formatConfigSource,
  discoverProjectConfig,
  resetConfigWarningMemo,
} from './loader.js';
import { DEFAULT_CONFIG } from './types.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/Users/test'),
}));

import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockStatSync = vi.mocked(statSync);
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

// Minimal fake fs.Stats — only mtimeMs is read by loader.ts. One `as` cast
// (not `any`), matching the rest of this file's mocking style.
function fakeStats(mtimeMs: number) {
  return { mtimeMs } as ReturnType<typeof statSync>;
}

const ORIGINAL_ENV = process.env.RB_CONFIG_PATH;
const ORIGINAL_CWD = process.cwd;

beforeEach(() => {
  vi.resetAllMocks();
  mockHomedir.mockReturnValue('/Users/test');
  // Stable default mtime for every path — existing tests below don't care
  // about mtime and expect the pre-P2 "warns once per path" behavior, which
  // this preserves (same path + same mtime = same memo key). Tests that
  // specifically exercise mtime-based re-warning override this.
  mockStatSync.mockReturnValue(fakeStats(1000));
  delete process.env.RB_CONFIG_PATH;
  // warnUnknownConfigKeys' one-time-per-(path,mtime) memo is process-lifetime
  // module state, not a vi mock — vi.resetAllMocks() above doesn't touch it.
  // Several tests below intentionally reuse the same config path across
  // cases, so it must be cleared here or a later test's warning assertion
  // would silently never fire (already "warned" by an earlier test in this
  // file, at the same default mtime).
  resetConfigWarningMemo();
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
      expect(r2.data.config.model).toBeUndefined();
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

describe('loadConfig — unknown-key warnings (ISS-004)', () => {
  it('warns on an unrecognized top-level key but still loads the config', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    applyLayout({
      '/p/.reviewbridge.json': JSON.stringify({ model: 'gpt-5.4', bogus_field: 1 }),
    });

    const result = loadConfig('/p');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.config.model).toBe('gpt-5.4'); // known key still applied
    const warnings = spy.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes('<root>') && w.includes('bogus_field'))).toBe(true);
    spy.mockRestore();
  });

  it('warns on an unrecognized NESTED key (review_standards.code_review) — e.g. a leftover max_file_size', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    applyLayout({
      '/p/.reviewbridge.json': JSON.stringify({
        review_standards: { code_review: { require_tests: false, max_file_size: 500 } },
      }),
    });

    const result = loadConfig('/p');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.config.review_standards.code_review.require_tests).toBe(false);
    const warnings = spy.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes('review_standards.code_review') && w.includes('max_file_size'))).toBe(true);
    spy.mockRestore();
  });

  it('emits no warning for a clean config', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    applyLayout({
      '/p/.reviewbridge.json': JSON.stringify({ model: 'gpt-5.4', review_standards: { precommit: { auto_diff: false } } }),
    });

    const result = loadConfig('/p');

    expect(result.ok).toBe(true);
    const warnings = spy.mock.calls.map((c) => String(c[0])).filter((w) => w.includes('unrecognized config field'));
    expect(warnings).toHaveLength(0);
    spy.mockRestore();
  });

  it('does not throw when a nested section is a non-object', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // review_standards as a string — the schema rejects it, so this should error
    // cleanly (not crash the unknown-key walk).
    applyLayout({ '/p/.reviewbridge.json': JSON.stringify({ review_standards: 'nope' }) });
    expect(() => loadConfig('/p')).not.toThrow();
    spy.mockRestore();
  });

  it('warns only once per (path, mtime) across repeated loads of the SAME unchanged file (F9)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    applyLayout({
      '/p/.reviewbridge.json': JSON.stringify({ model: 'gpt-5.4', bogus_field: 1 }),
    });
    // mtime stays at the beforeEach default (1000) for every read — an
    // unchanged file, the common case.

    loadConfig('/p');
    loadConfig('/p');
    loadConfig('/p');

    const warnings = spy.mock.calls
      .map((c) => String(c[0]))
      .filter((w) => w.includes('unrecognized config field'));
    expect(warnings).toHaveLength(1);
    spy.mockRestore();
  });

  it('P2: an EDITED file (different mtime, new unknown key) re-warns instead of being silently suppressed by the earlier warning', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // First read: mtime 1000, one unknown key (old_bogus).
    mockStatSync.mockReturnValueOnce(fakeStats(1000));
    applyLayout({
      '/p/.reviewbridge.json': JSON.stringify({ model: 'gpt-5.4', old_bogus: 1 }),
    });
    loadConfig('/p');

    // "Edit" the file mid-process: same path, later mtime, a DIFFERENT
    // unknown key. Before P2 (path-only keying) this second call would have
    // been silently swallowed by the first call's memo entry — new_bogus
    // would never surface.
    mockStatSync.mockReturnValueOnce(fakeStats(2000));
    applyLayout({
      '/p/.reviewbridge.json': JSON.stringify({ model: 'gpt-5.4', new_bogus: 1 }),
    });
    loadConfig('/p');

    const warnings = spy.mock.calls
      .map((c) => String(c[0]))
      .filter((w) => w.includes('unrecognized config field'));
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes('old_bogus'))).toBe(true);
    expect(warnings.some((w) => w.includes('new_bogus'))).toBe(true);
    spy.mockRestore();
  });

  it('still warns for a DIFFERENT path even after another path was already warned', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    applyLayout({
      '/p1/.reviewbridge.json': JSON.stringify({ bogus_a: 1 }),
      '/p2/.reviewbridge.json': JSON.stringify({ bogus_b: 1 }),
    });

    loadConfig('/p1');
    loadConfig('/p2');

    const warnings = spy.mock.calls
      .map((c) => String(c[0]))
      .filter((w) => w.includes('unrecognized config field'));
    expect(warnings.some((w) => w.includes('bogus_a'))).toBe(true);
    expect(warnings.some((w) => w.includes('bogus_b'))).toBe(true);
    spy.mockRestore();
  });
});

describe('discoverProjectConfig (F4)', () => {
  it('finds .reviewbridge.json in the exact start directory', () => {
    applyLayout({
      '/repo/.reviewbridge.json': JSON.stringify({ model: 'gpt-5.4' }),
    });

    const result = discoverProjectConfig('/repo');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.config.model).toBe('gpt-5.4');
      expect(result.data?.source).toEqual({ kind: 'project', path: '/repo/.reviewbridge.json' });
    }
  });

  it("walks up from a SUBDIRECTORY to find the repo-root config — the exact case loadConfig(cwd)'s single-directory lookup misses", () => {
    applyLayout({
      '/repo/.reviewbridge.json': JSON.stringify({ model: 'root-model' }),
    });

    const result = discoverProjectConfig('/repo/src/deep/subdir');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.config.model).toBe('root-model');
      expect(result.data?.source).toEqual({ kind: 'project', path: '/repo/.reviewbridge.json' });
    }
  });

  it("stops at a .git boundary, same as loadConfig()'s own implicit walk-up", () => {
    applyLayout({
      '/repo/.git': '', // .git boundary at /repo
      '/.reviewbridge.json': JSON.stringify({ model: 'above-boundary' }), // above it — must not be found
    });

    const result = discoverProjectConfig('/repo/sub');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeNull();
    }
  });

  it('returns ok(null) — not schema defaults, not an error — when nothing is found anywhere up the tree', () => {
    applyLayout({});

    const result = discoverProjectConfig('/nowhere/at/all');
    expect(result).toEqual({ ok: true, data: null });
  });

  it('aborts on a malformed config found while walking up', () => {
    applyLayout({
      '/repo/sub/.reviewbridge.json': '{ broken',
    });

    const result = discoverProjectConfig('/repo/sub');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('invalid JSON');
    }
  });
});
