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
