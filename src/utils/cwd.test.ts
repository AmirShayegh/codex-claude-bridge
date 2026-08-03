import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveCwd, classifyStatError } from './cwd.js';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-bridge-cwd-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveCwd', () => {
  it('passes undefined through unchanged (default: use the process cwd)', () => {
    const result = resolveCwd(undefined);
    expect(result).toEqual({ ok: true, data: undefined });
  });

  it('resolves an existing directory to an absolute path', () => {
    const dir = makeTempDir();
    const result = resolveCwd(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(resolve(dir));
    }
  });

  it('resolves a relative path to an absolute one', () => {
    const dir = makeTempDir();
    const relative = `${dir}/.`;
    const result = resolveCwd(relative);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(resolve(dir));
    }
  });

  it('returns INVALID_INPUT for a path that does not exist (F3: single statSync, ENOENT via catch — never throws)', () => {
    const missing = join(makeTempDir(), 'does-not-exist');
    expect(() => resolveCwd(missing)).not.toThrow();
    const result = resolveCwd(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('INVALID_INPUT');
      expect(result.error).toContain(missing);
      expect(result.error).toContain('does not exist');
    }
  });

  it('returns INVALID_INPUT for a path that is a file, not a directory', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'a-file.txt');
    writeFileSync(filePath, 'not a directory');
    const result = resolveCwd(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('INVALID_INPUT');
      expect(result.error).toContain('not a directory');
    }
  });

  it('treats an empty string the same as undefined, instead of silently resolving to the process cwd', () => {
    // path.resolve('') would otherwise resolve to process.cwd() — surprising
    // for what's almost certainly an unset variable on the caller's side.
    const result = resolveCwd('');
    expect(result).toEqual({ ok: true, data: undefined });
  });

  it('treats a whitespace-only string the same as undefined', () => {
    const result = resolveCwd('   ');
    expect(result).toEqual({ ok: true, data: undefined });
  });
});

// F3: the errno → message mapping resolveCwd's catch delegates to. Unit-tested
// directly with synthetic errno codes rather than via resolveCwd end-to-end —
// reliably reproducing a real EACCES (permission-denied) race on disk is
// fiddly and platform/root-dependent, and would make the test itself flaky
// for the exact reason F3 exists (permission state is hard to pin down).
describe('classifyStatError', () => {
  function errnoError(code: string, message = 'synthetic'): NodeJS.ErrnoException {
    return Object.assign(new Error(message), { code });
  }

  it('maps ENOENT to a "does not exist" message', () => {
    const msg = classifyStatError(errnoError('ENOENT'), '/some/path', '/abs/some/path');
    expect(msg).toContain('INVALID_INPUT');
    expect(msg).toContain('does not exist');
    expect(msg).toContain('/some/path');
    expect(msg).toContain('/abs/some/path');
  });

  it('maps ENOTDIR (a path component is not a directory) to the same "does not exist" message', () => {
    const msg = classifyStatError(
      errnoError('ENOTDIR'),
      '/some/file.txt/sub',
      '/abs/some/file.txt/sub',
    );
    expect(msg).toContain('INVALID_INPUT');
    expect(msg).toContain('does not exist');
  });

  it('maps EACCES to a distinct "not accessible / permission denied" message', () => {
    const msg = classifyStatError(errnoError('EACCES'), '/locked', '/abs/locked');
    expect(msg).toContain('INVALID_INPUT');
    expect(msg).toContain('not accessible');
    expect(msg).toContain('permission denied');
    expect(msg).not.toContain('does not exist');
  });

  it('maps an unrecognized errno to a generic-but-still-actionable message including the original text', () => {
    const msg = classifyStatError(errnoError('EMFILE', 'too many open files'), '/x', '/abs/x');
    expect(msg).toContain('INVALID_INPUT');
    expect(msg).toContain('could not be checked');
    expect(msg).toContain('too many open files');
  });

  it('never throws, even for a non-Error, code-less thrown value', () => {
    expect(() => classifyStatError('a plain string throw', '/x', '/abs/x')).not.toThrow();
    const msg = classifyStatError('a plain string throw', '/x', '/abs/x');
    expect(msg).toContain('INVALID_INPUT');
    expect(msg).toContain('a plain string throw');
  });
});
