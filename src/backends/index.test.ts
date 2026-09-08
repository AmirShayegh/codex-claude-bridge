import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_CONFIG } from '../config/types.js';

const leaf = (provider: 'codex' | 'gemini') => ({
  provider,
  providers: [provider] as const,
  allowsModelOverrideOnResume: provider === 'gemini',
  reviewPlan: vi.fn(),
  reviewCode: vi.fn(),
  reviewPrecommit: vi.fn(),
});
const codexStub = leaf('codex');
const geminiStub = leaf('gemini');
const singleStub = { ...leaf('codex'), kind: 'single' };
const compositeStub = { ...leaf('codex'), kind: 'composite' };

// Mock the leaf factories and the composite/single decorators so we can assert
// which composition createBackend picks. Per-mode dispatch (failover vs
// deliberate) now lives INSIDE the composite (tested in composite.test.ts); here
// we only assert single → withSingleMode and any two-provider mode → composite.
vi.mock('./codex.js', () => ({ createCodexBackend: vi.fn(() => codexStub) }));
vi.mock('./gemini.js', () => ({ createGeminiBackend: vi.fn(() => geminiStub) }));
vi.mock('./composite.js', () => ({
  createCompositeBackend: vi.fn(() => compositeStub),
  withSingleMode: vi.fn(() => singleStub),
}));

import { createBackend } from './index.js';
import { createCodexBackend } from './codex.js';
import { createGeminiBackend } from './gemini.js';
import { createCompositeBackend, withSingleMode } from './composite.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createBackend — single provider', () => {
  it("mode 'single' wraps the bare leaf in the single-mode decorator, no other provider constructed", () => {
    const backend = createBackend({ ...DEFAULT_CONFIG, provider: 'codex', mode: 'single' });
    expect(createCodexBackend).toHaveBeenCalledOnce();
    expect(createGeminiBackend).not.toHaveBeenCalled();
    expect(withSingleMode).toHaveBeenCalledWith(codexStub);
    expect(createCompositeBackend).not.toHaveBeenCalled();
    expect(backend).toBe(singleStub);
  });

  it('fallback:false (no mode) still maps to single — back-compat', () => {
    const backend = createBackend({ ...DEFAULT_CONFIG, provider: 'gemini', fallback: false });
    expect(createGeminiBackend).toHaveBeenCalledOnce();
    expect(createCodexBackend).not.toHaveBeenCalled();
    expect(withSingleMode).toHaveBeenCalledWith(geminiStub);
    expect(backend).toBe(singleStub);
  });
});

describe('createBackend — two-provider composite', () => {
  it('default (fallback on, no mode) builds both leaves and the composite, passing config + lookup', () => {
    const lookup = vi.fn();
    const config = { ...DEFAULT_CONFIG, provider: 'codex' as const };
    const backend = createBackend(config, lookup);
    expect(createCodexBackend).toHaveBeenCalledOnce();
    expect(createGeminiBackend).toHaveBeenCalledOnce();
    expect(createCompositeBackend).toHaveBeenCalledWith(codexStub, geminiStub, config, lookup);
    expect(withSingleMode).not.toHaveBeenCalled();
    expect(backend).toBe(compositeStub);
  });

  it('injects persisted model lookup into every Codex leaf', () => {
    const providerLookup = vi.fn();
    const modelLookup = vi.fn();
    const config = { ...DEFAULT_CONFIG, provider: 'gemini' as const, mode: 'deliberate' as const };

    createBackend(config, providerLookup, modelLookup);

    expect(createCodexBackend).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex' }),
      { lookupSessionModel: modelLookup },
    );
    expect(createCompositeBackend).toHaveBeenCalledWith(
      geminiStub,
      codexStub,
      config,
      providerLookup,
    );
  });

  it('builds the secondary leaf with the other provider and a cleared model pin', () => {
    createBackend({ ...DEFAULT_CONFIG, provider: 'codex', model: 'gpt-5.4' });
    expect(createGeminiBackend).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gemini', model: undefined }),
    );
  });

  it('deliberate/deliberate-deep also build the composite (per-call dispatch lives inside it)', () => {
    createBackend({ ...DEFAULT_CONFIG, provider: 'codex', mode: 'deliberate' });
    expect(createCompositeBackend).toHaveBeenCalledOnce();
    vi.clearAllMocks();
    createBackend({ ...DEFAULT_CONFIG, provider: 'codex', mode: 'deliberate-deep' });
    expect(createCompositeBackend).toHaveBeenCalledOnce();
  });

  it('from gemini primary, wraps codex as the secondary', () => {
    createBackend({ ...DEFAULT_CONFIG, provider: 'gemini', mode: 'deliberate' });
    expect(createGeminiBackend).toHaveBeenCalledOnce(); // primary
    expect(createCodexBackend).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex', model: undefined }),
    );
  });
});
