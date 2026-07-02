import { describe, it, expect, vi } from 'vitest';
import { discoverCodexBinary } from './codex-binary.js';
import type { DiscoveryDeps } from './codex-binary.js';

// All seams injected — these tests never touch the filesystem or spawn anything.
function deps(overrides: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
  return {
    env: { PATH: '/usr/bin:/each/bin' },
    home: '/home/u',
    canExecute: vi.fn(() => true),
    probe: vi.fn(async () => true),
    ...overrides,
  };
}

describe('discoverCodexBinary (ISS-021)', () => {
  it('returns the first PATH candidate that is executable and runs', async () => {
    const d = deps();
    const found = await discoverCodexBinary(d);
    expect(found).toBe('/usr/bin/codex');
    // Stops at the first hit — no further probing.
    expect(d.probe).toHaveBeenCalledTimes(1);
  });

  it('respects PATH order before well-known install dirs', async () => {
    const canExecute = vi.fn((p: string) => p === '/each/bin/codex' || p === '/opt/homebrew/bin/codex');
    const found = await discoverCodexBinary(deps({ canExecute }));
    expect(found).toBe('/each/bin/codex'); // PATH hit wins over homebrew
  });

  it('skips non-executable candidates without probing them', async () => {
    const canExecute = vi.fn((p: string) => p === '/each/bin/codex');
    const probe = vi.fn(async () => true);
    const found = await discoverCodexBinary(deps({ canExecute, probe }));
    expect(found).toBe('/each/bin/codex');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('/each/bin/codex');
  });

  it('skips candidates that exist but fail to run (quarantined-but-present)', async () => {
    // An XProtect-hit file can still be on disk yet killed on spawn — existence
    // alone must not win; the --version probe decides.
    const probe = vi.fn(async (p: string) => p !== '/usr/bin/codex');
    const found = await discoverCodexBinary(deps({ probe }));
    expect(found).toBe('/each/bin/codex');
  });

  it('falls back to well-known install dirs when PATH has no codex', async () => {
    const canExecute = vi.fn((p: string) => p === '/home/u/.local/bin/codex');
    const found = await discoverCodexBinary(deps({ canExecute }));
    expect(found).toBe('/home/u/.local/bin/codex');
  });

  it('covers homebrew and /usr/local when nothing else matches', async () => {
    const canExecute = vi.fn((p: string) => p === '/usr/local/bin/codex');
    const found = await discoverCodexBinary(deps({ canExecute }));
    expect(found).toBe('/usr/local/bin/codex');
  });

  it('returns null when no candidate works', async () => {
    const found = await discoverCodexBinary(deps({ canExecute: vi.fn(() => false) }));
    expect(found).toBeNull();
  });

  it('returns null when candidates exist but none pass the run probe', async () => {
    const found = await discoverCodexBinary(deps({ probe: vi.fn(async () => false) }));
    expect(found).toBeNull();
  });

  it('handles a missing PATH by probing only the known install dirs', async () => {
    const canExecute = vi.fn(() => false);
    const found = await discoverCodexBinary(deps({ env: {}, canExecute }));
    expect(found).toBeNull();
    // Exactly the three known dirs — nothing from a PATH that isn't there.
    expect(canExecute).toHaveBeenCalledTimes(3);
    expect(canExecute).toHaveBeenCalledWith('/home/u/.local/bin/codex');
    expect(canExecute).toHaveBeenCalledWith('/opt/homebrew/bin/codex');
    expect(canExecute).toHaveBeenCalledWith('/usr/local/bin/codex');
  });

  it('dedupes a dir that appears in both PATH and the known install list', async () => {
    const canExecute = vi.fn<(path: string) => boolean>(() => false);
    await discoverCodexBinary(deps({ env: { PATH: '/usr/local/bin:/usr/local/bin' }, canExecute }));
    const usrLocalChecks = canExecute.mock.calls.filter(([p]) => p === '/usr/local/bin/codex');
    expect(usrLocalChecks).toHaveLength(1);
  });

  it('ignores empty PATH segments', async () => {
    const canExecute = vi.fn<(path: string) => boolean>(() => false);
    await discoverCodexBinary(deps({ env: { PATH: ':/usr/bin::' }, canExecute }));
    const checked = canExecute.mock.calls.map(([p]) => p);
    expect(checked).toEqual([
      '/usr/bin/codex',
      '/home/u/.local/bin/codex',
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    ]);
  });
});
