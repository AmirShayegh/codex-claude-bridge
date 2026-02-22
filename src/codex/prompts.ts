import { randomBytes } from 'node:crypto';

function makeDelimiter(tag: string, content: string): { open: string; close: string } {
  let open = `<<<${tag}>>>`;
  let close = `<<<END_${tag}>>>`;
  while (content.includes(open) || content.includes(close)) {
    const suffix = randomBytes(4).toString('hex');
    open = `<<<${tag}_${suffix}>>>`;
    close = `<<<END_${tag}_${suffix}>>>`;
  }
  return { open, close };
}

// --- Shared prompt fragments ---

const PLAN_SEVERITY_RUBRIC =
  'Severity definitions (use exactly these values):\n' +
  '- critical: Will cause bugs, data loss, security vulnerabilities, or crashes in production\n' +
  '- major: Significant issues that should be fixed before merge — incorrect logic, missing error handling, performance problems\n' +
  '- minor: Improvements worth making but not blocking — naming, minor refactors, test gaps\n' +
  '- suggestion: Style preferences, optional improvements';

const CODE_SEVERITY_RUBRIC =
  'Severity definitions (use exactly these values):\n' +
  '- critical: Will cause bugs, data loss, security vulnerabilities, or crashes in production\n' +
  '- major: Significant issues that should be fixed before merge — incorrect logic, missing error handling, performance problems\n' +
  '- minor: Improvements worth making but not blocking — naming, minor refactors, test gaps\n' +
  '- nitpick: Style preferences, optional improvements';

const BASE_OUTPUT_RULES =
  'Output rules:\n' +
  '- Respond ONLY with valid JSON — no markdown fencing, no explanation outside the JSON object\n' +
  '- Summary must be 1-2 sentences max\n' +
  '- If nothing is wrong, return an empty findings array — do not invent issues\n' +
  '- Do not pad with praise — be direct\n' +
  '- Suggestions must be concrete — show the fix, not "consider improving"';

const CODE_OUTPUT_RULES =
  BASE_OUTPUT_RULES +
  '\n- Every finding MUST include "file" and "line" referencing the diff' +
  '\n- Do not comment on unchanged code — only review what was added or modified';

const PRECOMMIT_OUTPUT_RULES =
  'Output rules:\n' +
  '- Respond ONLY with valid JSON — no markdown fencing, no explanation outside the JSON object\n' +
  '- If nothing is wrong, return empty arrays for both blockers and warnings\n' +
  '- Be specific — name the file and describe the exact issue\n' +
  '- Do not invent issues — only flag real problems in the diff';

// --- Config interfaces ---

export interface PlanReviewConfig {
  project_context: string;
  focus: string[];
  depth: 'quick' | 'thorough';
}

export interface CodeReviewConfig {
  project_context: string;
  criteria: string[];
  require_tests: boolean;
}

export interface PrecommitConfig {
  project_context: string;
  block_on: string[];
}

// --- Prompt builders ---

export function buildPlanReviewPrompt(
  input: {
    plan: string;
    context?: string;
    focus?: string[];
    depth?: 'quick' | 'thorough';
  },
  config?: PlanReviewConfig,
): string {
  const sections: string[] = [
    'You are a senior software architect reviewing an implementation plan. Your job is to identify flaws, risks, and gaps before any code is written.',
  ];

  if (config?.project_context) {
    sections.push(`Project background: ${config.project_context}`);
  }

  if (input.context) {
    sections.push(`Additional context: ${input.context}`);
  }

  // Focus: user input overrides config entirely
  const focus = input.focus && input.focus.length > 0 ? input.focus : config?.focus;
  if (focus && focus.length > 0) {
    sections.push(`Focus your review on: ${focus.join(', ')}`);
  }

  // Depth: user input overrides config
  const depth = input.depth ?? config?.depth;
  if (depth === 'quick') {
    sections.push('Review depth: quick scan — focus on critical and major issues only.');
  } else if (depth === 'thorough') {
    sections.push('Review depth: thorough — examine all aspects in detail.');
  }

  sections.push(PLAN_SEVERITY_RUBRIC);

  sections.push(
    'Review checklist:\n' +
      '- Feasibility: Can this plan actually be implemented as described?\n' +
      '- Edge cases: Are there missing edge cases or error scenarios?\n' +
      '- Scalability: Will this approach scale with usage?\n' +
      '- Dependencies: Are there risky or missing dependency assumptions?\n' +
      '- Security: Are there security implications not addressed?\n' +
      '- Overengineering: Is any part unnecessarily complex for the stated goal?',
  );

  const d = makeDelimiter('PLAN', input.plan);
  sections.push(`${d.open}\n${input.plan}\n${d.close}`);

  sections.push(
    'Respond with a JSON object:\n' +
      '{\n' +
      '  "verdict": "approve" | "revise" | "reject",\n' +
      '  "summary": "string",\n' +
      '  "findings": [{\n' +
      '    "severity": "critical" | "major" | "minor" | "suggestion",\n' +
      '    "category": "string",\n' +
      '    "description": "string",\n' +
      '    "file": "string or null",\n' +
      '    "line": "number or null",\n' +
      '    "suggestion": "string or null"\n' +
      '  }]\n' +
      '}\n\n' +
      BASE_OUTPUT_RULES,
  );

  return sections.join('\n\n');
}

