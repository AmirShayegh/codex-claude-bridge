export function buildPlanReviewPrompt(params: {
  plan: string;
  context?: string;
  focus?: string[];
  depth?: 'quick' | 'thorough';
}): string {
  const sections: string[] = [
    'You are a code review expert. Review the following implementation plan.',
  ];

  if (params.context) {
    sections.push(`Project context: ${params.context}`);
  }

  if (params.focus && params.focus.length > 0) {
    sections.push(`Focus areas: ${params.focus.join(', ')}`);
  }

  if (params.depth) {
    sections.push(`Review depth: ${params.depth}`);
  }

  sections.push(`\n<<<PLAN>>>\n${params.plan}\n<<<END_PLAN>>>`);

  sections.push(
    '\nRespond with JSON containing:' +
      '\n- "verdict": "approve", "revise", or "reject"' +
      '\n- "summary": a brief summary of your review' +
      '\n- "findings": an array of objects, each with "severity" (critical/major/minor/suggestion), "category", "description", and optionally "file", "line", "suggestion"',
  );

  return sections.join('\n\n');
}

export function buildCodeReviewPrompt(params: {
  diff: string;
  context?: string;
  criteria?: string[];
}): string {
  const sections: string[] = [
    'You are a code review expert. Review the following code changes.',
  ];

  if (params.context) {
    sections.push(`Context: ${params.context}`);
  }

  if (params.criteria && params.criteria.length > 0) {
    sections.push(`Review criteria: ${params.criteria.join(', ')}`);
  }

  sections.push(`\n<<<DIFF>>>\n${params.diff}\n<<<END_DIFF>>>`);

  sections.push(
    '\nRespond with JSON containing:' +
      '\n- "verdict": "approve", "request_changes", or "reject"' +
      '\n- "summary": a brief summary of your review' +
      '\n- "findings": an array of objects, each with "severity" (critical/major/minor/nitpick), "category", "description", and optionally "file", "line", "suggestion"',
  );

  return sections.join('\n\n');
}

export function buildPrecommitPrompt(params: {
  diff: string;
  checklist?: string[];
}): string {
  const sections: string[] = [
    'You are a pre-commit reviewer. Check the following staged changes for issues that should block a commit.',
  ];

  if (params.checklist && params.checklist.length > 0) {
    sections.push(`Checklist:\n${params.checklist.map((item) => `- ${item}`).join('\n')}`);
  }

  sections.push(`\n<<<DIFF>>>\n${params.diff}\n<<<END_DIFF>>>`);

  sections.push(
    '\nRespond with JSON containing:' +
      '\n- "ready_to_commit": boolean indicating if changes are safe to commit' +
      '\n- "blockers": array of strings describing issues that must be fixed' +
      '\n- "warnings": array of strings describing non-blocking concerns',
  );

  return sections.join('\n\n');
}
