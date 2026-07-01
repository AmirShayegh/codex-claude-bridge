import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_CONFIG } from '../config/types.js';

const leaf = (provider: 'codex' | 'gemini') => ({
  provider,
  allowsModelOverrideOnResume: provider === 'gemini',
  reviewPlan: vi.fn(),
  reviewCode: vi.fn(),
  reviewPrecommit: vi.fn(),
});
const codexStub = leaf('codex');
const geminiStub = leaf('gemini');
const failoverStub = { ...leaf('codex'), kind: 'failover' };
const deliberationStub = { ...leaf('codex'), kind: 'deliberation' };

// Mock the leaf factories and both composite factories so we can assert which
// composition createBackend picks for each mode.
vi.mock('./codex.js', () => ({ createCodexBackend: vi.fn(() => codexStub) }));
vi.mock('./gemini.js', () => ({ createGeminiBackend: vi.fn(() => geminiStub) }));
vi.mock('./failover.js', () => ({ createFailoverBackend: vi.fn(() => failoverStub) }));
vi.mock('./deliberation.js', () => ({ createDeliberationBackend: vi.fn(() => deliberationStub) }));

import { createBackend } from './index.js';
import { createCodexBackend } from './codex.js';
import { createGeminiBackend } from './gemini.js';
import { createFailoverBackend } from './failover.js';
import { createDeliberationBackend } from './deliberation.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createBackend — single provider', () => {
  it("mode 'single' returns the bare configured leaf, no other provider constructed", () => {
    const backend = createBackend({ ...DEFAULT_CONFIG, provider: 'codex', mode: 'single' });
    expect(createCodexBackend).toHaveBeenCalledOnce();
    expect(createGeminiBackend).not.toHaveBeenCalled();
    expect(createFailoverBackend).not.toHaveBeenCalled();
    expect(backend).toBe(codexStub);
  });

  it('fallback:false (no mode) still maps to single — back-compat', () => {
    const backend = createBackend({ ...DEFAULT_CONFIG, provider: 'gemini', fallback: false });
    expect(createGeminiBackend).toHaveBeenCalledOnce();
    expect(createCodexBackend).not.toHaveBeenCalled();
    expect(backend).toBe(geminiStub);
  });
});

describe('createBackend — failover (default)', () => {
  it('default (fallback on, no mode) builds both leaves and the failover composite', () => {
    const backend = createBackend({ ...DEFAULT_CONFIG, provider: 'codex' });
    expect(createCodexBackend).toHaveBeenCalledOnce();
    expect(createGeminiBackend).toHaveBeenCalledOnce();
    expect(createFailoverBackend).toHaveBeenCalledWith(codexStub, geminiStub);
    expect(createDeliberationBackend).not.toHaveBeenCalled();
    expect(backend).toBe(failoverStub);
  });

  it('builds the secondary leaf with the other provider and a cleared model pin', () => {
    createBackend({ ...DEFAULT_CONFIG, provider: 'codex', model: 'gpt-5.4' });
    expect(createGeminiBackend).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gemini', model: undefined }),
      undefined,
    );
  });
});

describe('createBackend — deliberate', () => {
  it("mode 'deliberate' builds both leaves and the deliberation composite", () => {
    const backend = createBackend({ ...DEFAULT_CONFIG, provider: 'codex', mode: 'deliberate' });
    expect(createCodexBackend).toHaveBeenCalledOnce();
    expect(createGeminiBackend).toHaveBeenCalledOnce();
    expect(createDeliberationBackend).toHaveBeenCalledWith(codexStub, geminiStub);
    expect(createFailoverBackend).not.toHaveBeenCalled();
    expect(backend).toBe(deliberationStub);
  });

  it('deliberate from gemini wraps codex as the secondary', () => {
    createBackend({ ...DEFAULT_CONFIG, provider: 'gemini', mode: 'deliberate' });
    expect(createGeminiBackend).toHaveBeenCalledOnce(); // primary
    expect(createCodexBackend).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex', model: undefined }),
      undefined,
    );
  });

  it("mode 'deliberate-deep' turns on the cross-review round via the composite opts", () => {
    const backend = createBackend({ ...DEFAULT_CONFIG, provider: 'codex', mode: 'deliberate-deep' });
    expect(createDeliberationBackend).toHaveBeenCalledWith(codexStub, geminiStub, { crossReview: true });
    expect(createFailoverBackend).not.toHaveBeenCalled();
    expect(backend).toBe(deliberationStub);
  });
});
