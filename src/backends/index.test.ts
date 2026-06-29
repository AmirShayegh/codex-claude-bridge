import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_CONFIG } from '../config/types.js';

const codexStub = {
  provider: 'codex' as const,
  allowsModelOverrideOnResume: false,
  reviewPlan: vi.fn(),
  reviewCode: vi.fn(),
  reviewPrecommit: vi.fn(),
};
const geminiStub = {
  provider: 'gemini' as const,
  allowsModelOverrideOnResume: true,
  reviewPlan: vi.fn(),
  reviewCode: vi.fn(),
  reviewPrecommit: vi.fn(),
};

// Mock both backend factories so we can assert selection + failover wiring.
vi.mock('./codex.js', () => ({ createCodexBackend: vi.fn(() => codexStub) }));
vi.mock('./gemini.js', () => ({ createGeminiBackend: vi.fn(() => geminiStub) }));

import { createBackend } from './index.js';
import { createCodexBackend } from './codex.js';
import { createGeminiBackend } from './gemini.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createBackend — single provider (fallback off)', () => {
  it("returns the bare Codex leaf when provider is 'codex' and fallback is off", () => {
    const backend = createBackend({ ...DEFAULT_CONFIG, provider: 'codex', fallback: false });
    expect(createCodexBackend).toHaveBeenCalledOnce();
    expect(createGeminiBackend).not.toHaveBeenCalled();
    expect(backend).toBe(codexStub);
  });

  it("returns the bare Gemini leaf when provider is 'gemini' and fallback is off", () => {
    const backend = createBackend({ ...DEFAULT_CONFIG, provider: 'gemini', fallback: false });
    expect(createGeminiBackend).toHaveBeenCalledOnce();
    expect(createCodexBackend).not.toHaveBeenCalled();
    expect(backend).toBe(geminiStub);
  });

  it('passes config and copilot instructions through to the selected backend', () => {
    const copilot = { repoWide: null, scoped: [] };
    createBackend({ ...DEFAULT_CONFIG, provider: 'gemini', fallback: false }, copilot);
    expect(createGeminiBackend).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gemini' }),
      copilot,
    );
  });
});

describe('createBackend — failover (default)', () => {
  it('wraps the configured provider with the other one as the failover secondary', () => {
    const backend = createBackend({ ...DEFAULT_CONFIG, provider: 'codex' });
    // Both leaves are constructed: codex primary + gemini secondary.
    expect(createCodexBackend).toHaveBeenCalledOnce();
    expect(createGeminiBackend).toHaveBeenCalledOnce();
    // The composite presents as the primary, and is not a bare leaf.
    expect(backend).not.toBe(codexStub);
    expect(backend.provider).toBe('codex');
    expect(backend.allowsModelOverrideOnResume).toBe(false); // primary's flag
  });

  it('builds the secondary leaf with the other provider and a cleared model pin', () => {
    createBackend({ ...DEFAULT_CONFIG, provider: 'codex', model: 'gpt-5.4' });
    // Secondary (gemini) must not inherit the primary's codex model pin.
    expect(createGeminiBackend).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gemini', model: undefined }),
      undefined,
    );
  });

  it('fails over from gemini to codex when gemini is the configured provider', () => {
    const backend = createBackend({ ...DEFAULT_CONFIG, provider: 'gemini' });
    expect(createGeminiBackend).toHaveBeenCalledOnce();
    expect(createCodexBackend).toHaveBeenCalledOnce();
    expect(backend.provider).toBe('gemini');
  });
});
