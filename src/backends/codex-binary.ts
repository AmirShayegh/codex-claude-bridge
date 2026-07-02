import { accessSync, constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

// Discovery of a working system codex binary (ISS-021).
//
// The @openai/codex-sdk spawns its OWN bundled codex binary — never the one on
// PATH. On macOS, XProtect false-positively quarantines that bundled copy, so a
// fresh install fails with PROVIDER_UNAVAILABLE even when a perfectly good,
// properly-notarized codex (OpenAI's standalone installer, brew) already exists
// on the machine. When the caller set no explicit override, the codex backend
// uses this module to find that system binary and retry through the SDK's
// codexPathOverride escape hatch.

// Well-known install locations, probed AFTER the caller's PATH. These matter
// because GUI-spawned processes (e.g. an MCP server launched by a desktop app)
// often run with a minimal PATH that lacks the user's shell additions.
const KNOWN_INSTALL_DIRS = (home: string): string[] => [
  join(home, '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

// How long a candidate gets to prove it runs. `codex --version` is near-instant
// for a healthy binary; a hang here means the candidate is not usable.
const PROBE_TIMEOUT_MS = 5000;

// Injectable seams so tests never touch the real filesystem or spawn processes.
export interface DiscoveryDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  canExecute?: (path: string) => boolean;
  probe?: (path: string) => Promise<boolean>;
}

const defaultCanExecute = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const defaultProbe = (path: string): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: PROBE_TIMEOUT_MS }, (error) => resolve(error === null));
  });

// Find the first codex binary that both exists as an executable AND actually
// runs (`--version` exits 0 — an XProtect-quarantined file can be present yet
// killed on spawn, so existence alone is not enough). Candidates are the
// caller's PATH directories in order, then the well-known install locations.
// Returns the absolute path, or null when no working binary exists.
export async function discoverCodexBinary(deps: DiscoveryDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const canExecute = deps.canExecute ?? defaultCanExecute;
  const probe = deps.probe ?? defaultProbe;

  const pathDirs = (env.PATH ?? '').split(delimiter).filter((d) => d.length > 0);
  const candidates = [...pathDirs, ...KNOWN_INSTALL_DIRS(home)].map((dir) => join(dir, 'codex'));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!canExecute(candidate)) continue;
    if (await probe(candidate)) return candidate;
  }
  return null;
}
