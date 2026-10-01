/**
 * The left list's model: the runs this session knows (live, from the projection)
 * merged with the user's finished Records (history, from the Server). Pure, so
 * the de-dup and ordering are testable without a UI.
 */
import type { UiRecordListEntry, UiSnapshot } from "../../shared/contract";

export interface UiConversation {
  workflowId: string;
  recordId: string | null;
  title: string;
  state: "running" | "COMPLETED" | "FAILED" | "CANCELLED";
  live: boolean;
}

export function conversations(
  snapshot: UiSnapshot,
  records: UiRecordListEntry[],
): UiConversation[] {
  const liveIds = new Set(snapshot.workflows.map((workflow) => workflow.workflowId));
  const byWorkflow = new Map(records.map((record) => [record.workflowId, record]));

  const running: UiConversation[] = [];
  const finished: UiConversation[] = [];

  // Live first: a run this session still holds (even after it terminated but
  // before the Record is fetched) must not vanish from the list.
  for (const workflow of snapshot.workflows) {
    const record = byWorkflow.get(workflow.workflowId);
    const conversation: UiConversation = {
      workflowId: workflow.workflowId,
      recordId: record?.recordId ?? null,
      title: workflow.userRequest.text !== "" ? workflow.userRequest.text : (record?.summary.problem_short ?? "（未命名）"),
      state: workflow.terminalState ?? "running",
      live: true,
    };
    if (workflow.terminalState === null) running.push(conversation);
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
    }));

  return [...running, ...finished, ...history];
}
