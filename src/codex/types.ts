export interface ReviewFinding {
  severity: 'critical' | 'major' | 'minor' | 'suggestion' | 'nitpick';
  category: string;
  description: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

export interface PlanReviewResult {
  verdict: 'approve' | 'revise' | 'reject';
  summary: string;
  findings: ReviewFinding[];
  session_id: string;
}

export interface CodeReviewResult {
  verdict: 'approve' | 'request_changes' | 'reject';
  summary: string;
  findings: ReviewFinding[];
  session_id: string;
}

export interface PrecommitResult {
  ready_to_commit: boolean;
  blockers: string[];
  warnings: string[];
  session_id: string;
}
