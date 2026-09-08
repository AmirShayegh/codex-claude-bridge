import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { escapeTerminalControls } from '../utils/terminal.js';
import { ok, err, ErrorCode } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';

export interface ScopedInstruction {
  applyTo: string;
  body: string;
  filename: string;
}

export interface CopilotInstructions {
  repoWide: string | null;
  // Readonly because a loaded result is frozen and shared between concurrent
  // requests for the same repository — no consumer may mutate it in place.
  readonly scoped: readonly ScopedInstruction[];
}

// Bounds. Instruction files are read from a directory the CALLER names, so their
// size and count are caller-influenced: without a ceiling, one oversized file (or
// a directory full of them) becomes an unbounded read and an unbounded prompt.
// These are far above any real .github/instructions tree.
export const MAX_SCOPED_INSTRUCTION_FILES = 64;
export const MAX_INSTRUCTION_FILE_BYTES = 64 * 1024;
export const MAX_INSTRUCTION_AGGREGATE_BYTES = 256 * 1024;

function empty(): CopilotInstructions {
  return { repoWide: null, scoped: [] };
}

/**
 * Parse YAML-like frontmatter delimited by `---`.
 * Returns the key-value pairs and the markdown body.
 * Handles only simple `key: value` lines (no nested YAML).
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const lines = content.trimStart().split('\n');
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: content };
  }

  // Find closing delimiter on its own line
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return { frontmatter: {}, body: content };
  }

  const fmLines = lines.slice(1, closeIdx);
  const body = lines
    .slice(closeIdx + 1)
    .join('\n')
    .trim();

  const frontmatter: Record<string, string> = {};
  for (const line of fmLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    if (key) frontmatter[key] = value;
  }

  return { frontmatter, body };
}

type ReadOutcome =
  | { kind: 'ok'; text: string; bytes: number }
  | { kind: 'missing' }
  | { kind: 'oversize'; bytes: number }
  | { kind: 'error'; message: string };

// Read a file only once its size is known to be within bounds. The size comes
// from the OPEN HANDLE, not a separate stat of the path, so the file that is
// measured is exactly the file that is read.
async function readBounded(path: string): Promise<ReadOutcome> {
  // Check the TYPE before opening. `open()` on a FIFO blocks until a writer
  // appears — forever, if none ever does — and it would block while holding a
  // preparation permit, so a handful of them would wedge the server for good.
  // stat() never blocks on a FIFO, and it follows symlinks, so a legitimate
  // symlinked instruction file still works.
  try {
    const probe = await stat(path);
    if (!probe.isFile()) return { kind: 'missing' };
  } catch (e: unknown) {
    if (isErrno(e, 'ENOENT') || isErrno(e, 'ENOTDIR')) return { kind: 'missing' };
    return { kind: 'error', message: messageOf(e) };
  }

  let handle;
  try {
    handle = await open(path, 'r');
  } catch (e: unknown) {
    if (isErrno(e, 'ENOENT')) return { kind: 'missing' };
    return { kind: 'error', message: messageOf(e) };
  }
  try {
    // Re-checked on the OPEN HANDLE, which closes the stat-then-open window:
    // the file that is measured is exactly the file that is read.
    const stats = await handle.stat();
    if (!stats.isFile()) return { kind: 'missing' };
    if (stats.size > MAX_INSTRUCTION_FILE_BYTES) {
      return { kind: 'oversize', bytes: stats.size };
    }
    // Bound the READ itself, not only the size check: a file that grows between
    // stat and read would otherwise be read in full and accounted at its old
    // size. Reading one byte past the limit is how "too big" is detected, and
    // the bytes actually read are what get accounted.
    const buffer = Buffer.alloc(MAX_INSTRUCTION_FILE_BYTES + 1);
    let bytesRead = 0;
    // A single read may come back short, so read until EOF or the bound.
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MAX_INSTRUCTION_FILE_BYTES) {
      return { kind: 'oversize', bytes: bytesRead };
    }
    return { kind: 'ok', text: buffer.toString('utf-8', 0, bytesRead), bytes: bytesRead };
  } catch (e: unknown) {
    return { kind: 'error', message: messageOf(e) };
  } finally {
    await handle.close().catch(() => {});
  }
}

function isErrno(e: unknown, code: string): boolean {
  return e instanceof Error && (e as NodeJS.ErrnoException).code === code;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function limitError<T>(detail: string): Result<T> {
  return err(`${ErrorCode.INVALID_INPUT}: ${escapeTerminalControls(detail)}`);
}

function tooLarge(label: string, bytes: number): string {
  return (
    `${label} is ${bytes} bytes, over the ${MAX_INSTRUCTION_FILE_BYTES}-byte per-file limit ` +
    `for repository instruction files`
  );
}

async function readInstructions(root: string): Promise<Result<CopilotInstructions>> {
  const githubDir = join(root, '.github');

  let aggregate = 0;

  // Repo-wide instructions
  const repoWideRead = await readBounded(join(githubDir, 'copilot-instructions.md'));
  if (repoWideRead.kind === 'error') {
    return err(`CONFIG_ERROR: failed to read copilot-instructions.md: ${repoWideRead.message}`);
  }
  if (repoWideRead.kind === 'oversize') {
    return limitError(tooLarge('.github/copilot-instructions.md', repoWideRead.bytes));
  }
  let repoWide: string | null = null;
  if (repoWideRead.kind === 'ok') {
    repoWide = repoWideRead.text;
    aggregate += repoWideRead.bytes;
  }

  // Scoped instructions
  const instructionsDir = join(githubDir, 'instructions');
  let filenames: string[];
  try {
    filenames = (await readdir(instructionsDir)).filter((f) => f.endsWith('.instructions.md'));
  } catch (e: unknown) {
    if (isErrno(e, 'ENOENT') || isErrno(e, 'ENOTDIR')) {
      filenames = [];
    } else {
      return err(`CONFIG_ERROR: failed to read instructions directory: ${messageOf(e)}`);
    }
  }
  if (filenames.length > MAX_SCOPED_INSTRUCTION_FILES) {
    return limitError(
      `.github/instructions holds ${filenames.length} instruction files, over the ` +
        `${MAX_SCOPED_INSTRUCTION_FILES}-file limit`,
    );
  }
  // Directory order is filesystem-dependent; sorting keeps the assembled prompt
  // identical for the same tree on any machine.
  filenames.sort();

  const scoped: ScopedInstruction[] = [];
  for (const filename of filenames) {
    const read = await readBounded(join(instructionsDir, filename));
    if (read.kind === 'oversize') {
      return limitError(tooLarge(`.github/instructions/${filename}`, read.bytes));
    }
    if (read.kind === 'missing') continue;
    if (read.kind === 'error') {
      // An ordinary read failure on ONE scoped file skips that file rather than
      // failing the review — long-standing behavior, deliberately kept.
      console.error(
        `Skipping ${escapeTerminalControls(filename)}: ${escapeTerminalControls(read.message)}`,
      );
      continue;
    }

    aggregate += read.bytes;
    if (aggregate > MAX_INSTRUCTION_AGGREGATE_BYTES) {
      return limitError(
        `repository instruction files exceed the ${MAX_INSTRUCTION_AGGREGATE_BYTES}-byte total limit`,
      );
    }

    const { frontmatter, body } = parseFrontmatter(read.text);

    // Skip files excluded from code review
    const excluded = (frontmatter.excludeAgent ?? '').split(',').map((s) => s.trim());
    if (excluded.includes('code-review')) continue;

    // Skip files without applyTo (can't be auto-applied)
    if (!frontmatter.applyTo) continue;

    if (body.trim()) {
      scoped.push({ applyTo: frontmatter.applyTo, body, filename });
    }
  }

  // Concurrent requests for the same root share one result object; freezing it
  // means no request can alter what another request is about to send.
  return ok(Object.freeze({ repoWide, scoped: Object.freeze(scoped) }));
}

// In-flight loads only. Two requests arriving together for the same repository
// read it once; a request arriving after the first has settled reads again, so
// an edit to an instruction file takes effect on the very next review.
const inFlight = new Map<string, Promise<Result<CopilotInstructions>>>();

/**
 * Discover and load copilot instruction files under `root`/.github.
 * Returns empty instructions when no files exist; INVALID_INPUT when the tree
 * exceeds the size/count bounds; CONFIG_ERROR on an IO failure.
 */
