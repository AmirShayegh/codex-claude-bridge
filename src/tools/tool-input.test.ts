import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ReviewTierSchema } from '../config/types.js';
import {
  ModelSelectorSchema,
  SessionIdSchema,
  WorkingDirectorySchema,
} from '../utils/input-validation.js';
import {
  classifyToolArguments,
  selectModel,
  toolInputSchema,
  withArgumentReport,
} from './tool-input.js';

// A slice of the real review_plan shape: enough to exercise every disposition.
const SHAPE = {
  plan: z.string(),
  cwd: WorkingDirectorySchema.optional(),
  session_id: SessionIdSchema.optional(),
  model: ModelSelectorSchema.optional(),
  tier: ReviewTierSchema.optional(),
  depth: z.enum(['quick', 'thorough']).optional(),
};
const ACCEPTED = Object.keys(SHAPE);
const REVIEW = { refuseSelectorIntent: true };
const LOOKUP = { refuseSelectorIntent: false };
const ESC = String.fromCharCode(0x1b);

function classify(raw: Record<string, unknown>, options = REVIEW) {
  const result = classifyToolArguments(SHAPE, raw, options);
  if (!result.ok) throw new Error(`unexpected refusal: ${result.error}`);
  return result.data;
}

describe('toolInputSchema', () => {
  it('keeps unknown keys so the handler can see them (ISS-054)', () => {
    const parsed = toolInputSchema(SHAPE).parse({ plan: 'p', tier: 'max', effort: 'max' });
    expect(parsed).toMatchObject({ plan: 'p', tier: 'max', effort: 'max' });
  });

  it('still validates the known keys', () => {
    expect(() => toolInputSchema(SHAPE).parse({ plan: 'p', tier: 'turbo' })).toThrow();
  });
});

