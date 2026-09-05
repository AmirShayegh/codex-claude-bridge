import { describe, expect, it } from 'vitest';
import { ModelSelectorSchema, SessionIdSchema } from './input-validation.js';

describe('ModelSelectorSchema', () => {
  it('trims ordinary surrounding spaces', () => {
    expect(ModelSelectorSchema.parse('  gpt-5.6-sol  ')).toBe('gpt-5.6-sol');
  });

  it('accepts printable selectors from 1 through 200 characters after trimming', () => {
    expect(ModelSelectorSchema.safeParse('x').success).toBe(true);
    expect(ModelSelectorSchema.parse(`  ${'x'.repeat(200)}  `)).toHaveLength(200);
  });

  it('rejects blank and overlong selectors', () => {
    expect(ModelSelectorSchema.safeParse('').success).toBe(false);
    expect(ModelSelectorSchema.safeParse('   ').success).toBe(false);
    expect(ModelSelectorSchema.safeParse('x'.repeat(201)).success).toBe(false);
  });

  it('rejects C0, C1, and DEL control characters anywhere in the input', () => {
    for (const code of [0x00, 0x09, 0x0a, 0x1f, 0x7f, 0x80, 0x85, 0x9f]) {
      expect(ModelSelectorSchema.safeParse(`safe${String.fromCharCode(code)}forged`).success).toBe(
        false,
      );
    }
  });
});

describe('SessionIdSchema', () => {
  it('accepts printable session IDs from 1 through 256 characters', () => {
    expect(SessionIdSchema.safeParse('a').success).toBe(true);
    expect(SessionIdSchema.safeParse('x'.repeat(256)).success).toBe(true);
  });

  it('rejects blank, overlong, and surrounding-whitespace IDs without trimming them', () => {
    for (const sessionId of ['', ' ', ' session', 'session ', 'x'.repeat(257)]) {
      expect(SessionIdSchema.safeParse(sessionId).success).toBe(false);
    }
  });

  it('rejects C0, C1, and DEL control characters', () => {
    for (const code of [0x00, 0x09, 0x0a, 0x1f, 0x7f, 0x80, 0x85, 0x9f]) {
      expect(SessionIdSchema.safeParse(`safe${String.fromCharCode(code)}forged`).success).toBe(
        false,
      );
    }
  });
});