export function loadCopilotInstructions(root: string): Promise<Result<CopilotInstructions>> {
  const existing = inFlight.get(root);
  if (existing) return existing;

  const pending = readInstructions(root).finally(() => {
    // Remove the entry only if it is still OURS: a load that started after this
    // one settled must not be evicted by this one's cleanup.
    if (inFlight.get(root) === pending) inFlight.delete(root);
  });
  inFlight.set(root, pending);
  return pending;
}

/**
 * Filter scoped instructions to only those matching the given file paths.
 * Repo-wide instructions are always included.
 */
export function filterByFiles(
  instructions: CopilotInstructions | undefined,
  files: string[],
): CopilotInstructions {
  if (!instructions) return empty();
  if (instructions.scoped.length === 0) return instructions;
  if (files.length === 0) return { repoWide: instructions.repoWide, scoped: [] };

  const matched = instructions.scoped.filter((instr) => {
    const matchers: picomatch.Matcher[] = [];
    for (const p of instr.applyTo.split(',')) {
      try {
        matchers.push(picomatch(p.trim()));
      } catch {
        console.error(
          `Invalid applyTo glob in ${escapeTerminalControls(instr.filename)}: ` +
            escapeTerminalControls(p.trim()),
        );
      }
    }
    if (matchers.length === 0) return false;
    return files.some((file) => matchers.some((m) => m(file)));
  });

  return { repoWide: instructions.repoWide, scoped: matched };
}

/**
 * Format instructions into a single string for prompt injection.
 * Returns empty string if no instructions are present.
 */
export function formatForPrompt(instructions: CopilotInstructions | undefined): string {
  if (!instructions) return '';

  const parts: string[] = [];

  if (instructions.repoWide?.trim()) {
    parts.push(instructions.repoWide.trim());
  }

  for (const instr of instructions.scoped) {
    parts.push(instr.body.trim());
  }

  return parts.join('\n\n');
}
