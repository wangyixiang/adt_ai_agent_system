import { describe, it, expect } from "vitest";

import type { UiRecordListEntry } from "../../shared/contract";
import { conversations } from "./conversations";
import type { TranscriptItem } from "./transcript";

const userItem = (workflowId: string, text: string): TranscriptItem => ({
  key: `user:${workflowId}`,
  kind: "user",
  workflowId,
  text,
  attachments: [],
});

const summaryItem = (
  workflowId: string,
  terminalState: "COMPLETED" | "FAILED" | "CANCELLED",
): TranscriptItem => ({
  key: `summary:${workflowId}`,
  kind: "summary",
  workflowId,
  terminalState,
  terminalReason: null,
  recordId: "rec_x",
  text: "",
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
    const list = conversations([userItem("wf_1", "项目起不来了"), summaryItem("wf_1", "COMPLETED")], [
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
    const list = conversations([userItem("wf_2", "还在跑"), userItem("wf_1", "跑完了"), summaryItem("wf_1", "COMPLETED")], []);
    expect(list.map((c) => c.workflowId)).toEqual(["wf_2", "wf_1"]);
    expect(list[0]!.state).toBe("running");
  });

  it("lists history when the projection is empty (after a restart)", () => {
    const list = conversations([], [rec("wf_9", "rec_9", "FAILED")]);
    expect(list).toEqual([
      { workflowId: "wf_9", recordId: "rec_9", title: "p_wf_9", state: "FAILED", live: false, durationMs: 1 },
    ]);
  });
});
