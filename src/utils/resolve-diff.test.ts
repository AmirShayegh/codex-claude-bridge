import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  normalizeCodeDiffSource,
  normalizePrecommitDiffSource,
  captureDiff,
  stampCapture,
  withCapturedFrom,
  NO_STAGED_CHANGES,
  NO_WORKING_CHANGES,
} from './resolve-diff.js';
import { ok, err } from './errors.js';
import type { ResolvedWorkspace } from './workspace.js';

vi.mock('./git.js', () => ({
  getStagedDiff: vi.fn(),
  getWorkingDiff: vi.fn(),
}));

import { getStagedDiff, getWorkingDiff } from './git.js';

const mockGetStagedDiff = vi.mocked(getStagedDiff);
const mockGetWorkingDiff = vi.mocked(getWorkingDiff);

// A caller standing in a SUBDIRECTORY of the repository: capture must be
// anchored at the root, and the root is what gets reported back.
const WORKSPACE: ResolvedWorkspace = {
  workingDirectory: '/work/repo-b/src/nested',
  repositoryRoot: '/work/repo-b',
};

const NOT_A_REPO: ResolvedWorkspace = {
  workingDirectory: '/tmp/plain',
  repositoryRoot: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

const sampleDiff = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,5 @@
+import { foo } from "./foo";
 export default app;`;

describe('normalizeCodeDiffSource', () => {
  it('treats a defined non-blank diff as explicit', () => {
    expect(normalizeCodeDiffSource({ diff: sampleDiff })).toEqual({
      ok: true,
      data: { kind: 'explicit', diff: sampleDiff },
    });
  });

  it('keeps explicit precedence even when auto_diff is true', () => {
    expect(normalizeCodeDiffSource({ diff: sampleDiff, auto_diff: true })).toEqual({
      ok: true,
      data: { kind: 'explicit', diff: sampleDiff },
    });
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a newline', '\n'],
  ])('falls through to capture for %s', (_label, diff) => {
    expect(normalizeCodeDiffSource({ diff })).toEqual({
      ok: true,
      data: { kind: 'capture', target: 'working' },
    });
  });

  it('captures the working tree when no diff is given', () => {
    expect(normalizeCodeDiffSource({})).toEqual({
      ok: true,
      data: { kind: 'capture', target: 'working' },
    });
  });

  it('errors when auto-capture is disabled and no usable diff is given', () => {
    for (const args of [{ auto_diff: false }, { diff: '', auto_diff: false }]) {
      const result = normalizeCodeDiffSource(args);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('auto_diff disabled and no diff provided');
    }
  });
});

describe('normalizePrecommitDiffSource', () => {
  it('treats ANY defined diff as explicit, including an empty one', () => {
    // The two commands genuinely differ here: for precommit an empty diff means
    // "nothing to check", not "go and find something".
    expect(normalizePrecommitDiffSource({ diff: '' })).toEqual({
      ok: true,
      data: { kind: 'explicit', diff: '' },
    });
    expect(normalizePrecommitDiffSource({ diff: sampleDiff, auto_diff: true })).toEqual({
      ok: true,
      data: { kind: 'explicit', diff: sampleDiff },
    });
  });

  it('captures the index when no diff is given', () => {
    expect(normalizePrecommitDiffSource({})).toEqual({
      ok: true,
      data: { kind: 'capture', target: 'staged' },
    });
    expect(normalizePrecommitDiffSource({ auto_diff: true })).toEqual({
      ok: true,
      data: { kind: 'capture', target: 'staged' },
    });
  });

  it('errors when auto-capture is disabled and no diff is given', () => {
    const result = normalizePrecommitDiffSource({ auto_diff: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('auto_diff disabled and no diff provided');
  });
});

describe('captureDiff', () => {
  describe('explicit sources never touch git', () => {
    it('returns the diff verbatim and reports no capture location', async () => {
      const result = await captureDiff({ kind: 'explicit', diff: sampleDiff }, WORKSPACE);
      expect(result).toEqual({ ok: true, data: sampleDiff });
      expect(result.capturedFrom).toBeUndefined();
      expect(mockGetStagedDiff).not.toHaveBeenCalled();
      expect(mockGetWorkingDiff).not.toHaveBeenCalled();
    });

    it('passes an explicit EMPTY diff through, even outside a repository', async () => {
      const result = await captureDiff({ kind: 'explicit', diff: '' }, NOT_A_REPO);
      expect(result).toEqual({ ok: true, data: '' });
    });
  });

  describe('capture is anchored at the repository root', () => {
    it('captures staged changes from the ROOT when the caller is in a subdirectory', async () => {
      mockGetStagedDiff.mockResolvedValue(ok(sampleDiff));
      const result = await captureDiff({ kind: 'capture', target: 'staged' }, WORKSPACE);
      expect(mockGetStagedDiff).toHaveBeenCalledWith('/work/repo-b');
      expect(result).toEqual({ ok: true, data: sampleDiff, capturedFrom: '/work/repo-b' });
    });

    it('captures working changes from the ROOT when the caller is in a subdirectory', async () => {
      mockGetWorkingDiff.mockResolvedValue(ok(sampleDiff));
      const result = await captureDiff({ kind: 'capture', target: 'working' }, WORKSPACE);
      expect(mockGetWorkingDiff).toHaveBeenCalledWith('/work/repo-b');
      expect(result.capturedFrom).toBe('/work/repo-b');
    });

    it('reports exactly the directory it handed to git', async () => {
      mockGetStagedDiff.mockResolvedValue(ok(sampleDiff));
      const result = await captureDiff({ kind: 'capture', target: 'staged' }, WORKSPACE);
      expect(result.capturedFrom).toBe(mockGetStagedDiff.mock.calls[0][0]);
    });
  });

  describe('auto-capture outside a work tree', () => {
    it.each([['staged'], ['working']] as const)(
      'rejects a %s capture with INVALID_INPUT and never calls git',
      async (target) => {
        const result = await captureDiff({ kind: 'capture', target }, NOT_A_REPO);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toMatch(/^INVALID_INPUT:/);
          expect(result.error).toContain('not inside a git work tree');
          expect(result.error).toContain('/tmp/plain');
        }
        expect(mockGetStagedDiff).not.toHaveBeenCalled();
        expect(mockGetWorkingDiff).not.toHaveBeenCalled();
      },
    );

  });

  describe('empty captures name where they looked', () => {
    it('reports NO_STAGED_CHANGES with the directory', async () => {
      mockGetStagedDiff.mockResolvedValue(ok(''));
      const result = await captureDiff({ kind: 'capture', target: 'staged' }, WORKSPACE);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(new RegExp(`^${NO_STAGED_CHANGES}:`));
        expect(result.error).toContain('No staged changes found in /work/repo-b');
        expect(result.error).toContain('Stage files with git add first');
      }
      expect(result.capturedFrom).toBe('/work/repo-b');
    });

    it('reports NO_WORKING_CHANGES with the directory', async () => {
      mockGetWorkingDiff.mockResolvedValue(ok(''));
      const result = await captureDiff({ kind: 'capture', target: 'working' }, WORKSPACE);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(new RegExp(`^${NO_WORKING_CHANGES}:`));
        expect(result.error).toContain('No changes found vs HEAD in /work/repo-b');
      }
      expect(result.capturedFrom).toBe('/work/repo-b');
    });
  });

  describe('git failures', () => {
    it('keeps the GIT_ERROR prefix and appends where the capture was attempted', async () => {
      mockGetStagedDiff.mockResolvedValue(err('GIT_ERROR: fatal: index is corrupt'));
      const result = await captureDiff({ kind: 'capture', target: 'staged' }, WORKSPACE);
      expect(result).toEqual({
        ok: false,
        error: 'GIT_ERROR: fatal: index is corrupt (capture attempted from "/work/repo-b")',
        capturedFrom: '/work/repo-b',
      });
    });

    it('escapes controls in the appended location but keeps the field raw', async () => {
      const hostile = '/work/repo';
      mockGetWorkingDiff.mockResolvedValue(err('GIT_ERROR: boom'));
      const result = await captureDiff(
        { kind: 'capture', target: 'working' },
        { workingDirectory: hostile, repositoryRoot: hostile },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('\\x1B');
        expect(result.error).not.toContain('');
      }
      expect(result.capturedFrom).toBe(hostile);
    });
  });
});

describe('withCapturedFrom', () => {
  it('stamps the resolver value onto a result', () => {
    expect(withCapturedFrom({ verdict: 'approve' }, '/repo')).toEqual({
      verdict: 'approve',
      captured_from: '/repo',
    });
  });

  it('drops a backend-supplied captured_from when the resolver has none', () => {
    expect(withCapturedFrom({ verdict: 'approve', captured_from: '/forged' }, undefined)).toEqual({
      verdict: 'approve',
    });
  });

  it('overwrites a backend-supplied captured_from with the resolver value', () => {
    expect(withCapturedFrom({ verdict: 'approve', captured_from: '/forged' }, '/real')).toEqual({
      verdict: 'approve',
      captured_from: '/real',
    });
  });

  it('leaves an undecorated result untouched when there is nothing to stamp', () => {
    expect(withCapturedFrom({ verdict: 'approve' }, undefined)).toEqual({ verdict: 'approve' });
  });
});

describe('stampCapture', () => {
  it('decorates a successful result', () => {
    expect(stampCapture(ok({ session_id: 's' }), '/repo')).toEqual({
      ok: true,
      data: { session_id: 's', captured_from: '/repo' },
    });
  });

  it('passes a failure through untouched', () => {
    const failure = err<{ session_id: string }>('GIT_ERROR: nope');
    expect(stampCapture(failure, '/repo')).toBe(failure);
  });
});
