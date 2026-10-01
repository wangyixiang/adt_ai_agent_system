/**
 * Reconstruct a past conversation from its Record (`RECORD_SPEC.md` §3/§4) as the
 * same `TranscriptItem` shape the live view uses — so one set of components
 * renders both. Pure: a frozen Record always yields the same transcript.
 *
 * It *reads* a step's terminal state from `step_status` entries; where those are
 * absent (older Records), it falls back to the derived entries.
 */
import type { ManualOutcome } from "@adt/shared";

import type { UiAttachment, UiRecord, UiRecordEntry } from "../../shared/contract";
import { MANUAL_OUTCOME_TEXT, STEP_STATE_TEXT, type TranscriptItem } from "./transcript";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
type AskItem = Extract<TranscriptItem, { kind: "ask" }>;

function summarizeEvidence(evidence: unknown): string {
  const value = (evidence ?? {}) as { type?: unknown; result?: unknown };
  const type = typeof value.type === "string" ? value.type : "evidence";
  const result = value.result;
  const text = typeof result === "string" ? result : JSON.stringify(result ?? {});
  return `${type}: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

/** A blob reference inside evidence, if any (mirrors RECORD_SPEC v0.10). */
function blobRefOf(evidence: unknown): ToolItem["evidenceBlob"] {
  const result = asRecord(asRecord(evidence)["result"]);
  if (typeof result["content_ref"] !== "string") return null;
  return {
    content_ref: result["content_ref"],
    media_type: typeof result["media_type"] === "string" ? result["media_type"] : "application/octet-stream",
    size: typeof result["size"] === "number" ? result["size"] : 0,
    ...(typeof result["name"] === "string" ? { name: result["name"] } : {}),
  };
}

/** Attachments as they were kept in the Record, ignoring anything malformed. */
function parseAttachments(value: unknown): UiAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is UiAttachment => {
    const attachment = item as Record<string, unknown>;
    const wellFormed =
      typeof attachment["name"] === "string" && typeof attachment["media_type"] === "string";
    if (!wellFormed) return false;
    if (attachment["mode"] === "blob") return typeof attachment["content_ref"] === "string";
    if (attachment["mode"] === "inline") return typeof attachment["data_base64"] === "string";
    return false;
  });
}

export function transcriptFromRecord(record: UiRecord): TranscriptItem[] {
  const workflowId = record.workflow_id;
  const items: TranscriptItem[] = [];
  const toolIndex = new Map<string, number>();
  const askIndex = new Map<string, number>();

  items.push({
    key: `hist:user:${workflowId}`,
    kind: "user",
    workflowId,
    text: record.user_request.text,
    attachments: parseAttachments(record.user_request["attachments"]),
  });

  const putTool = (patch: Partial<ToolItem> & { stepId: string }): void => {
    const index = toolIndex.get(patch.stepId);
    if (index === undefined) {
      const stepId = patch.stepId;
      toolIndex.set(stepId, items.length);
      const state = patch.state ?? "PENDING";
      items.push({
        key: `hist:tool:${stepId}`,
        kind: "tool",
        workflowId,
        stepId,
        capability: patch.capability ?? "",
        objective: patch.objective ?? "",
        input: patch.input ?? {},
        state,
        requiresConfirmation: patch.requiresConfirmation ?? false,
        evidenceSummary: patch.evidenceSummary ?? null,
        evidenceBlob: patch.evidenceBlob ?? null,
        text: STEP_STATE_TEXT[state],
      });
      return;
    }
    const previous = items[index] as ToolItem;
    const state = patch.state ?? previous.state;
    items[index] = {
      ...previous,
      ...patch,
      state,
      text: STEP_STATE_TEXT[state],
    };
  };

  const upsertAsk = (key: string, make: () => AskItem): void => {
    const index = askIndex.get(key);
    if (index === undefined) {
      askIndex.set(key, items.length);
      items.push(make());
      return;
    }
    items[index] = make();
  };

  for (const entry of record.entries) {
    const ref = asRecord(entry.ref);
    switch (entry.kind) {
      case "step_dispatched": {
        const stepId = String(ref.step_id ?? "");
        const capability = String(ref.capability ?? "");
        const objective = typeof ref.objective === "string" ? ref.objective : "";
        const input = asRecord(ref.input);
        items.push({
          key: `hist:assistant:${stepId}`,
          kind: "assistant",
          workflowId,
          stepId,
          capability,
          text: objective,
        });
        putTool({ stepId, capability, objective, input });
        break;
      }

      case "step_status": {
        const stepId = String(ref.step_id ?? "");
        putTool({ stepId, state: ref.state as ToolItem["state"] });
        break;
      }

      case "evidence_received": {
        const stepId = String(ref.step_id ?? "");
        const blob = blobRefOf(ref.evidence);
        putTool({
          stepId,
          evidenceSummary: summarizeEvidence(ref.evidence),
          ...(blob === null ? {} : { evidenceBlob: blob }),
        });
        break;
      }

      case "step_rejected": {
        putTool({ stepId: String(ref.step_id ?? ""), state: "REJECTED" });
        break;
      }

      case "step_outcome_unknown": {
        putTool({ stepId: String(ref.step_id ?? ""), state: "UNKNOWN" });
        break;
      }

      case "reconciliation_resolved": {
        putTool({ stepId: String(ref.step_id ?? ""), state: ref.resolved_to as ToolItem["state"] });
        break;
      }

      case "user_confirmation": {
        const stepId = String(ref.step_id ?? "");
        const text = ref.decision === "confirmed" ? "已确认" : "已拒绝";
        upsertAsk(`hist:ask:confirmation:${stepId}`, () => ({
          key: `hist:ask:confirmation:${stepId}`,
          kind: "ask",
          workflowId,
          askId: `hist:${stepId}`,
          ask: null,
          askKind: "confirmation",
          answered: true,
          stepId,
          text,
        }));
        break;
      }

      case "user_input": {
        const stepId = String(ref.step_id ?? "");
        const content = asRecord(ref.content);
        const outcome = content["outcome"] as ManualOutcome | undefined;
        const observation = typeof content["observation"] === "string" ? content["observation"] : "";
        const label = outcome === undefined ? "人补充了信息" : MANUAL_OUTCOME_TEXT[outcome];
        upsertAsk(`hist:ask:manual:${stepId}`, () => ({
          key: `hist:ask:manual:${stepId}`,
          kind: "ask",
          workflowId,
          askId: `hist:${stepId}`,
          ask: null,
          askKind: "manual_action",
          answered: true,
          stepId,
          text: observation === "" ? label : `${label}：${observation}`,
        }));
        break;
      }

      case "completion_candidate": {
        upsertAsk("hist:ask:completion", () => ({
          key: "hist:ask:completion",
          kind: "ask",
          workflowId,
          askId: "hist:completion",
          ask: null,
          askKind: "completion",
          answered: false,
          stepId: null,
          text: "有一个完成候选在等你判断",
        }));
        break;
      }

      case "completion_response": {
        const resolution = ref.resolution === "solved" ? "认为已解决" : "认为没解决";
        upsertAsk("hist:ask:completion", () => ({
          key: "hist:ask:completion",
          kind: "ask",
          workflowId,
          askId: "hist:completion",
          ask: null,
          askKind: "completion",
          answered: true,
          stepId: null,
          text: resolution,
        }));
        break;
      }

      case "cancellation_requested":
      case "guardrail_triggered":
        items.push({
          key: `hist:notice:${items.length}`,
          kind: "notice",
          level: entry.kind === "guardrail_triggered" ? "warn" : "info",
          text: entry.narrative,
        });
        break;

      default:
        break;
    }
  }

  const reason = record.terminal_reason === null ? "" : ` · ${record.terminal_reason}`;
  const final = asRecord(record.final_result);
  const conclusion =
    (typeof final["resolution_summary"] === "string" ? final["resolution_summary"] : null) ??
    (typeof final["failure_summary"] === "string" ? final["failure_summary"] : null) ??
    (typeof final["cancelled_summary"] === "string" ? final["cancelled_summary"] : null);
  items.push({
    key: `hist:summary:${workflowId}`,
    kind: "summary",
    workflowId,
    terminalState: record.terminal_state as Extract<TranscriptItem, { kind: "summary" }>["terminalState"],
    terminalReason: record.terminal_reason,
    recordId: record.record_id,
    text: `工作流已终止：${record.terminal_state}${reason}${conclusion === null ? "" : ` · ${conclusion}`}`,
  });

  return items;
}

/** Exported for tests/consumers that want the raw entries. */
export type { UiRecordEntry };
