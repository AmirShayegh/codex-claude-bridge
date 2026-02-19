import { describe, it, expect } from 'vitest';
import {
  PlanFindingSeveritySchema,
  CodeFindingSeveritySchema,
  FindingSeveritySchema,
  PlanFindingSchema,
  CodeFindingSchema,
  ReviewFindingSchema,
  PlanReviewResultSchema,
  CodeReviewResultSchema,
  PrecommitResultSchema,
  ReviewStatusSchema,
  ReviewHistoryEntrySchema,
} from './types.js';

describe('PlanFindingSeveritySchema', () => {
  it('accepts plan-specific severities', () => {
    expect(PlanFindingSeveritySchema.safeParse('critical').success).toBe(true);
    expect(PlanFindingSeveritySchema.safeParse('major').success).toBe(true);
    expect(PlanFindingSeveritySchema.safeParse('minor').success).toBe(true);
    expect(PlanFindingSeveritySchema.safeParse('suggestion').success).toBe(true);
  });

  it('rejects code-only severity nitpick', () => {
    expect(PlanFindingSeveritySchema.safeParse('nitpick').success).toBe(false);
  });

  it('rejects invalid severity', () => {
    expect(PlanFindingSeveritySchema.safeParse('info').success).toBe(false);
  });
});

describe('CodeFindingSeveritySchema', () => {
  it('accepts code-specific severities', () => {
    expect(CodeFindingSeveritySchema.safeParse('critical').success).toBe(true);
    expect(CodeFindingSeveritySchema.safeParse('major').success).toBe(true);
    expect(CodeFindingSeveritySchema.safeParse('minor').success).toBe(true);
    expect(CodeFindingSeveritySchema.safeParse('nitpick').success).toBe(true);
  });

  it('rejects plan-only severity suggestion', () => {
    expect(CodeFindingSeveritySchema.safeParse('suggestion').success).toBe(false);
  });
});

describe('FindingSeveritySchema', () => {
  it('accepts all severity values', () => {
    for (const val of ['critical', 'major', 'minor', 'suggestion', 'nitpick']) {
      expect(FindingSeveritySchema.safeParse(val).success).toBe(true);
    }
  });
});

describe('PlanFindingSchema', () => {
  const validPlanFinding = {
    severity: 'suggestion',
    category: 'architecture',
    description: 'Consider using a factory pattern here',
  };

  it('parses a valid plan finding', () => {
    const result = PlanFindingSchema.safeParse(validPlanFinding);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.severity).toBe('suggestion');
      expect(result.data.category).toBe('architecture');
    }
  });

  it('accepts optional fields', () => {
    const withOptionals = {
      ...validPlanFinding,
      file: 'src/index.ts',
      line: 42,
      suggestion: 'Use abstract factory',
    };
    const result = PlanFindingSchema.safeParse(withOptionals);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.file).toBe('src/index.ts');
      expect(result.data.line).toBe(42);
      expect(result.data.suggestion).toBe('Use abstract factory');
    }
  });

  it('allows omitting optional fields', () => {
    const result = PlanFindingSchema.safeParse(validPlanFinding);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.file).toBeUndefined();
      expect(result.data.line).toBeUndefined();
      expect(result.data.suggestion).toBeUndefined();
    }
  });

  it('rejects nitpick severity for plan findings', () => {
    const result = PlanFindingSchema.safeParse({ ...validPlanFinding, severity: 'nitpick' });
    expect(result.success).toBe(false);
  });
});

describe('CodeFindingSchema', () => {
  const validCodeFinding = {
    severity: 'nitpick',
    category: 'style',
    description: 'Prefer const over let',
  };

  it('parses a valid code finding', () => {
    const result = CodeFindingSchema.safeParse(validCodeFinding);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.severity).toBe('nitpick');
    }
  });

  it('rejects suggestion severity for code findings', () => {
    const result = CodeFindingSchema.safeParse({ ...validCodeFinding, severity: 'suggestion' });
    expect(result.success).toBe(false);
  });
});

