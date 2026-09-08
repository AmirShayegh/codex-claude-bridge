import { describe, it, expect } from 'vitest';
import { isStrippedGitVariable, sanitizeSubprocessEnv, subprocessEnv } from './subprocess-env.js';

describe('isStrippedGitVariable', () => {
  it.each([
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_GRAFT_FILE',
    'GIT_IMPLICIT_WORK_TREE',
    'GIT_NO_REPLACE_OBJECTS',
    'GIT_PREFIX',
    'GIT_REPLACE_REF_BASE',
    'GIT_SHALLOW_FILE',
    'GIT_CONFIG',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_PARAMETERS',
  ])('strips the repository-selecting variable %s', (name) => {
    expect(isStrippedGitVariable(name)).toBe(true);
  });

  it.each(['GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_17', 'GIT_CONFIG_VALUE_999'])(
    'strips the indexed config variable %s',
    (name) => {
      expect(isStrippedGitVariable(name)).toBe(true);
    },
  );

  it('matches case-insensitively (Windows env names are not case-sensitive)', () => {
    expect(isStrippedGitVariable('git_dir')).toBe(true);
    expect(isStrippedGitVariable('Git_Work_Tree')).toBe(true);
    expect(isStrippedGitVariable('git_config_key_3')).toBe(true);
  });

  it.each([
    'PATH',
    'HOME',
    'TMPDIR',
    'OPENAI_API_KEY',
    'CODEX_PATH',
    'HTTPS_PROXY',
    // Git variables that do not redirect the repository or inject config —
    // stripping these would change behavior for no safety gain.
    'GIT_AUTHOR_NAME',
    'GIT_COMMITTER_EMAIL',
    'GIT_TERMINAL_PROMPT',
    'GIT_SSH_COMMAND',
    // Near-misses of the indexed pattern.
    'GIT_CONFIG_KEY',
    'GIT_CONFIG_KEY_',
    'GIT_CONFIG_KEY_X',
    'GIT_CONFIG_VALUE_1A',
    'MY_GIT_DIR',
    'GIT_DIRECTORY',
  ])('preserves %s', (name) => {
    expect(isStrippedGitVariable(name)).toBe(false);
  });
});

describe('sanitizeSubprocessEnv', () => {
  it('removes redirecting variables and keeps everything else verbatim', () => {
    const sanitized = sanitizeSubprocessEnv({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      OPENAI_API_KEY: 'secret',
      GIT_DIR: '/elsewhere/.git',
      GIT_WORK_TREE: '/elsewhere',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.pager',
      GIT_CONFIG_VALUE_0: 'evil',
      GIT_AUTHOR_NAME: 'Dev',
    });

    expect(sanitized).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      OPENAI_API_KEY: 'secret',
      GIT_AUTHOR_NAME: 'Dev',
    });
  });

  it('drops undefined values rather than stringifying them', () => {
    const sanitized = sanitizeSubprocessEnv({ PATH: '/usr/bin', EMPTY: undefined });
    expect(sanitized).not.toHaveProperty('EMPTY');
    expect(sanitized.PATH).toBe('/usr/bin');
  });

  it('keeps empty-string values (an empty variable is still set)', () => {
    expect(sanitizeSubprocessEnv({ QUIET: '' })).toEqual({ QUIET: '' });
  });

  it('never mutates the source environment', () => {
    const source = { PATH: '/usr/bin', GIT_DIR: '/elsewhere/.git' };
    sanitizeSubprocessEnv(source);
    expect(source.GIT_DIR).toBe('/elsewhere/.git');
  });
});

describe('subprocessEnv', () => {
  it('carries PATH through from the real process environment', () => {
    // PATH is required for every subprocess the bridge spawns; losing it would
    // turn every provider call into a spawn failure.
    expect(subprocessEnv().PATH).toBe(process.env.PATH);
  });

  it('never exposes a repository-selecting variable', () => {
    for (const name of Object.keys(subprocessEnv())) {
      expect(isStrippedGitVariable(name)).toBe(false);
    }
  });

  it('returns a fresh copy so a consumer cannot corrupt the snapshot', () => {
    const first = subprocessEnv();
    first.PATH = '/tampered';
    delete first.HOME;
    const second = subprocessEnv();
    expect(second.PATH).toBe(process.env.PATH);
    expect(second).not.toBe(first);
  });
});

describe('config-injecting and discovery variables', () => {
  // These replace ~/.gitconfig and the system config with a file the LAUNCHING
  // environment chose. Such a file can set core.attributesFile plus a
  // filter.<driver>.clean command, which --no-ext-diff and --no-textconv do not
  // disable — arbitrary code during every working-tree capture.
  it.each(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'])('strips %s', (name) => {
    expect(isStrippedGitVariable(name)).toBe(true);
    expect(sanitizeSubprocessEnv({ [name]: '/tmp/attacker.gitconfig' })).toEqual({});
  });

  // These do not name a repository; they change whether git can FIND one. An
  // inherited ceiling makes a real subdirectory of a real work tree report
  // "not a git repository", which is the failure this module exists to remove.
  it.each(['GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_NAMESPACE'])(
    'strips the discovery variable %s',
    (name) => {
      expect(isStrippedGitVariable(name)).toBe(true);
      expect(sanitizeSubprocessEnv({ [name]: '/Users/me' })).toEqual({});
    },
  );

  it('still preserves the variables the subprocesses genuinely need', () => {
    const kept = sanitizeSubprocessEnv({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      OPENAI_API_KEY: 'secret',
      GIT_CONFIG_GLOBAL: '/tmp/attacker.gitconfig',
    });
    expect(kept).toEqual({ PATH: '/usr/bin', HOME: '/Users/me', OPENAI_API_KEY: 'secret' });
  });
});
