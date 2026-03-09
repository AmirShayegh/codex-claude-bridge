import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { ok, err } from '../utils/errors.js';
import type { Result } from '../utils/errors.js';

export interface ScopedInstruction {
  applyTo: string;
  body: string;
  filename: string;
}

export interface CopilotInstructions {
  repoWide: string | null;
  scoped: ScopedInstruction[];
}

const EMPTY: CopilotInstructions = { repoWide: null, scoped: [] };

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
  const body = lines.slice(closeIdx + 1).join('\n').trim();

  const frontmatter: Record<string, string> = {};
  for (const line of fmLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    if (key) frontmatter[key] = value;
  }

  return { frontmatter, body };
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch (e: unknown) {
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw e;
  }
}

/**
 * Discover and load copilot instruction files from `.github/`.
 * Returns empty instructions if no files exist. Errors only on IO failures.
 */
export function loadCopilotInstructions(cwd?: string): Result<CopilotInstructions> {
  const root = cwd ?? process.cwd();
  const githubDir = join(root, '.github');

  // Repo-wide instructions
  let repoWide: string | null;
  try {
    repoWide = readFileSafe(join(githubDir, 'copilot-instructions.md'));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`CONFIG_ERROR: failed to read copilot-instructions.md: ${msg}`);
  }

  // Scoped instructions
  const instructionsDir = join(githubDir, 'instructions');
  let filenames: string[];
  try {
    filenames = readdirSync(instructionsDir).filter(f => f.endsWith('.instructions.md'));
  } catch (e: unknown) {
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
      filenames = [];
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`CONFIG_ERROR: failed to read instructions directory: ${msg}`);
    }
  }

  const scoped: ScopedInstruction[] = [];
  for (const filename of filenames) {
    let content: string;
    try {
      content = readFileSync(join(instructionsDir, filename), 'utf-8');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Skipping ${filename}: ${msg}`);
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);

    // Skip files excluded from code review
    if (frontmatter.excludeAgent === 'code-review') continue;

    // Skip files without applyTo (can't be auto-applied)
    if (!frontmatter.applyTo) continue;

    if (body.trim()) {
      scoped.push({ applyTo: frontmatter.applyTo, body, filename });
    }
  }

  return ok({ repoWide, scoped });
}

/**
 * Filter scoped instructions to only those matching the given file paths.
 * Repo-wide instructions are always included.
 */
export function filterByFiles(
  instructions: CopilotInstructions | undefined,
  files: string[],
): CopilotInstructions {
  if (!instructions) return EMPTY;
  if (instructions.scoped.length === 0) return instructions;
  if (files.length === 0) return { repoWide: instructions.repoWide, scoped: [] };

  const matched = instructions.scoped.filter(instr => {
    const matchers = instr.applyTo.split(',').map(p => picomatch(p.trim()));
    return files.some(file => matchers.some(m => m(file)));
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
