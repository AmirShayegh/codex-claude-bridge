import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_CONFIG } from '../config/types.js';

const codexStub = { reviewPlan: vi.fn(), reviewCode: vi.fn(), reviewPrecommit: vi.fn() };
const geminiStub = { reviewPlan: vi.fn(), reviewCode: vi.fn(), reviewPrecommit: vi.fn() };

// Mock both backend factories so we can assert selection routes correctly and
// the unselected provider is never constructed.
vi.mock('./codex.js', () => ({ createCodexBackend: vi.fn(() => codexStub) }));
vi.mock('./gemini.js', () => ({ createGeminiBackend: vi.fn(() => geminiStub) }));

import { createBackend } from './index.js';
import { createCodexBackend } from './codex.js';
import { createGeminiBackend } from './gemini.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createBackend', () => {
  it("selects the Codex backend when provider is 'codex'", () => {
    const backend = createBackend({ ...DEFAULT_CONFIG, provider: 'codex' });
    expect(createCodexBackend).toHaveBeenCalledOnce();
    expect(createGeminiBackend).not.toHaveBeenCalled();
    expect(backend).toBe(codexStub);
  });

  it("selects the Gemini backend when provider is 'gemini'", () => {
    const backend = createBackend({ ...DEFAULT_CONFIG, provider: 'gemini' });
    expect(createGeminiBackend).toHaveBeenCalledOnce();
    expect(createCodexBackend).not.toHaveBeenCalled();
    expect(backend).toBe(geminiStub);
  });

  it('passes config and copilot instructions through to the selected backend', () => {
    const copilot = { repoWide: null, scoped: [] };
    createBackend({ ...DEFAULT_CONFIG, provider: 'gemini' }, copilot);
    expect(createGeminiBackend).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gemini' }),
      copilot,
    );
  });

  it('does not construct the unselected provider (no Codex SDK init when gemini is chosen)', () => {
    createBackend({ ...DEFAULT_CONFIG, provider: 'gemini' });
    expect(createCodexBackend).not.toHaveBeenCalled();
  });
});