describe('ReviewFindingSchema', () => {
  it('parses a valid finding with all fields', () => {
    const finding = {
      severity: 'critical',
      category: 'security',
      description: 'SQL injection vulnerability',
      file: 'src/db.ts',
      line: 15,
      suggestion: 'Use parameterized queries',
    };
    const result = ReviewFindingSchema.safeParse(finding);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(finding);
    }
  });

  it('fails when required fields are missing', () => {
    expect(ReviewFindingSchema.safeParse({}).success).toBe(false);
    expect(ReviewFindingSchema.safeParse({ severity: 'critical' }).success).toBe(false);
    expect(
      ReviewFindingSchema.safeParse({ severity: 'critical', category: 'bug' }).success,
    ).toBe(false);
  });

  it('fails with invalid severity', () => {
    const result = ReviewFindingSchema.safeParse({
      severity: 'info',
      category: 'test',
      description: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('accepts both suggestion and nitpick severities', () => {
    const base = { category: 'test', description: 'test' };
    expect(ReviewFindingSchema.safeParse({ ...base, severity: 'suggestion' }).success).toBe(true);
    expect(ReviewFindingSchema.safeParse({ ...base, severity: 'nitpick' }).success).toBe(true);
  });

  it('rejects negative line numbers', () => {
    const result = ReviewFindingSchema.safeParse({
      severity: 'minor',
      category: 'test',
      description: 'test',
      line: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer line numbers', () => {
    const result = ReviewFindingSchema.safeParse({
      severity: 'minor',
      category: 'test',
      description: 'test',
      line: 3.5,
    });
    expect(result.success).toBe(false);
  });
});

describe('PlanReviewResultSchema', () => {
  const validPlanResult = {
    verdict: 'approve',
    summary: 'Plan looks solid',
    findings: [
      { severity: 'minor', category: 'style', description: 'Consider renaming' },
    ],
    session_id: 'sess_abc123',
  };

  it('parses a valid plan review result', () => {
    const result = PlanReviewResultSchema.safeParse(validPlanResult);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verdict).toBe('approve');
      expect(result.data.findings).toHaveLength(1);
      expect(result.data.session_id).toBe('sess_abc123');
    }
  });

  it('accepts all valid plan verdicts', () => {
    for (const verdict of ['approve', 'revise', 'reject']) {
      const result = PlanReviewResultSchema.safeParse({ ...validPlanResult, verdict });
      expect(result.success).toBe(true);
    }
  });

  it('rejects code review verdict request_changes', () => {
    const result = PlanReviewResultSchema.safeParse({
      ...validPlanResult,
      verdict: 'request_changes',
    });
    expect(result.success).toBe(false);
  });

  it('accepts empty findings array', () => {
    const result = PlanReviewResultSchema.safeParse({ ...validPlanResult, findings: [] });
    expect(result.success).toBe(true);
  });
});

describe('CodeReviewResultSchema', () => {
  const validCodeResult = {
    verdict: 'request_changes',
    summary: 'Several issues found',
    findings: [
      { severity: 'critical', category: 'bug', description: 'Null pointer dereference' },
    ],
    session_id: 'sess_def456',
  };

  it('parses a valid code review result', () => {
    const result = CodeReviewResultSchema.safeParse(validCodeResult);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verdict).toBe('request_changes');
      expect(result.data.findings).toHaveLength(1);
    }
  });

  it('accepts all valid code verdicts', () => {
    for (const verdict of ['approve', 'request_changes', 'reject']) {
      const result = CodeReviewResultSchema.safeParse({ ...validCodeResult, verdict });
      expect(result.success).toBe(true);
    }
  });

  it('rejects plan verdict revise', () => {
    const result = CodeReviewResultSchema.safeParse({ ...validCodeResult, verdict: 'revise' });
    expect(result.success).toBe(false);
  });
});

describe('PrecommitResultSchema', () => {
  const validPrecommit = {
    ready_to_commit: false,
    blockers: ['Missing test coverage'],
    warnings: ['Large diff'],
    session_id: 'sess_ghi789',
  };

  it('parses a valid precommit result', () => {
    const result = PrecommitResultSchema.safeParse(validPrecommit);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ready_to_commit).toBe(false);
      expect(result.data.blockers).toEqual(['Missing test coverage']);
    }
  });

  it('accepts empty arrays', () => {
    const result = PrecommitResultSchema.safeParse({
      ready_to_commit: true,
      blockers: [],
      warnings: [],
      session_id: 'sess_empty',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(PrecommitResultSchema.safeParse({}).success).toBe(false);
    expect(
      PrecommitResultSchema.safeParse({ ready_to_commit: true }).success,
    ).toBe(false);
  });
});

describe('ReviewStatusSchema', () => {
  it('parses a valid status', () => {
    const result = ReviewStatusSchema.safeParse({
      status: 'in_progress',
      session_id: 'thread_1',
      progress: 'Reviewing file 2 of 5',
      elapsed_seconds: 12.5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('in_progress');
      expect(result.data.progress).toBe('Reviewing file 2 of 5');
    }
  });

  it('allows omitting optional fields', () => {
    const result = ReviewStatusSchema.safeParse({
      status: 'completed',
      session_id: 'thread_1',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.progress).toBeUndefined();
      expect(result.data.elapsed_seconds).toBeUndefined();
    }
  });

  it('accepts all valid statuses', () => {
    for (const status of ['in_progress', 'completed', 'failed', 'not_found']) {
      const result = ReviewStatusSchema.safeParse({ status, session_id: 'thread_1' });
      expect(result.success).toBe(true);
    }
  });
});

describe('ReviewHistoryEntrySchema', () => {
  const validEntry = {
    session_id: 'sess_history1',
    type: 'plan',
    verdict: 'approve',
    timestamp: '2026-02-18T10:00:00Z',
    summary: 'Plan approved',
  };

  it('parses a valid history entry', () => {
    const result = ReviewHistoryEntrySchema.safeParse(validEntry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.session_id).toBe('sess_history1');
      expect(result.data.type).toBe('plan');
    }
  });

  it('accepts all valid types', () => {
    for (const type of ['plan', 'code', 'precommit']) {
      const result = ReviewHistoryEntrySchema.safeParse({ ...validEntry, type });
      expect(result.success).toBe(true);
    }
  });

  it('accepts all valid verdict strings from plan and code reviews', () => {
    for (const verdict of ['approve', 'revise', 'reject', 'request_changes']) {
      const result = ReviewHistoryEntrySchema.safeParse({ ...validEntry, verdict });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid verdict', () => {
    const result = ReviewHistoryEntrySchema.safeParse({ ...validEntry, verdict: 'maybe' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid type', () => {
    const result = ReviewHistoryEntrySchema.safeParse({ ...validEntry, type: 'integration' });
    expect(result.success).toBe(false);
  });
});