describe('classifyToolArguments', () => {
  it('passes exact arguments through with an empty report', () => {
    const { args, report } = classify({ plan: 'p', tier: 'max' });
    expect(args).toEqual({ plan: 'p', tier: 'max' });
    expect(report).toEqual({});
  });

  describe('fold', () => {
    it('folds a near-miss key into the intended parameter and records the correction', () => {
      const { args, report } = classify({ plan: 'p', modle: 'gpt-5.6-sol' });
      expect(args.model).toBe('gpt-5.6-sol');
      expect(args).not.toHaveProperty('modle');
      expect(report.argument_corrections).toEqual([{ from: 'modle', to: 'model' }]);
      expect(report.ignored_arguments).toBeUndefined();
      expect(report.accepted_arguments).toEqual(ACCEPTED);
    });

    it("applies the target parameter's own schema to the folded value", () => {
      const { args } = classify({ plan: 'p', modle: '  gpt-5.6-sol  ' });
      expect(args.model).toBe('gpt-5.6-sol');
    });

    it('folds curated aliases and camelCase spellings', () => {
      expect(classify({ plan: 'p', session: 'abc' }).args.session_id).toBe('abc');
      expect(classify({ plan: 'p', sessionId: 'abc' }).args.session_id).toBe('abc');
      expect(classify({ plan: 'p', working_directory: '/abs' }).args.cwd).toBe('/abs');
    });

    it('does not fold when the value fails the target schema', () => {
      const { args, report } = classify({ plan: 'p', modle: 42 });
      expect(args).not.toHaveProperty('model');
      expect(report.argument_corrections).toBeUndefined();
      expect(report.ignored_arguments).toEqual(['modle']);
    });

    it('never clobbers a parameter the caller actually passed', () => {
      const { args, report } = classify({ plan: 'p', model: 'gpt-6-astra', modle: 'gpt-5.6-sol' });
      expect(args.model).toBe('gpt-6-astra');
      expect(report.ignored_arguments).toEqual(['modle']);
    });

    it('is stricter about distance on short parameter names', () => {
      expect(classify({ plan: 'p', dpth: 'quick' }).args.depth).toBe('quick');
      const far = classify({ plan: 'p', dp: 'quick' });
      expect(far.args).not.toHaveProperty('depth');
      expect(far.report.ignored_arguments).toEqual(['dp']);
    });
  });

  describe('echo', () => {
    it('proceeds and names the ignored key plus every accepted parameter', () => {
      const { args, report } = classify({ plan: 'p', priority: 'high' });
      expect(args).toEqual({ plan: 'p' });
      expect(report.ignored_arguments).toEqual(['priority']);
      expect(report.accepted_arguments).toEqual(ACCEPTED);
    });

    it('sanitizes echoed key names (caller input)', () => {
      const { report } = classify({ plan: 'p', [`bad${ESC}key`]: 1, ['k'.repeat(100)]: 1 });
      expect(report.ignored_arguments?.[0]).not.toContain(ESC);
      expect(report.ignored_arguments?.[1]).toHaveLength(64);
    });
  });

  describe('refuse', () => {
    it('refuses a tier-word value under an unknown key when no selector was given', () => {
      const result = classifyToolArguments(SHAPE, { plan: 'p', effort: 'MAX' }, REVIEW);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/^INVALID_INPUT: /);
      expect(result.error).toContain('"effort"');
      expect(result.error).toContain('tier: "max"');
      for (const name of ACCEPTED) expect(result.error).toContain(name);
    });

    it('refuses a known model id or "latest" under an unknown key, hinting model', () => {
      const astra = classifyToolArguments(SHAPE, { plan: 'p', quality: 'gpt-6-astra' }, REVIEW);
      expect(astra.ok).toBe(false);
      if (!astra.ok) expect(astra.error).toContain('model: "gpt-6-astra"');
      const latest = classifyToolArguments(SHAPE, { plan: 'p', quality: 'latest' }, REVIEW);
      expect(latest.ok).toBe(false);
    });

    it('only echoes when a selector WAS given (the review runs at the chosen tier)', () => {
      const { args, report } = classify({ plan: 'p', tier: 'balanced', effort: 'max' });
      expect(args.tier).toBe('balanced');
      expect(report.ignored_arguments).toEqual(['effort']);
    });

    it('treats a folded selector as a selector', () => {
      const { args, report } = classify({ plan: 'p', modle: 'gpt-5.6-sol', effort: 'max' });
      expect(args.model).toBe('gpt-5.6-sol');
      expect(report.ignored_arguments).toEqual(['effort']);
    });

    it('never fires for a lookup tool', () => {
      const { report } = classify({ plan: 'p', effort: 'max' }, LOOKUP);
      expect(report.ignored_arguments).toEqual(['effort']);
    });

    it('ignores non-selector values', () => {
      expect(classify({ plan: 'p', effort: 'high' }).report.ignored_arguments).toEqual(['effort']);
    });
  });
});

describe('selectModel', () => {
  it('folds tier into the single selector the backends take', () => {
    expect(selectModel({ tier: 'max' })).toEqual({ ok: true, data: 'max' });
    expect(selectModel({ model: 'gpt-6-astra' })).toEqual({ ok: true, data: 'gpt-6-astra' });
    expect(selectModel({})).toEqual({ ok: true, data: undefined });
  });

  it('refuses model and tier together', () => {
    const result = selectModel({ model: 'gpt-6-astra', tier: 'max' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^INVALID_INPUT: .*model.*tier/);
  });
});

describe('withArgumentReport', () => {
  it('adds only the fields the report carries', () => {
    expect(withArgumentReport({ verdict: 'approve' }, {})).toEqual({ verdict: 'approve' });
    expect(
      withArgumentReport(
        { verdict: 'approve' },
        { ignored_arguments: ['x'], accepted_arguments: ['a'] },
      ),
    ).toEqual({ verdict: 'approve', ignored_arguments: ['x'], accepted_arguments: ['a'] });
  });
});
