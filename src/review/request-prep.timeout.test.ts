import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A preparation step that never settles cannot be produced reliably with real
// files — it needs a dead network mount. Mocking the workspace module is the
// only honest way to hold the permit open, so this lives in its own file where
// the mock cannot leak into the tests that use real directories.
vi.mock('../utils/workspace.js', () => ({
  resolveWorkspace: vi.fn(),
  validateWorkspacePath: vi.fn((raw: string) => ({ ok: true as const, data: raw })),
  instructionsRootFor: vi.fn((w: { workingDirectory: string }) => w.workingDirectory),
  canonicalizeStartupDirectory: vi.fn((d: string) => d),
}));

import { resolveWorkspace } from '../utils/workspace.js';
import { preparePlanReview, prepareDiffReview } from './request-prep.js';
import type { RequestPreparationDeps } from './request-prep.js';
import { createPreparationLimiter } from './preparation.js';

const mockResolveWorkspace = vi.mocked(resolveWorkspace);

function deps(): RequestPreparationDeps {
  return {
    limiter: createPreparationLimiter(),
    defaultWorkingDirectory: '/work/default',
    loadInstructions: false,
  };
}

// There are only four permits. A filesystem call that hangs — an unresponsive
// FUSE mount, a dead NFS export — would otherwise hold one for the life of the
// process, and four such requests would wedge the server permanently.
describe('bounded preparation time', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up on a preparation that never settles', async () => {
    mockResolveWorkspace.mockReturnValue(new Promise(() => {}));
    const shared = deps();

    const pending = preparePlanReview(shared, { cwd: '/work/hung' });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^GIT_ERROR:/);
      expect(result.error).toContain('timed out');
    }
  });

  it('returns the permit so the server keeps serving after a hang', async () => {
    mockResolveWorkspace.mockReturnValue(new Promise(() => {}));
    const shared = deps();

    const pending = prepareDiffReview(shared, {
      cwd: '/work/hung',
      source: { kind: 'capture', target: 'staged' },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;

    expect(shared.limiter.activeCount()).toBe(0);
  });

  it('does not time out a preparation that finishes in time', async () => {
    mockResolveWorkspace.mockResolvedValue({
      ok: true,
      data: { workingDirectory: '/work/repo', repositoryRoot: '/work/repo' },
    });
    const shared = deps();

    const result = await preparePlanReview(shared, { cwd: '/work/repo' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.workingDirectory).toBe('/work/repo');
  });
});