export function buildCodeReviewPrompt(
  input: {
    diff: string;
    context?: string;
    criteria?: string[];
    chunkHeader?: string;
  },
  config?: CodeReviewConfig,
): string {
  const sections: string[] = [
    'You are a senior software engineer performing a code review. Your job is to identify bugs, security issues, and quality problems in the changes.',
  ];

  if (config?.project_context) {
    sections.push(`Project background: ${config.project_context}`);
  }

  if (input.context) {
    sections.push(`Change context: ${input.context}`);
  }

  // Criteria: user input overrides config entirely
  const criteria = input.criteria && input.criteria.length > 0 ? input.criteria : config?.criteria;
  if (criteria && criteria.length > 0) {
    sections.push(`Review criteria: ${criteria.join(', ')}`);
  }

  sections.push(CODE_SEVERITY_RUBRIC);

  // The checklist is always included as a safety net, even when criteria narrows the
  // review focus. criteria tells the model what to prioritize; the checklist ensures
  // critical issues (e.g. injection vulnerabilities) aren't missed just because the
  // user asked for a "performance" review.
  const requireTests = config?.require_tests ?? false;
  let checklist =
    'Review checklist:\n' +
    '- Null safety: Potential null/undefined access errors?\n' +
    '- Error handling: Are errors caught and handled appropriately?\n' +
    '- Injection vulnerabilities: SQL injection, XSS, command injection, path traversal?\n' +
    '- Race conditions: Concurrent access issues?\n' +
    '- Edge cases: Missing boundary checks, empty inputs, overflow?\n' +
    '- API contracts: Do function signatures and return types match usage?';
  if (requireTests) {
    checklist += '\n- Test coverage: Are new code paths tested?';
  }
  sections.push(checklist);

  if (input.chunkHeader) {
    sections.push(input.chunkHeader);
  }

  const d = makeDelimiter('DIFF', input.diff);
  sections.push(`${d.open}\n${input.diff}\n${d.close}`);

  sections.push(
    'Respond with a JSON object:\n' +
      '{\n' +
      '  "verdict": "approve" | "request_changes" | "reject",\n' +
      '  "summary": "string",\n' +
      '  "findings": [{\n' +
      '    "severity": "critical" | "major" | "minor" | "nitpick",\n' +
      '    "category": "string",\n' +
      '    "description": "string",\n' +
      '    "file": "string or null",\n' +
      '    "line": "number or null",\n' +
      '    "suggestion": "string or null"\n' +
      '  }]\n' +
      '}\n\n' +
      CODE_OUTPUT_RULES,
  );

  return sections.join('\n\n');
}

export function buildPrecommitPrompt(
  input: {
    diff: string;
    checklist?: string[];
    chunkHeader?: string;
  },
  config?: PrecommitConfig,
): string {
  const sections: string[] = [
    'You are performing a final pre-commit check on staged changes. Your job is to catch obvious problems that should not be committed.',
  ];

  if (config?.project_context) {
    sections.push(`Project background: ${config.project_context}`);
  }

  if (input.checklist && input.checklist.length > 0) {
    sections.push(`Custom checks:\n${input.checklist.map((item) => `- ${item}`).join('\n')}`);
  }

  sections.push(
    'Pre-commit checklist:\n' +
      '- Debug code: console.log, debugger statements, TODO/FIXME left behind\n' +
      '- Hardcoded secrets: API keys, passwords, tokens in source code\n' +
      '- Broken imports: Missing or incorrect import paths\n' +
      '- Syntax errors: Obvious syntax problems\n' +
      '- Committed secrets: .env files, credential files that should not be tracked',
  );

  const blockOn = config?.block_on;
  if (blockOn && blockOn.length > 0) {
    sections.push(
      `Severity threshold: Issues that would be ${blockOn.join(' or ')} severity belong in "blockers". Lesser issues belong in "warnings".`,
    );
  }

  if (input.chunkHeader) {
    sections.push(input.chunkHeader);
  }

  const d = makeDelimiter('DIFF', input.diff);
  sections.push(`${d.open}\n${input.diff}\n${d.close}`);

  sections.push(
    'Respond with a JSON object:\n' +
      '{\n' +
      '  "ready_to_commit": true | false,\n' +
      '  "blockers": ["string — issues that must be fixed before committing"],\n' +
      '  "warnings": ["string — non-blocking concerns"]\n' +
      '}\n\n' +
      PRECOMMIT_OUTPUT_RULES,
  );

  return sections.join('\n\n');
}
