import { describe, expect, it } from 'vitest';
import { escapeTerminalControls } from './terminal.js';

describe('escapeTerminalControls', () => {
  it('leaves printable Unicode unchanged', () => {
    expect(escapeTerminalControls('gpt-5.6-sol — Gemini')).toBe('gpt-5.6-sol — Gemini');
  });

  it('renders common whitespace controls as visible escape sequences', () => {
    expect(escapeTerminalControls('a\tb\nc\rd')).toBe('a\\tb\\nc\\rd');
  });

  it('escapes every C0, DEL, and C1 control without emitting raw bytes', () => {
    const codes = [
      ...Array.from({ length: 0x20 }, (_, code) => code),
      ...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
    ];
    for (const code of codes) {
      const expected =
        code === 0x09
          ? '\\t'
          : code === 0x0a
            ? '\\n'
            : code === 0x0d
              ? '\\r'
              : `\\x${code.toString(16).toUpperCase().padStart(2, '0')}`;
      const output = escapeTerminalControls(String.fromCharCode(code));
      expect(output).toBe(expected);
      expect(
        [...output].every((char) => {
          const outputCode = char.charCodeAt(0);
          return outputCode > 0x1f && (outputCode < 0x7f || outputCode > 0x9f);
        }),
      ).toBe(true);
    }
  });
});
