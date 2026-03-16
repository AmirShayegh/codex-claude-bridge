import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePrecommitDiff, resolveCodeDiff, NO_STAGED_CHANGES, NO_WORKING_CHANGES } from './resolve-diff.js';

vi.mock('./git.js', () => ({
  getStagedDiff: vi.fn(),
  getWorkingDiff: vi.fn(),
}));

import { getStagedDiff, getWorkingDiff } from './git.js';

const mockGetStagedDiff = vi.mocked(getStagedDiff);
const mockGetWorkingDiff = vi.mocked(getWorkingDiff);

beforeEach(() => {
  vi.clearAllMocks();
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
      expect(result).toEqual({ ok: true, data: sampleDiff });
      expect(mockGetStagedDiff).toHaveBeenCalledOnce();
    });

    it('auto-captures staged diff when no explicit diff and auto_diff is undefined', async () => {
      mockGetStagedDiff.mockResolvedValue({ ok: true, data: sampleDiff });
      const result = await resolvePrecommitDiff({});
      expect(result).toEqual({ ok: true, data: sampleDiff });
      expect(mockGetStagedDiff).toHaveBeenCalledOnce();
    });

    it('returns NO_STAGED_CHANGES error when staged diff is empty string', async () => {
      mockGetStagedDiff.mockResolvedValue({ ok: true, data: '' });
      const result = await resolvePrecommitDiff({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(new RegExp(`^${NO_STAGED_CHANGES}:`));
        expect(result.error).toContain('Stage files with git add first');
      }
    });

    it('propagates git errors from getStagedDiff', async () => {
      mockGetStagedDiff.mockResolvedValue({ ok: false, error: 'GIT_ERROR: fatal: not a git repository' });
      const result = await resolvePrecommitDiff({});
      expect(result).toEqual({ ok: false, error: 'GIT_ERROR: fatal: not a git repository' });
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
      expect(result).toEqual({ ok: true, data: sampleDiff });
      expect(mockGetWorkingDiff).toHaveBeenCalledOnce();
    });

    it('treats whitespace-only string as no diff (triggers auto-capture)', async () => {
      mockGetWorkingDiff.mockResolvedValue({ ok: true, data: sampleDiff });
      const result = await resolveCodeDiff({ diff: '   ' });
      expect(result).toEqual({ ok: true, data: sampleDiff });
      expect(mockGetWorkingDiff).toHaveBeenCalledOnce();
    });
  });

  describe('auto_diff capture', () => {
    it('auto-captures working diff when no explicit diff and auto_diff is true', async () => {
      mockGetWorkingDiff.mockResolvedValue({ ok: true, data: sampleDiff });
      const result = await resolveCodeDiff({ auto_diff: true });
      expect(result).toEqual({ ok: true, data: sampleDiff });
      expect(mockGetWorkingDiff).toHaveBeenCalledOnce();
    });

    it('auto-captures working diff when no explicit diff and auto_diff is undefined', async () => {
      mockGetWorkingDiff.mockResolvedValue({ ok: true, data: sampleDiff });
      const result = await resolveCodeDiff({});
      expect(result).toEqual({ ok: true, data: sampleDiff });
      expect(mockGetWorkingDiff).toHaveBeenCalledOnce();
    });

    it('returns NO_WORKING_CHANGES error when working diff is empty', async () => {
      mockGetWorkingDiff.mockResolvedValue({ ok: true, data: '' });
      const result = await resolveCodeDiff({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(new RegExp(`^${NO_WORKING_CHANGES}:`));
        expect(result.error).toContain('No changes found vs HEAD');
      }
    });

    it('propagates git errors from getWorkingDiff', async () => {
      mockGetWorkingDiff.mockResolvedValue({ ok: false, error: 'GIT_ERROR: fatal: not a git repository' });
      const result = await resolveCodeDiff({});
      expect(result).toEqual({ ok: false, error: 'GIT_ERROR: fatal: not a git repository' });
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
