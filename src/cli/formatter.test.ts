import { describe, it, expect } from 'vitest';
import {
  formatPlanResult,
  formatCodeResult,
  formatPrecommitResult,
  detectColor,
} from './formatter.js';
import type { PlanReviewResult, CodeReviewResult, PrecommitResult } from '../review/types.js';

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
      {
        severity: 'minor',
        category: 'style',
        description: 'Use consistent naming',
        file: 'src/foo.ts',
        line: 10,
        suggestion: 'Rename to camelCase',
      },
      {
        severity: 'critical',
        category: 'security',
        description: 'SQL injection risk',
        file: 'src/db.ts',
        line: 42,
        suggestion: null,
      },
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
    const empty: PlanReviewResult = {
      verdict: 'approve',
      summary: 'All good.',
      findings: [],
      session_id: 's',
    };
    const out = formatPlanResult(empty, false);
    expect(out).toContain('No findings');
    expect(out).toContain('APPROVE');
  });

  it('shows file without line when line is null', () => {
    const r: PlanReviewResult = {
      verdict: 'approve',
      summary: 'ok',
      findings: [
        {
          severity: 'suggestion',
          category: 'docs',
          description: 'Add readme',
          file: 'README.md',
          line: null,
          suggestion: null,
        },
      ],
      session_id: 's',
    };
    const out = formatPlanResult(r, false);
    expect(out).toContain('README.md');
    expect(out).not.toContain('README.md:');
  });

  it('prints one honest model line per review and adjudication contribution', () => {
    const withMetadata: PlanReviewResult = {
      ...result,
      models: [
        {
          provider: 'codex',
          role: 'review',
          requested: null,
          resolved: 'gpt-5.6-sol',
          observed: 'gpt-5.6-sol',
          evidence: 'runtime_session_record',
        },
        {
          provider: 'gemini',
          role: 'adjudication',
          requested: 'latest',
          resolved: 'Gemini 3.5 Flash (High)',
          observed: null,
          evidence: 'bridge_selection',
        },
      ],
      provenance: { persistence: 'memory_only', warning: 'History was not saved.' },
    };

    const modelLines = formatPlanResult(withMetadata, false)
      .split('\n')
      .filter((line) => line.startsWith('Model:'));
    expect(modelLines).toEqual([
      'Model: role=review provider=codex requested=null resolved=gpt-5.6-sol observed=gpt-5.6-sol evidence=runtime_session_record',
      'Model: role=adjudication provider=gemini requested=latest resolved=Gemini 3.5 Flash (High) observed=null evidence=bridge_selection',
    ]);
  });

  it('prints a persistence warning only when provenance.warning is non-null', () => {
    const warning = formatPlanResult(
      {
        ...result,
        provenance: { persistence: 'memory_only', warning: 'History was not saved.' },
      },
      false,
    );
    const durable = formatPlanResult(
      {
        ...result,
        provenance: { persistence: 'durable', warning: null },
      },
      false,
    );
    const absent = formatPlanResult(result, false);

    expect(warning).toContain('Persistence warning: History was not saved.');
    expect(durable).not.toContain('Persistence warning:');
    expect(absent).not.toContain('Persistence warning:');
  });

  it('prints unavailable requested, resolved, and observed identities as null', () => {
    const out = formatPlanResult(
      {
        ...result,
        models: [
          {
            provider: 'codex',
            role: 'review',
            requested: null,
            resolved: null,
            observed: null,
            evidence: 'unavailable',
          },
        ],
      },
      false,
    );
    expect(out).toContain(
      'Model: role=review provider=codex requested=null resolved=null observed=null evidence=unavailable',
    );
  });

  it('escapes untrusted controls in every dynamic human field', () => {
    const escape = String.fromCharCode(0x1b);
    const c1 = String.fromCharCode(0x85);
    const unsafe: PlanReviewResult = {
      verdict: 'approve',
      summary: 'summary\nforged',
      findings: [
        {
          severity: 'minor',
          category: 'style',
          description: `description${escape}forged`,
          file: 'src/file\rname.ts',
          line: 1,
          suggestion: `suggestion${c1}forged`,
        },
      ],
      session_id: 'session\nforged',
      models: [
        {
          provider: 'codex',
          role: 'review',
          requested: null,
          resolved: `model${escape}forged`,
          observed: null,
          evidence: 'unavailable',
        },
      ],
      provenance: { persistence: 'memory_only', warning: 'db\nforged' },
    };

    const out = formatPlanResult(unsafe, false);
    expect(out).toContain('summary\\nforged');
    expect(out).toContain('src/file\\rname.ts:1');
    expect(out).toContain('description\\x1Bforged');
    expect(out).toContain('suggestion\\x85forged');
    expect(out).toContain('resolved=model\\x1Bforged');
    expect(out).toContain('Persistence warning: db\\nforged');
    expect(out).toContain('Session: session\\nforged');
    expect(out).not.toContain(escape);
    expect(out).not.toContain(c1);
  });
});

describe('formatCodeResult', () => {
  const result: CodeReviewResult = {
    verdict: 'request_changes',
    summary: 'Found bugs.',
    findings: [
      {
        severity: 'major',
        category: 'bugs',
        description: 'Off by one',
        file: 'src/loop.ts',
        line: 5,
        suggestion: 'Use < instead of <=',
      },
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
      findings: [
        {
          severity: 'nitpick',
          category: 'style',
          description: 'Trailing space',
          file: null,
          line: null,
          suggestion: null,
        },
      ],
      session_id: 's',
    };
    const out = formatCodeResult(r, false);
    expect(out).toContain('[NITPICK]');
  });

  it('prints model metadata for code reviews', () => {
    const out = formatCodeResult(
      {
        ...result,
        models: [
          {
            provider: 'gemini',
            role: 'review',
            requested: null,
            resolved: 'Gemini 3.5 Flash (High)',
            observed: null,
            evidence: 'bridge_selection',
          },
        ],
      },
      false,
    );
    expect(out).toContain(
      'Model: role=review provider=gemini requested=null resolved=Gemini 3.5 Flash (High) observed=null evidence=bridge_selection',
    );
  });
});

describe('formatPrecommitResult', () => {
  it('shows OK TO COMMIT when ready', () => {
    const result: PrecommitResult = {
      ready_to_commit: true,
      blockers: [],
      warnings: [],
      session_id: 's1',
    };
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

  it('prints model metadata and escapes blocker/warning controls', () => {
    const escape = String.fromCharCode(0x1b);
    const result: PrecommitResult = {
      ready_to_commit: false,
      blockers: ['blocker\nforged'],
      warnings: [`warning${escape}forged`],
      session_id: 's5',
      models: [
        {
          provider: 'codex',
          role: 'review',
          requested: null,
          resolved: 'gpt-5.6-sol',
          observed: 'gpt-5.6-sol',
          evidence: 'runtime_session_record',
        },
      ],
    };
    const out = formatPrecommitResult(result, false);
    expect(out).toContain('blocker\\nforged');
    expect(out).toContain('warning\\x1Bforged');
    expect(out).toContain('Model: role=review provider=codex');
    expect(out).not.toContain(escape);
  });
});
