import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolvePrecommitDiff,
  resolveCodeDiff,
  stampCapture,
  withCapturedFrom,
  NO_STAGED_CHANGES,
  NO_WORKING_CHANGES,
} from './resolve-diff.js';
import { ErrorCode, ok, err } from './errors.js';

vi.mock('./git.js', () => ({
  getStagedDiff: vi.fn(),
  getWorkingDiff: vi.fn(),
}));

import { getStagedDiff, getWorkingDiff } from './git.js';

const mockGetStagedDiff = vi.mocked(getStagedDiff);
const mockGetWorkingDiff = vi.mocked(getWorkingDiff);

// The directory the resolver is expected to hand git, and to report back as the
// capture location (ISS-028). Fixed so assertions never depend on the real cwd.
const CWD = '/tmp/capture-dir';
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(CWD);
});

afterEach(() => {
  cwdSpy.mockRestore();
});

const sampleDiff = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,5 @@
+import { foo } from "./foo";
 export default app;`;

describe('resolvePrecommitDiff', () => {
  describe('explicit diff precedence', () => {
    it('returns explicit diff when provided', async () => {
      const result = await resolvePrecommitDiff({ diff: sampleDiff });
      expect(result).toEqual({ ok: true, data: sampleDiff });
      expect(mockGetStagedDiff).not.toHaveBeenCalled();
    });

    it('uses explicit diff even when auto_diff is true', async () => {
      const result = await resolvePrecommitDiff({ diff: sampleDiff, auto_diff: true });
      expect(result).toEqual({ ok: true, data: sampleDiff });
      expect(mockGetStagedDiff).not.toHaveBeenCalled();
    });

    it('uses explicit diff even when auto_diff is false', async () => {
      const result = await resolvePrecommitDiff({ diff: sampleDiff, auto_diff: false });
      expect(result).toEqual({ ok: true, data: sampleDiff });
      expect(mockGetStagedDiff).not.toHaveBeenCalled();
    });
  });

  describe('auto_diff capture', () => {
    it('auto-captures staged diff when no explicit diff and auto_diff is true', async () => {
      mockGetStagedDiff.mockResolvedValue({ ok: true, data: sampleDiff });
      const result = await resolvePrecommitDiff({ auto_diff: true });
      expect(result).toEqual({ ok: true, data: sampleDiff, capturedFrom: CWD });
      expect(mockGetStagedDiff).toHaveBeenCalledOnce();
    });

    it('auto-captures staged diff when no explicit diff and auto_diff is undefined', async () => {
      mockGetStagedDiff.mockResolvedValue({ ok: true, data: sampleDiff });
      const result = await resolvePrecommitDiff({});
      expect(result).toEqual({ ok: true, data: sampleDiff, capturedFrom: CWD });
      expect(mockGetStagedDiff).toHaveBeenCalledOnce();
    });

    it('returns NO_STAGED_CHANGES error when staged diff is empty string', async () => {
      mockGetStagedDiff.mockResolvedValue({ ok: true, data: '' });
      const result = await resolvePrecommitDiff({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(new RegExp(`^${NO_STAGED_CHANGES}:`));
        expect(result.error).toContain(`No staged changes found in ${CWD}`);
        expect(result.error).toContain('Stage files with git add first');
      }
      // An empty capture still names where it looked (ISS-028).
      expect(result.capturedFrom).toBe(CWD);
    });

    it('propagates git errors from getStagedDiff', async () => {
      mockGetStagedDiff.mockResolvedValue({ ok: false, error: 'GIT_ERROR: fatal: not a git repository' });
      const result = await resolvePrecommitDiff({});
      expect(result).toEqual({
        ok: false,
        error: `GIT_ERROR: fatal: not a git repository (capture attempted from "${CWD}")`,
        capturedFrom: CWD,
      });
    });
  });

  describe('auto_diff disabled', () => {
    it('returns error when auto_diff is false and no diff provided', async () => {
      const result = await resolvePrecommitDiff({ auto_diff: false });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('auto_diff disabled and no diff provided');
      }
      expect(mockGetStagedDiff).not.toHaveBeenCalled();
    });
  });
});

describe('resolveCodeDiff', () => {
  describe('explicit diff precedence', () => {
    it('returns explicit non-empty diff when provided', async () => {
      const result = await resolveCodeDiff({ diff: sampleDiff });
      expect(result).toEqual({ ok: true, data: sampleDiff });
      expect(mockGetWorkingDiff).not.toHaveBeenCalled();
    });

    it('uses explicit diff even when auto_diff is true', async () => {
      const result = await resolveCodeDiff({ diff: sampleDiff, auto_diff: true });
      expect(result).toEqual({ ok: true, data: sampleDiff });
      expect(mockGetWorkingDiff).not.toHaveBeenCalled();
    });

    it('treats empty string as no diff (triggers auto-capture)', async () => {
      mockGetWorkingDiff.mockResolvedValue({ ok: true, data: sampleDiff });
      const result = await resolveCodeDiff({ diff: '' });
      expect(result).toEqual({ ok: true, data: sampleDiff, capturedFrom: CWD });
      expect(mockGetWorkingDiff).toHaveBeenCalledOnce();
    });

    it('treats whitespace-only string as no diff (triggers auto-capture)', async () => {
      mockGetWorkingDiff.mockResolvedValue({ ok: true, data: sampleDiff });
      const result = await resolveCodeDiff({ diff: '   ' });
      expect(result).toEqual({ ok: true, data: sampleDiff, capturedFrom: CWD });
      expect(mockGetWorkingDiff).toHaveBeenCalledOnce();
    });
  });

  describe('auto_diff capture', () => {
    it('auto-captures working diff when no explicit diff and auto_diff is true', async () => {
      mockGetWorkingDiff.mockResolvedValue({ ok: true, data: sampleDiff });
      const result = await resolveCodeDiff({ auto_diff: true });
      expect(result).toEqual({ ok: true, data: sampleDiff, capturedFrom: CWD });
      expect(mockGetWorkingDiff).toHaveBeenCalledOnce();
    });

    it('auto-captures working diff when no explicit diff and auto_diff is undefined', async () => {
      mockGetWorkingDiff.mockResolvedValue({ ok: true, data: sampleDiff });
      const result = await resolveCodeDiff({});
      expect(result).toEqual({ ok: true, data: sampleDiff, capturedFrom: CWD });
      expect(mockGetWorkingDiff).toHaveBeenCalledOnce();
    });

    it('returns NO_WORKING_CHANGES error when working diff is empty', async () => {
      mockGetWorkingDiff.mockResolvedValue({ ok: true, data: '' });
      const result = await resolveCodeDiff({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(new RegExp(`^${NO_WORKING_CHANGES}:`));
        expect(result.error).toContain(`No changes found vs HEAD in ${CWD}`);
      }
      expect(result.capturedFrom).toBe(CWD);
    });

    it('propagates git errors from getWorkingDiff', async () => {
      mockGetWorkingDiff.mockResolvedValue({ ok: false, error: 'GIT_ERROR: fatal: not a git repository' });
      const result = await resolveCodeDiff({});
      expect(result).toEqual({
        ok: false,
        error: `GIT_ERROR: fatal: not a git repository (capture attempted from "${CWD}")`,
        capturedFrom: CWD,
      });
    });
  });

  describe('auto_diff disabled', () => {
    it('returns error when auto_diff is false and no diff provided', async () => {
      const result = await resolveCodeDiff({ auto_diff: false });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('auto_diff disabled and no diff provided');
      }
      expect(mockGetWorkingDiff).not.toHaveBeenCalled();
    });

    it('returns error when auto_diff is false and empty diff provided', async () => {
      const result = await resolveCodeDiff({ diff: '', auto_diff: false });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('auto_diff disabled and no diff provided');
      }
      expect(mockGetWorkingDiff).not.toHaveBeenCalled();
    });
  });
});

// ISS-028: an auto-captured result names the absolute directory git actually ran
// in, so an empty capture is self-diagnosing instead of silent. The invariant is
// that `capturedFrom` is the SAME value handed to git — never re-read afterwards.
describe('capture location reporting (ISS-028)', () => {
  describe('the directory handed to git is the one reported', () => {
    it('passes the cwd snapshot to getStagedDiff and reports it', async () => {
      mockGetStagedDiff.mockResolvedValue({ ok: true, data: sampleDiff });
      const result = await resolvePrecommitDiff({});
      expect(mockGetStagedDiff).toHaveBeenCalledWith(CWD);
      expect(result.capturedFrom).toBe(CWD);
    });

    it('passes the cwd snapshot to getWorkingDiff and reports it', async () => {
      mockGetWorkingDiff.mockResolvedValue({ ok: true, data: sampleDiff });
      const result = await resolveCodeDiff({});
      expect(mockGetWorkingDiff).toHaveBeenCalledWith(CWD);
      expect(result.capturedFrom).toBe(CWD);
    });

    it('reads process.cwd() exactly once per precommit capture', async () => {
      mockGetStagedDiff.mockResolvedValue({ ok: true, data: sampleDiff });
      await resolvePrecommitDiff({});
      expect(cwdSpy).toHaveBeenCalledTimes(1);
    });

    it('reads process.cwd() exactly once per code capture', async () => {
      mockGetWorkingDiff.mockResolvedValue({ ok: true, data: sampleDiff });
      await resolveCodeDiff({});
      expect(cwdSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('explicit diffs never report a capture location', () => {
    it('omits capturedFrom for an explicit precommit diff', async () => {
      const result = await resolvePrecommitDiff({ diff: sampleDiff });
      expect(result.capturedFrom).toBeUndefined();
      expect(cwdSpy).not.toHaveBeenCalled();
    });

    it('omits capturedFrom for an explicit EMPTY precommit diff', async () => {
      const result = await resolvePrecommitDiff({ diff: '' });
      expect(result).toEqual({ ok: true, data: '' });
      expect(result.capturedFrom).toBeUndefined();
      expect(cwdSpy).not.toHaveBeenCalled();
    });

    it('omits capturedFrom for an explicit code diff', async () => {
      const result = await resolveCodeDiff({ diff: sampleDiff });
      expect(result.capturedFrom).toBeUndefined();
      expect(cwdSpy).not.toHaveBeenCalled();
    });

    it('omits capturedFrom when precommit auto-capture is disabled', async () => {
      const result = await resolvePrecommitDiff({ auto_diff: false });
      expect(result.capturedFrom).toBeUndefined();
      expect(cwdSpy).not.toHaveBeenCalled();
    });

    it('omits capturedFrom when code auto-capture is disabled', async () => {
      const result = await resolveCodeDiff({ auto_diff: false });
      expect(result.capturedFrom).toBeUndefined();
      expect(cwdSpy).not.toHaveBeenCalled();
    });
  });

  describe('cwd lookup failure', () => {
    it('fails precommit with GIT_ERROR without invoking git', async () => {
      cwdSpy.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT: no such file or directory, uv_cwd'), {
          code: 'ENOENT',
        });
      });
      const result = await resolvePrecommitDiff({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(new RegExp(`^${ErrorCode.GIT_ERROR}:`));
        expect(result.error).toContain('current working directory');
      }
      // No location may be fabricated when we never learned one.
      expect(result.capturedFrom).toBeUndefined();
      expect(mockGetStagedDiff).not.toHaveBeenCalled();
    });

    it('fails code review with GIT_ERROR without invoking git', async () => {
      cwdSpy.mockImplementation(() => {
        throw new Error('uv_cwd failed');
      });
      const result = await resolveCodeDiff({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(new RegExp(`^${ErrorCode.GIT_ERROR}:`));
      }
      expect(result.capturedFrom).toBeUndefined();
      expect(mockGetWorkingDiff).not.toHaveBeenCalled();
    });
  });

  describe('terminal-control safety', () => {
    it('escapes controls in the message but keeps capturedFrom raw', async () => {
      const hostile = '/tmp/we\u001b[31mird';
      cwdSpy.mockReturnValue(hostile);
      mockGetStagedDiff.mockResolvedValue({ ok: true, data: '' });
      const result = await resolvePrecommitDiff({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain('\u001b');
        expect(result.error).toContain('\\x1B[31mird');
      }
      // The field is data, not display: it keeps the real path.
      expect(result.capturedFrom).toBe(hostile);
    });

    it('escapes controls in an appended git-error location', async () => {
      const hostile = '/tmp/we\u001b[31mird';
      cwdSpy.mockReturnValue(hostile);
      mockGetWorkingDiff.mockResolvedValue({ ok: false, error: 'GIT_ERROR: boom' });
      const result = await resolveCodeDiff({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/^GIT_ERROR:/);
        expect(result.error).toContain('capture attempted from');
        expect(result.error).not.toContain('\u001b');
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
