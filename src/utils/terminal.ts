function hexByte(code: number): string {
  return code.toString(16).toUpperCase().padStart(2, '0');
}

export function escapeTerminalControls(value: string): string {
  let escaped = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    switch (code) {
      case 0x09:
        escaped += '\\t';
        break;
      case 0x0a:
        escaped += '\\n';
        break;
      case 0x0d:
        escaped += '\\r';
        break;
      default:
        if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
          escaped += `\\x${hexByte(code)}`;
        } else {
          escaped += char;
        }
    }
  }
  return escaped;
}

// JSON.stringify escapes C0 characters, but JSON permits DEL/C1 bytes to be
// emitted literally. Render those as JSON-compatible Unicode escapes so JSON
// mode remains parse-equivalent without allowing terminal-control bytes through.
export function stringifyTerminalSafeJson(value: unknown): string {
  const serialized = JSON.stringify(value) ?? 'null';
  let safe = '';
  for (const character of serialized) {
    const code = character.charCodeAt(0);
    safe +=
      code <= 0x1f || (code >= 0x7f && code <= 0x9f)
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : character;
  }
  return safe;
}
