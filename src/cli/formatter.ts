import pc from 'picocolors';
import type { PlanReviewResult, CodeReviewResult, PrecommitResult, PlanFinding, CodeFinding } from '../codex/types.js';

export function detectColor(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  if (env.FORCE_COLOR !== undefined) {
    return env.FORCE_COLOR !== '0';
  }
  if (env.NO_COLOR !== undefined) {
    return false;
  }
  return isTTY;
}

type SeverityLevel = 'critical' | 'major' | 'minor' | 'suggestion' | 'nitpick';

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  suggestion: 3,
  nitpick: 3,
};

function severityBadge(severity: SeverityLevel, color: boolean): string {
  const tag = `[${severity.toUpperCase()}]`;
  if (!color) return tag;
  switch (severity) {
    case 'critical':
      return pc.red(pc.bold(tag));
    case 'major':
      return pc.red(tag);
    case 'minor':
      return pc.yellow(tag);
    case 'suggestion':
    case 'nitpick':
      return pc.dim(tag);
  }
}

function verdictBadge(verdict: string, color: boolean): string {
  if (!color) return verdict.replaceAll('_', ' ').toUpperCase();
  switch (verdict) {
    case 'approve':
      return pc.green(pc.bold('APPROVE'));
    case 'revise':
      return pc.yellow(pc.bold('REVISE'));
    case 'reject':
      return pc.red(pc.bold('REJECT'));
    case 'request_changes':
      return pc.yellow(pc.bold('REQUEST CHANGES'));
    default:
      return verdict.replaceAll('_', ' ').toUpperCase();
  }
}

function locationStr(file: string | null, line: number | null): string {
  if (!file) return '';
  return line ? ` ${file}:${line}` : ` ${file}`;
}

function formatFindings(findings: ReadonlyArray<PlanFinding | CodeFinding>, color: boolean): string {
  if (findings.length === 0) return '  No findings.\n';

  const sorted = [...findings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99),
  );

  const lines: string[] = [];
  for (const f of sorted) {
    const badge = severityBadge(f.severity, color);
    const loc = locationStr(f.file, f.line);
    lines.push(`  ${badge}${loc} — ${f.description}`);
    if (f.suggestion) {
      const prefix = color ? pc.dim('    ↳ ') : '    -> ';
      lines.push(`${prefix}${f.suggestion}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function formatPlanResult(result: PlanReviewResult, color: boolean): string {
  const lines: string[] = [];
  lines.push(`Verdict: ${verdictBadge(result.verdict, color)}`);
  lines.push('');
  lines.push(result.summary);
  lines.push('');
  lines.push(`Findings (${result.findings.length}):`);
  lines.push(formatFindings(result.findings, color));
  lines.push(`Session: ${result.session_id}`);
  return lines.join('\n');
}

export function formatCodeResult(result: CodeReviewResult, color: boolean): string {
  const lines: string[] = [];
  lines.push(`Verdict: ${verdictBadge(result.verdict, color)}`);
  lines.push('');
  lines.push(result.summary);
  lines.push('');
  lines.push(`Findings (${result.findings.length}):`);
  lines.push(formatFindings(result.findings, color));
  lines.push(`Session: ${result.session_id}`);
  return lines.join('\n');
}

export function formatPrecommitResult(result: PrecommitResult, color: boolean): string {
  const lines: string[] = [];

  if (result.ready_to_commit) {
    const badge = color ? pc.green(pc.bold('OK TO COMMIT')) : 'OK TO COMMIT';
    lines.push(badge);
  } else {
    const badge = color ? pc.red(pc.bold('COMMIT BLOCKED')) : 'COMMIT BLOCKED';
    lines.push(badge);
  }

  if (result.blockers.length > 0) {
    lines.push('');
    lines.push('Blockers:');
    for (const b of result.blockers) {
      const bullet = color ? pc.red('  - ') : '  - ';
      lines.push(`${bullet}${b}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of result.warnings) {
      const bullet = color ? pc.yellow('  - ') : '  - ';
      lines.push(`${bullet}${w}`);
    }
  }

  lines.push('');
  lines.push(`Session: ${result.session_id}`);
  return lines.join('\n');
}
