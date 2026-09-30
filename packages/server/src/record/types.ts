import type { CompletionCriteria } from "../workflow/criteria";

/** RECORD_SPEC.md §4 kinds. */
export type RecordEntryKind =
  | "step_dispatched"
  | "evidence_received"
  | "user_confirmation"
  | "user_input"
  | "completion_candidate"
  | "completion_response"
  | "cancellation_requested"
  | "step_outcome_unknown"
  | "reconciliation_resolved"
  | "guardrail_triggered";

export interface RecordEntry {
  entry_id: string;
  ts: number;
  kind: RecordEntryKind;
  ref: Record<string, unknown>;
  narrative: string;
}

export interface RecordSummary {
  problem_short: string;
  terminal_state: string;
  result_short: string;
  duration_ms: number;
}

/** RECORD_SPEC.md §3 — the finished document, written once at termination. */
export interface RecordDocument {
  record_id: string;
  workflow_id: string;
  owner_user_id: string;
  spec_versions: { workflow_spec: string; capability_spec: string };
  created_at: number;
  ended_at: number;
  terminal_state: string;
  terminal_reason: string | null;
  completion_criteria: CompletionCriteria;
  /** Every recorded revision, oldest first (RECORD_SPEC.md §3). */
  criteria_revisions: Array<{ ts: number; criteria: CompletionCriteria }>;
  user_request: unknown;
  summary: RecordSummary;
  entries: RecordEntry[];
  final_result: Record<string, unknown>;
}

export interface UnresolvedSideEffect {
  step_id: string;
  capability: string;
  idempotency_key: string | null;
  last_known_state: "UNKNOWN";
}
