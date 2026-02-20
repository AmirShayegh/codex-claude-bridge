import { describe, it, expect } from 'vitest';
import { ReviewBridgeConfigSchema, DEFAULT_CONFIG } from './types.js';
import type { ReviewBridgeConfig } from './types.js';

describe('ReviewBridgeConfigSchema', () => {
  it('parses empty object to full defaults', () => {
    const result = ReviewBridgeConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      const config: ReviewBridgeConfig = result.data;
      expect(config.model).toBe('gpt-5.2-codex');
      expect(config.reasoning_effort).toBe('medium');
      expect(config.timeout_seconds).toBe(300);
      expect(config.project_context).toBe('');
      expect(config.review_standards.plan_review.focus).toEqual([
        'architecture',
        'feasibility',
      ]);
      expect(config.review_standards.plan_review.depth).toBe('thorough');
      expect(config.review_standards.code_review.criteria).toEqual([
        'bugs',
        'security',
        'performance',
        'style',
      ]);
      expect(config.review_standards.code_review.require_tests).toBe(true);
      expect(config.review_standards.code_review.max_file_size).toBe(500);
      expect(config.review_standards.precommit.auto_diff).toBe(true);
      expect(config.review_standards.precommit.block_on).toEqual(['critical', 'major']);
    }
  });

  it('merges partial config with defaults', () => {
    const partial = {
      model: 'o3',
      timeout_seconds: 120,
    };
    const result = ReviewBridgeConfigSchema.safeParse(partial);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe('o3');
      expect(result.data.timeout_seconds).toBe(120);
      // Defaults for unspecified fields
      expect(result.data.reasoning_effort).toBe('medium');
      expect(result.data.review_standards.plan_review.depth).toBe('thorough');
    }
  });

  it('merges partial nested config with defaults', () => {
    const partial = {
      review_standards: {
        code_review: {
          require_tests: false,
        },
      },
    };
    const result = ReviewBridgeConfigSchema.safeParse(partial);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review_standards.code_review.require_tests).toBe(false);
      // Other code_review defaults preserved
      expect(result.data.review_standards.code_review.max_file_size).toBe(500);
      // Other review_standards defaults preserved
      expect(result.data.review_standards.plan_review.depth).toBe('thorough');
    }
  });

  it('rejects invalid reasoning_effort value', () => {
    const result = ReviewBridgeConfigSchema.safeParse({ reasoning_effort: 'ultra' });
    expect(result.success).toBe(false);
  });

  it('rejects negative timeout_seconds', () => {
    const result = ReviewBridgeConfigSchema.safeParse({ timeout_seconds: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects non-number timeout_seconds', () => {
    const result = ReviewBridgeConfigSchema.safeParse({ timeout_seconds: 'fast' });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer timeout_seconds', () => {
    const result = ReviewBridgeConfigSchema.safeParse({ timeout_seconds: 30.5 });
    expect(result.success).toBe(false);
  });

  it('rejects zero timeout_seconds', () => {
    const result = ReviewBridgeConfigSchema.safeParse({ timeout_seconds: 0 });
    expect(result.success).toBe(false);
  });

  it('parses a full valid config', () => {
    const full = {
      model: 'o3',
      reasoning_effort: 'high',
      timeout_seconds: 600,
      project_context: 'React SPA with GraphQL backend',
      review_standards: {
        plan_review: {
          focus: ['security', 'scalability'],
          depth: 'quick',
        },
        code_review: {
          criteria: ['bugs', 'security'],
          require_tests: false,
          max_file_size: 1000,
        },
        precommit: {
          auto_diff: false,
          block_on: ['critical'],
        },
      },
    };
    const result = ReviewBridgeConfigSchema.safeParse(full);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(full);
    }
  });

  it('rejects invalid block_on severity strings', () => {
    const result = ReviewBridgeConfigSchema.safeParse({
      review_standards: {
        precommit: {
          block_on: ['critical', 'blocker'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts all valid block_on severities', () => {
    const result = ReviewBridgeConfigSchema.safeParse({
      review_standards: {
        precommit: {
          block_on: ['critical', 'major', 'minor', 'suggestion', 'nitpick'],
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('DEFAULT_CONFIG', () => {
  it('has all expected default values', () => {
    expect(DEFAULT_CONFIG.model).toBe('gpt-5.2-codex');
    expect(DEFAULT_CONFIG.reasoning_effort).toBe('medium');
    expect(DEFAULT_CONFIG.timeout_seconds).toBe(300);
    expect(DEFAULT_CONFIG.project_context).toBe('');
    expect(DEFAULT_CONFIG.review_standards.precommit.block_on).toEqual([
      'critical',
      'major',
    ]);
  });

  it('matches parsing an empty object', () => {
    const parsed = ReviewBridgeConfigSchema.parse({});
    expect(DEFAULT_CONFIG).toEqual(parsed);
  });
});
