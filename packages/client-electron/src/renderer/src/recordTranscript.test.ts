import { describe, it, expect } from "vitest";

import type { UiRecord, UiRecordEntry } from "../../shared/contract";
import { transcriptFromRecord } from "./recordTranscript";
import type { TranscriptItem } from "./transcript";

let seq = 0;
const entry = (kind: string, ref: Record<string, unknown>, narrative = "n"): UiRecordEntry => ({
  entry_id: `e_${++seq}`,
  ts: seq,
  kind,
  ref,
  narrative,
});

function recordOf(entries: UiRecordEntry[]): UiRecord {
  return {
    record_id: "rec_1",
    workflow_id: "wf_1",
    created_at: 0,
    ended_at: 1000,
    terminal_state: "COMPLETED",
    terminal_reason: null,
    user_request: { text: "项目起不来了" },
    summary: {
      problem_short: "项目起不来了",
      terminal_state: "COMPLETED",
      result_short: "好了",
      duration_ms: 1000,
    },
    entries,
    final_result: { resolution_summary: "好了" },
  };
}

const tool = (items: TranscriptItem[]): Extract<TranscriptItem, { kind: "tool" }> =>
  items.find((i) => i.kind === "tool")! as Extract<TranscriptItem, { kind: "tool" }>;
const ask = (items: TranscriptItem[]): Extract<TranscriptItem, { kind: "ask" }> =>
  items.find((i) => i.kind === "ask")! as Extract<TranscriptItem, { kind: "ask" }>;

describe("transcriptFromRecord", () => {
  it("maps a run into user → tool → completion → summary", () => {
    const items = transcriptFromRecord(
      recordOf([
        entry("step_dispatched", {
          step_id: "st_1",
          capability: "git.collect_diagnostics",
          objective: "先收集诊断信息",
          input: { maxLines: 200 },
        }),
        entry("step_status", { step_id: "st_1", state: "COMPLETED" }),
        entry("evidence_received", {
          step_id: "st_1",
          evidence: { type: "git_status", result: { branch: "main" } },
        }),
        entry("completion_candidate", { summary: "看起来好了", evidence_refs: ["st_1"] }),
        entry("completion_response", { resolution: "solved", feedback: null }),
      ]),
    );

    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "ask", "summary"]);
    expect(items[0]).toMatchObject({ kind: "user", text: "项目起不来了" });
    expect(tool(items)).toMatchObject({ state: "COMPLETED", input: { maxLines: 200 } });
    expect(tool(items).text).toContain("完成");
    expect(tool(items).evidenceSummary).toContain("git_status");
    expect(ask(items)).toMatchObject({ askKind: "completion", answered: true, text: "认为已解决" });
    expect(ask(items).ask).toMatchObject({ summary: "看起来好了", evidenceRefs: ["st_1"] });
    expect(items[3]).toMatchObject({ kind: "summary", recordId: "rec_1" });
    // The conclusion is surfaced, not just the terminal state.
    expect((items[3] as Extract<TranscriptItem, { kind: "summary" }>).text).toContain("好了");
  });

  it("uses the last step_status as the step's state", () => {
    const items = transcriptFromRecord(
      recordOf([
        entry("step_dispatched", { step_id: "st_1", capability: "c", objective: "o", input: {} }),
        entry("step_status", { step_id: "st_1", state: "FAILED" }),
      ]),
    );
    expect(tool(items).state).toBe("FAILED");
  });

  it("keeps the two kinds of `unknown` apart", () => {
    const items = transcriptFromRecord(
      recordOf([
        entry("step_dispatched", { step_id: "st_1", capability: "c", objective: "o", input: {} }),
        entry("step_status", { step_id: "st_1", state: "UNKNOWN" }),
        entry("user_input", {
          step_id: "st_1",
          content: { outcome: "unknown", observation: "看不出来" },
        }),
      ]),
    );
    expect(tool(items).text).toContain("系统");
    expect(ask(items).text).toContain("人");
    expect(tool(items).text).not.toBe(ask(items).text);
  });
});
