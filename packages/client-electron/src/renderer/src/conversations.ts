/**
 * The left list's model: the runs this session knows (live, from the derived
 * transcript — which already merges the snapshot and the event stream) merged
 * with the user's finished Records (history, from the Server). Pure, so the
 * de-dup and ordering are testable without a UI.
 */
import type { UiRecordListEntry } from "../../shared/contract";
import type { TranscriptItem } from "./transcript";

export interface UiConversation {
  workflowId: string;
  recordId: string | null;
  title: string;
  state: "running" | "COMPLETED" | "FAILED" | "CANCELLED";
  live: boolean;
  /** Elapsed time in ms, when the run's Record is known. */
  durationMs?: number;
}

interface LiveInfo {
  title: string;
  state: UiConversation["state"];
}

export function conversations(
  items: TranscriptItem[],
  records: UiRecordListEntry[],
): UiConversation[] {
  // Live runs come from the transcript, not the snapshot: a run started since
  // the snapshot was fetched exists only in the event stream.
  const live = new Map<string, LiveInfo>();
  for (const item of items) {
    if (item.kind === "notice") continue;
    const info: LiveInfo = live.get(item.workflowId) ?? { title: "", state: "running" };
    if (item.kind === "user") info.title = item.text;
    if (item.kind === "summary") info.state = item.terminalState;
    live.set(item.workflowId, info);
  }

  const liveIds = new Set(live.keys());
  const byWorkflow = new Map(records.map((record) => [record.workflowId, record]));

  const running: UiConversation[] = [];
  const finished: UiConversation[] = [];

  for (const [workflowId, info] of live) {
    const record = byWorkflow.get(workflowId);
    const conversation: UiConversation = {
      workflowId,
      recordId: record?.recordId ?? null,
      title: info.title !== "" ? info.title : (record?.summary.problem_short ?? "（未命名）"),
      state: info.state,
      live: true,
      ...(record === undefined ? {} : { durationMs: record.summary.duration_ms }),
    };
    if (info.state === "running") running.push(conversation);
    else finished.push(conversation);
  }

  const history: UiConversation[] = records
    .filter((record) => !liveIds.has(record.workflowId))
    .map((record) => ({
      workflowId: record.workflowId,
      recordId: record.recordId,
      title: record.summary.problem_short,
      state: record.summary.terminal_state as UiConversation["state"],
      live: false,
      durationMs: record.summary.duration_ms,
    }));

  return [...running, ...finished, ...history];
}
