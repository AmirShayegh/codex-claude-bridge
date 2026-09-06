import { z } from 'zod';

// C0 (U+0000–U+001F), DEL (U+007F), and C1 (U+0080–U+009F) can forge
// terminal/log lines or alter subprocess arguments. Keep this check shared so
// config, MCP, CLI, and persisted metadata apply the same boundary rules.
export function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

const ControlFreeStringSchema = z.string().refine((value) => !containsControlCharacters(value), {
  message: 'must not contain control characters',
});

// Model names are an open selector, not an allowlist. Normalize ordinary
// surrounding whitespace, then enforce a bounded printable value.
export const ModelSelectorSchema = ControlFreeStringSchema.transform((value) => value.trim()).pipe(
  z.string().min(1, 'must not be empty').max(200, 'must be at most 200 characters'),
);

// Session IDs are opaque provider-owned identifiers. Never normalize them: a
// caller must supply the exact identifier that was returned by the provider.
export const SessionIdSchema = ControlFreeStringSchema.min(1, 'must not be empty')
  .max(256, 'must be at most 256 characters')
  .refine((value) => value === value.trim(), {
    message: 'must not have surrounding whitespace',
  });

// The per-call working directory (ISS-027). The MCP surface accepts an absolute
// path only — a relative one would resolve against the SERVER's directory, which
// is the confusion this parameter exists to remove. Full validation (existence,
// type, readability, canonicalization) happens in resolveWorkspace; this is the
// cheap syntactic gate that a malformed value never gets past.
export const CWD_DESCRIPTION =
  'Absolute path to the directory this review runs in — the repository or git worktree ' +
  'whose code is being reviewed. Auto-capture, repository instruction files, and the ' +
  'reviewer subprocess all use it. Omit to use the directory the server was started in. ' +
  'Must be absolute; "~" is not expanded. Applies to this call only — pass it again on resume.';

export const WorkingDirectorySchema = ControlFreeStringSchema.min(1, 'must not be empty').max(
  4096,
  'must be at most 4096 characters',
);
