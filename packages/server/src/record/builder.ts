import type { CompletionCriteria } from "../workflow/criteria";
import type { StepSnapshot, WorkflowEvent, WorkflowSnapshot } from "../workflow/store";
import type {
  RecordDocument,
  RecordEntry,
  RecordEntryKind,
  UnresolvedSideEffect,
} from "./types";

/** Spec versions the domain model was read from (RECORD_SPEC.md §6). */
export const SPEC_VERSIONS = { workflow_spec: "0.5", capability_spec: "0.7" } as const;

export interface BuildRecordInput {
  workflow: WorkflowSnapshot;
  steps: StepSnapshot[];
  events: WorkflowEvent[];
  userRequest: unknown;
  recordId: string;
}

const truncate = (text: string, max = 60): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * Deterministic, template-only narratives. LLM polish and the consistency
 * check (RECORD_SPEC.md §4) remain a later refinement; the text must never go
 * beyond the structured `ref`.
 */
export function renderNarrative(kind: RecordEntryKind, ref: Record<string, unknown>): string {
  switch (kind) {
    case "step_dispatched":
      return `下发了 ${String(ref.capability)}：${String(ref.objective)}。`;
    case "evidence_received": {
      const evidence = ref.evidence as { source?: string; type?: string } | undefined;
      return `获得了 ${String(evidence?.type)} 证据（来源 ${String(evidence?.source)}）。`;
    }
    case "user_confirmation":
      return `工程师${ref.decision === "confirmed" ? "确认" : "拒绝"}了副作用动作。`;
    case "step_rejected": {
      const reason = ref.reject_reason as { code?: unknown } | null | undefined;
      return `未执行 ${String(ref.capability)}（原因 ${String(reason?.code ?? "unknown")}）。`;
    }
    case "user_input":
      return "工程师补充了信息。";
    case "completion_candidate":
      return "系统提出可能已解决。";
    case "completion_response":
      return `工程师确认：${ref.resolution === "solved" ? "已解决" : "未解决"}。`;
    case "cancellation_requested":
      return "工程师请求取消。";
    case "step_outcome_unknown":
      return `副作用动作 ${String(ref.capability)} 的结果未知，需要人工对账。`;
    case "reconciliation_resolved":
      return `对账将 ${String(ref.step_id)} 裁定为 ${String(ref.resolved_to)}。`;
    case "guardrail_triggered":
      return `触发终止护栏 ${String(ref.guardrail)}，Workflow 终止。`;
  }
}

const asPayload = (event: WorkflowEvent): Record<string, unknown> =>
  (event.payload ?? {}) as Record<string, unknown>;

function toEntry(
  event: WorkflowEvent,
  stepsById: Map<string, StepSnapshot>,
): RecordEntry | null {
  const payload = asPayload(event);
  const base = { entry_id: event.id, ts: event.ts };

  switch (event.kind) {
    case "step_dispatched": {
      const stepId = payload.stepId;
      if (typeof stepId !== "string") return null; // the "starting" marker
      const step = stepsById.get(stepId);
      const ref = {
        step_id: stepId,
        capability: payload.capability,
        objective: step?.objective ?? null,
        input: payload.input ?? {},
      };
      return { ...base, kind: "step_dispatched", ref, narrative: renderNarrative("step_dispatched", ref) };
    }
    case "step_status": {
      const stepId = payload.stepId;
      if (typeof stepId !== "string") return null;

      if (payload.reconciled === true) {
        const ref = {
          step_id: stepId,
          resolved_to: payload.state,
          evidence_refs: (payload.evidenceRefs as string[] | undefined) ?? [],
        };
        return { ...base, kind: "reconciliation_resolved", ref, narrative: renderNarrative("reconciliation_resolved", ref) };
      }

      if (payload.state === "UNKNOWN") {
        const step = stepsById.get(stepId);
        const ref = {
          step_id: stepId,
          capability: step?.capability ?? null,
          idempotency_key: step?.idempotencyKey ?? null,
        };
        return { ...base, kind: "step_outcome_unknown", ref, narrative: renderNarrative("step_outcome_unknown", ref) };
      }

      // A rejection is a decision that happened. Only `user_declined` is a
      // human decision; other reject reasons get their own, non-human entry.
      if (payload.state === "REJECTED") {
        const rejectReason = payload.rejectReason as { code?: unknown } | undefined;
        const code = typeof rejectReason?.code === "string" ? rejectReason.code : "user_declined";
        if (code === "user_declined") {
          const ref = { step_id: stepId, decision: "declined" };
          return { ...base, kind: "user_confirmation", ref, narrative: renderNarrative("user_confirmation", ref) };
        }
        const step = stepsById.get(stepId);
        const ref = {
          step_id: stepId,
          capability: step?.capability ?? null,
          reject_reason: payload.rejectReason ?? null,
        };
        return { ...base, kind: "step_rejected", ref, narrative: renderNarrative("step_rejected", ref) };
      }

      // Engineer-supplied evidence is a `user_input`, not a Capability result
      // (RECORD_SPEC.md §4; WORKFLOW_SPEC.md §6.1 advisory path).
      const evidence = payload.evidence as { source?: unknown; result?: unknown } | undefined;
      if (
        (payload.state === "COMPLETED" || payload.state === "FAILED") &&
        evidence?.source === "user_input"
      ) {
        const ref = { step_id: stepId, content: evidence.result ?? null };
        return { ...base, kind: "user_input", ref, narrative: renderNarrative("user_input", ref) };
      }

      if (
        (payload.state === "COMPLETED" || payload.state === "FAILED") &&
        payload.evidence !== undefined &&
        payload.evidence !== null
      ) {
        const ref = {
          step_id: stepId,
          evidence: payload.evidence,
          ...(payload.failReason === undefined ? {} : { fail_reason: payload.failReason }),
        };
        return { ...base, kind: "evidence_received", ref, narrative: renderNarrative("evidence_received", ref) };
      }

      return null;
    }
    case "completion_response": {
      const ref = { resolution: payload.resolution, feedback: payload.feedback ?? null };
      return { ...base, kind: "completion_response", ref, narrative: renderNarrative("completion_response", ref) };
    }
    case "cancel_requested": {
      const ref = { reason: payload.reason ?? null };
      return { ...base, kind: "cancellation_requested", ref, narrative: renderNarrative("cancellation_requested", ref) };
    }
    case "completion_candidate": {
      const ref = {
        summary: payload.summary ?? null,
        evidence_refs: payload.evidenceRefs ?? [],
      };
      return { ...base, kind: "completion_candidate", ref, narrative: renderNarrative("completion_candidate", ref) };
    }
    case "guardrail_triggered": {
      const ref = { guardrail: payload.reason, threshold: payload.threshold ?? null };
      return { ...base, kind: "guardrail_triggered", ref, narrative: renderNarrative("guardrail_triggered", ref) };
    }
    default:
      // workflow_created / criteria_revised / workflow_terminated are not entries.
      return null;
  }
}

