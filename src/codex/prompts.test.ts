import { describe, it, expect } from 'vitest';
import {
  buildPlanReviewPrompt,
  buildCodeReviewPrompt,
  buildPrecommitPrompt,
} from './prompts.js';

describe('buildPlanReviewPrompt', () => {
  const plan = '## Step 1\nCreate user auth module\n## Step 2\nAdd JWT tokens';

  it('includes the plan text in output with delimiters', () => {
    const result = buildPlanReviewPrompt({ plan });
    expect(result).toContain(plan);
    expect(result).toContain('<<<PLAN>>>');
    expect(result).toContain('<<<END_PLAN>>>');
  });

  it('includes context when provided', () => {
    const result = buildPlanReviewPrompt({ plan, context: 'Healthcare SaaS app' });
    expect(result).toContain('Healthcare SaaS app');
  });

  it('includes focus areas when provided', () => {
    const result = buildPlanReviewPrompt({ plan, focus: ['security', 'performance'] });
    expect(result).toContain('security');
    expect(result).toContain('performance');
  });

  it('includes depth instruction when provided', () => {
    const quick = buildPlanReviewPrompt({ plan, depth: 'quick' });
    expect(quick).toContain('quick');

    const thorough = buildPlanReviewPrompt({ plan, depth: 'thorough' });
    expect(thorough).toContain('thorough');
  });

  it('includes JSON output instruction with schema fields but not session_id', () => {
    const result = buildPlanReviewPrompt({ plan });
    expect(result).toContain('verdict');
    expect(result).toContain('summary');
    expect(result).toContain('findings');
    expect(result).not.toContain('session_id');
  });

  it('works with only the required plan param', () => {
    const result = buildPlanReviewPrompt({ plan });
    expect(result).toContain(plan);
    expect(result.length).toBeGreaterThan(plan.length);
  });
});

describe('buildCodeReviewPrompt', () => {
  const diff = '--- a/src/db.ts\n+++ b/src/db.ts\n@@ -1,3 +1,5 @@\n+import { sanitize } from "./utils";\n const query = `SELECT * FROM users`;';

  it('includes the diff in output with delimiters', () => {
    const result = buildCodeReviewPrompt({ diff });
    expect(result).toContain(diff);
    expect(result).toContain('<<<DIFF>>>');
    expect(result).toContain('<<<END_DIFF>>>');
  });

  it('includes context when provided', () => {
    const result = buildCodeReviewPrompt({ diff, context: 'Adding input sanitization' });
    expect(result).toContain('Adding input sanitization');
  });

  it('includes criteria when provided', () => {
    const result = buildCodeReviewPrompt({ diff, criteria: ['bugs', 'security'] });
    expect(result).toContain('bugs');
    expect(result).toContain('security');
  });

  it('includes JSON output instruction with schema fields but not session_id', () => {
    const result = buildCodeReviewPrompt({ diff });
    expect(result).toContain('verdict');
    expect(result).toContain('summary');
    expect(result).toContain('findings');
    expect(result).not.toContain('session_id');
  });

  it('works with only the required diff param', () => {
    const result = buildCodeReviewPrompt({ diff });
    expect(result).toContain(diff);
    expect(result.length).toBeGreaterThan(diff.length);
  });
});

describe('buildPrecommitPrompt', () => {
  const diff = '--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1,2 @@\n+console.log("debug");\n export default app;';

  it('includes the diff in output with delimiters', () => {
    const result = buildPrecommitPrompt({ diff });
    expect(result).toContain(diff);
    expect(result).toContain('<<<DIFF>>>');
    expect(result).toContain('<<<END_DIFF>>>');
  });

  it('includes checklist items when provided', () => {
    const result = buildPrecommitPrompt({
      diff,
      checklist: ['No console.log statements', 'Tests pass'],
    });
    expect(result).toContain('No console.log statements');
    expect(result).toContain('Tests pass');
  });

  it('includes JSON output instruction with schema fields but not session_id', () => {
    const result = buildPrecommitPrompt({ diff });
    expect(result).toContain('ready_to_commit');
    expect(result).toContain('blockers');
    expect(result).toContain('warnings');
    expect(result).not.toContain('session_id');
  });

  it('works with only the required diff param', () => {
    const result = buildPrecommitPrompt({ diff });
    expect(result).toContain(diff);
    expect(result.length).toBeGreaterThan(diff.length);
  });
});
