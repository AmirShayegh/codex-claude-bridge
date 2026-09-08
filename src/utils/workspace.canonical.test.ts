import { describe, it, expect, vi, beforeEach } from 'vitest';

// This file exercises the paths that only appear when the FILESYSTEM misbehaves,
// so node:fs/promises is faked wholesale here. The real-filesystem behavior is
// covered in workspace.test.ts.
vi.mock('node:fs/promises', () => ({
  realpath: vi.fn(),
  stat: vi.fn(),
  opendir: vi.fn(),
}));
vi.mock('./git.js', () => ({ getRepositoryRoot: vi.fn() }));

import { realpath, stat, opendir } from 'node:fs/promises';
import { getRepositoryRoot } from './git.js';
import { resolveWorkspace } from './workspace.js';
import { ok } from './errors.js';

const mockRealpath = vi.mocked(realpath);
const mockStat = vi.mocked(stat);
const mockOpendir = vi.mocked(opendir);
const mockGetRepositoryRoot = vi.mocked(getRepositoryRoot);

// Synthetic errno objects, not real permission changes: a chmod-based test is a
// no-op when the suite runs as root, which is exactly where it would silently
// stop protecting anything.
function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function directory(isDirectory: boolean) {
  return { isDirectory: () => isDirectory } as unknown as Awaited<ReturnType<typeof stat>>;
}

function openHandle() {
  return { close: vi.fn().mockResolvedValue(undefined) } as unknown as Awaited<
    ReturnType<typeof opendir>
  >;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRealpath.mockResolvedValue('/work/repo-b' as never);
  mockStat.mockResolvedValue(directory(true));
  mockOpendir.mockResolvedValue(openHandle());
  mockGetRepositoryRoot.mockResolvedValue(ok(null));
});

describe('canonicalization and access proof', () => {
  it('re-validates the CANONICAL result, not just the input', async () => {
    // realpath can land somewhere the syntactic rules would have rejected, and
    // the canonical value is what every subprocess actually receives.
    mockRealpath.mockResolvedValue('not-absolute' as never);
    const result = await resolveWorkspace('/work/repo-b');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^INVALID_INPUT:/);
    expect(mockGetRepositoryRoot).not.toHaveBeenCalled();
  });

  it('rejects a canonical result that has grown past the length bound', async () => {
    mockRealpath.mockResolvedValue(('/' + 'a'.repeat(4096)) as never);
    const result = await resolveWorkspace('/work/repo-b');
    expect(result.ok).toBe(false);
  });

  it('passes the CANONICAL path to git, never the raw input', async () => {
    mockRealpath.mockResolvedValue('/private/var/work' as never);
    await resolveWorkspace('/var/work');
    expect(mockGetRepositoryRoot).toHaveBeenCalledWith('/private/var/work');
  });

  it.each(['ENOENT', 'EACCES', 'ELOOP', 'ENOTDIR', 'ENAMETOOLONG'])(
    'rejects when realpath fails with %s',
    async (code) => {
      mockRealpath.mockRejectedValue(errno(code));
      const result = await resolveWorkspace('/work/repo-b');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('existing, readable directory');
    },
  );

  it('rejects when the canonical target is not a directory', async () => {
    mockStat.mockResolvedValue(directory(false));
    const result = await resolveWorkspace('/work/repo-b');
    expect(result.ok).toBe(false);
    expect(mockOpendir).not.toHaveBeenCalled();
  });

  it('rejects when stat itself fails', async () => {
    mockStat.mockRejectedValue(errno('EACCES'));
    expect((await resolveWorkspace('/work/repo-b')).ok).toBe(false);
  });

  it('rejects a directory that exists but cannot be opened', async () => {
    // stat only proves existence. Opening proves we may traverse and read it —
    // which is what every later git call actually depends on.
    mockOpendir.mockRejectedValue(errno('EACCES'));
    const result = await resolveWorkspace('/work/repo-b');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('existing, readable directory');
    expect(mockGetRepositoryRoot).not.toHaveBeenCalled();
  });

  it('closes the directory handle it opened as a probe', async () => {
    const handle = openHandle();
    mockOpendir.mockResolvedValue(handle);
    await resolveWorkspace('/work/repo-b');
    expect(handle.close).toHaveBeenCalled();
  });

  it('never throws — every failure comes back as a Result', async () => {
    mockRealpath.mockRejectedValue(new Error('unexpected'));
    await expect(resolveWorkspace('/work/repo-b')).resolves.toMatchObject({ ok: false });
  });
});
