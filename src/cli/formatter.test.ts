import { describe, it, expect } from 'vitest';
import {
  formatPlanResult,
  formatCodeResult,
  formatPrecommitResult,
  detectColor,
} from './formatter.js';
import type { PlanReviewResult, CodeReviewResult, PrecommitResult } from '../codex/types.js';

describe('detectColor', () => {
  it('returns true when FORCE_COLOR is set to non-zero', () => {
    expect(detectColor({ FORCE_COLOR: '1' }, false)).toBe(true);
  });

  it('returns false when FORCE_COLOR is "0"', () => {
    expect(detectColor({ FORCE_COLOR: '0' }, true)).toBe(false);
  });

  it('returns false when NO_COLOR is set', () => {
    expect(detectColor({ NO_COLOR: '' }, true)).toBe(false);
  });

  it('FORCE_COLOR takes precedence over NO_COLOR', () => {
    expect(detectColor({ FORCE_COLOR: '1', NO_COLOR: '' }, false)).toBe(true);
  });

  it('returns true when isTTY is true and no env overrides', () => {
    expect(detectColor({}, true)).toBe(true);
  });

  it('returns false when isTTY is false and no env overrides', () => {
    expect(detectColor({}, false)).toBe(false);
  });
});

describe('formatPlanResult', () => {
  const result: PlanReviewResult = {
    verdict: 'revise',
    summary: 'Needs some changes.',
    findings: [
      { severity: 'minor', category: 'style', description: 'Use consistent naming', file: 'src/foo.ts', line: 10, suggestion: 'Rename to camelCase' },
      { severity: 'critical', category: 'security', description: 'SQL injection risk', file: 'src/db.ts', line: 42, suggestion: null },
    ],
    session_id: 'sess-123',
  };

  it('includes verdict, summary, findings, and session', () => {
    const out = formatPlanResult(result, false);
    expect(out).toContain('REVISE');
    expect(out).toContain('Needs some changes.');
    expect(out).toContain('[CRITICAL]');
    expect(out).toContain('[MINOR]');
    expect(out).toContain('src/db.ts:42');
    expect(out).toContain('SQL injection risk');
    expect(out).toContain('-> Rename to camelCase');
    expect(out).toContain('sess-123');
  });

  it('sorts findings by severity (critical first)', () => {
    const out = formatPlanResult(result, false);
    const critIdx = out.indexOf('[CRITICAL]');
    const minorIdx = out.indexOf('[MINOR]');
    expect(critIdx).toBeLessThan(minorIdx);
  });

  it('handles empty findings', () => {
    const empty: PlanReviewResult = { verdict: 'approve', summary: 'All good.', findings: [], session_id: 's' };
    const out = formatPlanResult(empty, false);
    expect(out).toContain('No findings');
    expect(out).toContain('APPROVE');
  });

  it('shows file without line when line is null', () => {
    const r: PlanReviewResult = {
      verdict: 'approve',
      summary: 'ok',
      findings: [{ severity: 'suggestion', category: 'docs', description: 'Add readme', file: 'README.md', line: null, suggestion: null }],
      session_id: 's',
    };
    const out = formatPlanResult(r, false);
    expect(out).toContain('README.md');
    expect(out).not.toContain('README.md:');
  });
});

describe('formatCodeResult', () => {
  const result: CodeReviewResult = {
    verdict: 'request_changes',
    summary: 'Found bugs.',
    findings: [
      { severity: 'major', category: 'bugs', description: 'Off by one', file: 'src/loop.ts', line: 5, suggestion: 'Use < instead of <=' },
    ],
    session_id: 'sess-456',
  };

  it('includes verdict and findings', () => {
    const out = formatCodeResult(result, false);
    expect(out).toContain('REQUEST CHANGES');
    expect(out).toContain('[MAJOR]');
    expect(out).toContain('src/loop.ts:5');
    expect(out).toContain('Off by one');
  });

  it('shows nitpick severity', () => {
    const r: CodeReviewResult = {
      verdict: 'approve',
      summary: 'ok',
      findings: [{ severity: 'nitpick', category: 'style', description: 'Trailing space', file: null, line: null, suggestion: null }],
      session_id: 's',
    };
    const out = formatCodeResult(r, false);
    expect(out).toContain('[NITPICK]');
  });
});

describe('formatPrecommitResult', () => {
  it('shows OK TO COMMIT when ready', () => {
    const result: PrecommitResult = { ready_to_commit: true, blockers: [], warnings: [], session_id: 's1' };
    const out = formatPrecommitResult(result, false);
    expect(out).toContain('OK TO COMMIT');
    expect(out).not.toContain('COMMIT BLOCKED');
  });

  it('shows COMMIT BLOCKED with blockers', () => {
    const result: PrecommitResult = {
      ready_to_commit: false,
      blockers: ['Missing error handling', 'Security vulnerability'],
      warnings: ['Consider adding tests'],
      session_id: 's2',
    };
    const out = formatPrecommitResult(result, false);
    expect(out).toContain('COMMIT BLOCKED');
    expect(out).toContain('Missing error handling');
    expect(out).toContain('Security vulnerability');
    expect(out).toContain('Consider adding tests');
  });

  it('omits blockers section when empty', () => {
    const result: PrecommitResult = {
      ready_to_commit: true,
      blockers: [],
      warnings: ['Minor style issue'],
      session_id: 's3',
    };
    const out = formatPrecommitResult(result, false);
    expect(out).not.toContain('Blockers:');
    expect(out).toContain('Warnings:');
  });

  it('omits warnings section when empty', () => {
    const result: PrecommitResult = {
      ready_to_commit: false,
      blockers: ['Critical bug'],
      warnings: [],
      session_id: 's4',
    };
    const out = formatPrecommitResult(result, false);
    expect(out).toContain('Blockers:');
    expect(out).not.toContain('Warnings:');
  });
});
