import { estimateTokens } from '../utils/chunking.js';
import { CodeFindingSeveritySchema } from '../codex/types.js';
import type {
  CodeFinding,
  CodeFindingSeverity,
  CodeReviewResult,
  PrecommitResult,
} from '../codex/types.js';

// Provider-agnostic review orchestration shared by every backend. Extracted from
// codex/client.ts in T-013; these helpers carry no SDK/provider assumptions. The
// per-turn model call, error classification, and session model stay in each backend.

export function looksLikeDiff(text: string): boolean {
  const hasDiffGit = /^diff --git /m.test(text);
  const hasHunks = /^@@ /m.test(text);
  const hasFileHeaders = /^--- [ab]\//m.test(text) && /^\+\+\+ [ab]\//m.test(text);
  // Require at least two structural markers to reduce false positives
  return (hasDiffGit && (hasHunks || hasFileHeaders)) || (hasFileHeaders && hasHunks);
}

// Fixed overhead for prompt framing (role, rubric, schema, chunk header)
export const PROMPT_OVERHEAD_TOKENS = 2000;

export function computeVariableOverhead(parts: string[]): number {
  let total = 0;
  for (const part of parts) {
    if (part) total += estimateTokens(part);
  }
  return total;
}

// Higher rank = more severe. Options are ['critical','major','minor','nitpick'] so reverse index.
const severityRank: Record<CodeFindingSeverity, number> = Object.fromEntries(
  CodeFindingSeveritySchema.options.map((s, i, arr) => [s, arr.length - 1 - i]),
) as Record<CodeFindingSeverity, number>;

export function deduplicateFindings(findings: CodeFinding[]): CodeFinding[] {
  const map = new Map<string, CodeFinding>();
  const keyless: CodeFinding[] = [];

  for (const f of findings) {
    if (f.file === null || f.line === null) {
      keyless.push(f);
      continue;
    }
    const key = `${f.file}:${f.line}:${f.category}`;
    const existing = map.get(key);
    if (!existing || severityRank[f.severity] > severityRank[existing.severity]) {
      map.set(key, f);
    }
  }

  return [...map.values(), ...keyless];
}

const codeVerdictRank: Record<string, number> = { approve: 0, request_changes: 1, reject: 2 };

export function mergeCodeResults(
  results: Omit<CodeReviewResult, 'chunks_reviewed'>[],
  sessionId: string,
): CodeReviewResult {
  let worstVerdict = results[0].verdict;
  for (const r of results) {
    if (codeVerdictRank[r.verdict] > codeVerdictRank[worstVerdict]) {
      worstVerdict = r.verdict;
    }
  }

  return {
    verdict: worstVerdict,
    summary: results.map((r) => r.summary).join(' '),
    findings: deduplicateFindings(results.flatMap((r) => r.findings)),
    session_id: sessionId,
    chunks_reviewed: results.length,
  };
}

export function mergePrecommitResults(
  results: Omit<PrecommitResult, 'chunks_reviewed'>[],
  sessionId: string,
): PrecommitResult {
  return {
    ready_to_commit: results.every((r) => r.ready_to_commit),
    blockers: results.flatMap((r) => r.blockers),
    warnings: results.flatMap((r) => r.warnings),
    session_id: sessionId,
    chunks_reviewed: results.length,
  };
}
