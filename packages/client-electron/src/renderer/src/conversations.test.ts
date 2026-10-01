import { describe, it, expect } from "vitest";

import type { UiRecordListEntry, UiSnapshot, UiWorkflow } from "../../shared/contract";
import { conversations } from "./conversations";

const snapshot = (workflows: UiWorkflow[]): UiSnapshot => ({
  connection: "connected",
  userId: "usr_1",
  capabilities: [],
  workflows,
});

const wf = (
  workflowId: string,
  terminalState: UiWorkflow["terminalState"],
  text = "x",
): UiWorkflow => ({
  workflowId,
  userRequest: { text },
  terminalState,
  terminalReason: null,
  recordId: null,
  pendingAskId: null,
  pendingAsk: null,
  steps: [],
});

const rec = (workflowId: string, recordId: string, state = "COMPLETED"): UiRecordListEntry => ({
  recordId,
  workflowId,
  summary: {
    problem_short: `p_${workflowId}`,
    terminal_state: state,
    result_short: "好了",
    duration_ms: 1,
  },
});

describe("conversations", () => {
  it("keeps a live workflow once, even when its Record already exists", () => {
    const list = conversations(snapshot([wf("wf_1", "COMPLETED", "项目起不来了")]), [
      rec("wf_1", "rec_1"),
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      workflowId: "wf_1",
      live: true,
      recordId: "rec_1",
      title: "项目起不来了",
      state: "COMPLETED",
    });
  });

  it("puts a running workflow first and does not drop a just-terminated one", () => {
    const list = conversations(snapshot([wf("wf_2", null), wf("wf_1", "COMPLETED")]), []);
    expect(list.map((c) => c.workflowId)).toEqual(["wf_2", "wf_1"]);
    expect(list[0]!.state).toBe("running");
  });

  it("lists history when the projection is empty (after a restart)", () => {
    const list = conversations(snapshot([]), [rec("wf_9", "rec_9", "FAILED")]);
    expect(list).toEqual([
      { workflowId: "wf_9", recordId: "rec_9", title: "p_wf_9", state: "FAILED", live: false },
    ]);
  });
});