/** Revision 0 is recorded on `workflow_created`; later revisions emit `criteria_revised`. */
function collectCriteriaRevisions(
  events: WorkflowEvent[],
): Array<{ ts: number; criteria: CompletionCriteria }> {
  const revisions: Array<{ ts: number; criteria: CompletionCriteria }> = [];
  for (const event of events) {
    if (event.kind === "workflow_created") {
      const criteria = (event.payload as { criteria?: CompletionCriteria }).criteria;
      if (criteria) revisions.push({ ts: event.ts, criteria });
    } else if (event.kind === "criteria_revised") {
      revisions.push({
        ts: event.ts,
        criteria: (event.payload as { criteria: CompletionCriteria }).criteria,
      });
    }
  }
  return revisions;
}

export function buildRecord(input: BuildRecordInput): RecordDocument {
  const { workflow, steps, events, userRequest, recordId } = input;
  const stepsById = new Map(steps.map((step) => [step.id, step]));

  const entries = events
    .map((event) => toEntry(event, stepsById))
    .filter((entry): entry is RecordEntry => entry !== null);

  const unresolved: UnresolvedSideEffect[] = steps
    .filter((step) => step.state === "UNKNOWN")
    .map((step) => ({
      step_id: step.id,
      capability: step.capability,
      idempotency_key: step.idempotencyKey,
      last_known_state: "UNKNOWN" as const,
    }));

  const requestText =
    typeof (userRequest as { text?: unknown } | null)?.text === "string"
      ? ((userRequest as { text: string }).text)
      : "";

  const controlled = steps.some((step) => step.sideEffect && step.state === "COMPLETED");
  const unresolvedNote = "存在未对账的副作用动作（可能已执行）";

  const resultShort =
    unresolved.length > 0
      ? unresolvedNote
      : workflow.state === "COMPLETED"
        ? controlled
          ? "通过受控执行解决"
          : "通过建议解决"
        : workflow.state === "FAILED"
          ? `无法继续：${workflow.terminalReason ?? "未知原因"}`
          : `已取消${workflow.terminalReason ? `（${workflow.terminalReason}）` : ""}`;

  const finalResult: Record<string, unknown> =
    workflow.state === "COMPLETED"
      ? {
          root_cause: null,
          resolution: controlled ? "controlled_execution" : "advisory",
          resolution_summary: resultShort,
        }
      : workflow.state === "FAILED"
        ? { failure_summary: resultShort }
        : { cancelled_summary: null };

  if (unresolved.length > 0) finalResult.unresolved_side_effects = unresolved;

  return {
    record_id: recordId,
    workflow_id: workflow.id,
    owner_user_id: workflow.userId,
    spec_versions: { ...SPEC_VERSIONS },
    created_at: workflow.createdAt,
    ended_at: workflow.endedAt ?? workflow.createdAt,
    terminal_state: workflow.state,
    terminal_reason: workflow.terminalReason,
    completion_criteria: workflow.criteria,
    criteria_revisions: collectCriteriaRevisions(events),
    user_request: userRequest,
    summary: {
      problem_short: truncate(requestText),
      terminal_state: workflow.state,
      result_short: resultShort,
      duration_ms: (workflow.endedAt ?? workflow.createdAt) - workflow.createdAt,
    },
    entries,
    final_result: finalResult,
  };
}
