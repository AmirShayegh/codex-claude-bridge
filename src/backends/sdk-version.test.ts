import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// Regression guard: the Codex SDK pins its CLI binary version exactly. If
// the dep range here drifts, the bundled CLI changes too — and we've shipped
// at least one release where that drift broke the advertised default model
// (0.104.0 bundled CLI rejected gpt-5.5 outright). Future SDK bumps must
// re-prove the matrix and update both constants together.
const EXPECTED_SDK_VERSION = '0.128.0';

const ourPkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
) as { dependencies: Record<string, string> };

const sdkPkg = JSON.parse(
  readFileSync(new URL('../../node_modules/@openai/codex-sdk/package.json', import.meta.url), 'utf-8'),
) as { dependencies: Record<string, string> };

describe('SDK + bundled CLI version pinning', () => {
  it('our @openai/codex-sdk dep is exact-pinned to a tested version', () => {
    expect(ourPkg.dependencies['@openai/codex-sdk']).toBe(EXPECTED_SDK_VERSION);
  });

  it('SDK bundles the matching CLI binary version', () => {
    expect(sdkPkg.dependencies['@openai/codex']).toBe(EXPECTED_SDK_VERSION);
  });
});
