// The environment handed to every subprocess the bridge spawns — git and both
// provider CLIs.
//
// Why this exists: once a review runs in a caller-chosen directory, ambient
// GIT_* variables become a correctness hazard rather than a convenience. A
// GIT_DIR or GIT_WORK_TREE inherited from whatever launched the MCP server
// silently overrides the directory we just went to the trouble of resolving, so
// a worktree-aware capture would still read the wrong repository. GIT_CONFIG*
// variables are worse: they let the launching environment inject arbitrary git
// configuration (including external diff and filter commands) into every
// capture.
//
// So the repository-selecting and config-injecting variables are stripped, and
// everything else — PATH, HOME, TMPDIR, proxy settings, provider credentials —
// is preserved verbatim, because the subprocesses genuinely need them.

// Variables that redirect git at a different repository, index, or object store.
const REPOSITORY_SELECTING_GIT_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  // Discovery variables do not name a repository, they change whether git can
  // FIND one. An inherited GIT_CEILING_DIRECTORIES stops the upward walk, so a
  // caller naming a real subdirectory of a real work tree is told it is "not
  // inside a git work tree" — the same inherited-environment-overrides-the-
  // request failure as GIT_DIR, reached by a different route.
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  // GLOBAL and SYSTEM replace ~/.gitconfig and the system config with a file the
  // launching environment chose. That file can set `core.attributesFile` and a
  // `filter.<driver>.clean` command, which --no-ext-diff and --no-textconv do
  // NOT disable — so leaving these in would hand the launcher arbitrary code
  // execution during every working-tree capture.
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_SYSTEM',
  'GIT_DIR',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  // Re-bases every ref lookup, including the symbolic-ref/show-ref probes that
  // decide whether HEAD is unborn.
  'GIT_NAMESPACE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
];

// Environment variable names are case-sensitive on POSIX but not on Windows, so
// a lowercase `git_dir` would still reach git there. Compare case-insensitively
// everywhere rather than only on the platform where it currently bites.
const STRIPPED = new Set(REPOSITORY_SELECTING_GIT_VARS.map((name) => name.toLowerCase()));

// `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` … are the indexed form of
// GIT_CONFIG_COUNT and inject config the same way, so they go too.
const INDEXED_CONFIG_PATTERN = /^git_config_(?:key|value)_\d+$/;

export function isStrippedGitVariable(name: string): boolean {
  const lowered = name.toLowerCase();
  return STRIPPED.has(lowered) || INDEXED_CONFIG_PATTERN.test(lowered);
}

// Build a string-only copy of `source` with the repository-selecting and
// config-injecting git variables removed. Node's ProcessEnv is typed as
// possibly-undefined values; a subprocess env must be string-only, so
// undefined entries are dropped rather than stringified into "undefined".
export function sanitizeSubprocessEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isStrippedGitVariable(name)) continue;
    sanitized[name] = value;
  }
  return sanitized;
}

// One snapshot per process, taken at module load. Deliberately a snapshot and
// not a live read: every subprocess in a review should see the same environment,
// and the bridge never mutates process.env, so re-reading it per call would only
// expose the server to interference from anything else in the process.
const SNAPSHOT = sanitizeSubprocessEnv(process.env);

export function subprocessEnv(): Record<string, string> {
  // Copy on every call. Some SDKs mutate the env object they are handed (the
  // Codex SDK prepends PATH entries), and that must not corrupt the snapshot
  // every later review depends on.
  return { ...SNAPSHOT };
}
