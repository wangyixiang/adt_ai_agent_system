import { describe, it, expect } from "vitest";

import type { TranscriptItem } from "./transcript";
import { deriveWorkbench } from "./workbench";

const tool = (): Extract<TranscriptItem, { kind: "tool" }> => ({
  key: "tool:wf_1:st_1",
  kind: "tool",
  workflowId: "wf_1",
  stepId: "st_1",
  capability: "git.collect_diagnostics",
  objective: "先收集诊断信息",
  input: {},
  state: "COMPLETED",
  requiresConfirmation: false,
  evidenceSummary: "git_status: clean",
  text: "完成",
});

const summary = (): Extract<TranscriptItem, { kind: "summary" }> => ({
  key: "summary:wf_1",
  kind: "summary",
  workflowId: "wf_1",
  terminalState: "COMPLETED",
  terminalReason: null,
  recordId: "rec_1",
  text: "工作流已终止：COMPLETED",
});

describe("deriveWorkbench", () => {
  it("collects the steps and the conclusion of a finished run", () => {
    const model = deriveWorkbench([tool(), summary()], false);
    expect(model.workflowId).toBe("wf_1");
    expect(model.state).toBe("COMPLETED");
    expect(model.steps).toHaveLength(1);
    expect(model.steps[0]!.capability).toBe("git.collect_diagnostics");
    expect(model.conclusion?.recordId).toBe("rec_1");
  });

  it("shows CANCELLING only while it is still running", () => {
    expect(deriveWorkbench([tool()], true).state).toBe("CANCELLING");
    expect(deriveWorkbench([tool()], false).state).toBe("running");
  });

  it("does not let cancelling override a terminal state", () => {
    expect(deriveWorkbench([tool(), summary()], true).state).toBe("COMPLETED");
  });

  it("survives empty input", () => {
    expect(deriveWorkbench([], false)).toEqual({
      workflowId: null,
      state: "running",
      steps: [],
      conclusion: null,
    });
  });
});
