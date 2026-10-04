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
  evidenceBlob: null,
  resuming: false,
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
      completion: null,
    });
  });

  it("carries the completion's refs and its decision, not its summary", () => {
    const candidate: TranscriptItem = {
      key: "ask:wf_1:ask_c",
      kind: "ask",
      workflowId: "wf_1",
      askId: "ask_c",
      ask: { askId: "ask_c", kind: "completion", workflowId: "wf_1", summary: "看起来好了", evidenceRefs: ["st_1"] },
      askKind: "completion",
      answered: false,
      stepId: null,
      text: "有一个完成候选在等你判断",
    };
    const answered: TranscriptItem = { ...candidate, answered: true, text: "认为已解决" };
    expect(deriveWorkbench([tool(), candidate], false).completion).toEqual({
      evidenceRefs: ["st_1"],
      decision: null,
    });
    expect(deriveWorkbench([tool(), answered], false).completion).toEqual({
      evidenceRefs: ["st_1"],
      decision: "认为已解决",
    });
  });

  it("exposes a step's evidence blob", () => {
    const withBlob = { ...tool(), evidenceBlob: { content_ref: "blob_x", media_type: "text/plain", size: 3 } };
    const model = deriveWorkbench([withBlob], false);
    expect(model.steps[0]!.evidenceBlob?.content_ref).toBe("blob_x");
  });

  it("attaches a decision to the step it belongs to", () => {
    const confirmed: TranscriptItem = {
      key: "ask:wf_1:a1",
      kind: "ask",
      workflowId: "wf_1",
      askId: "a1",
      ask: null,
      askKind: "confirmation",
      answered: true,
      stepId: "st_1",
      text: "已确认",
    };
    const pending: TranscriptItem = {
      key: "ask:wf_1:a2",
      kind: "ask",
      workflowId: "wf_1",
      askId: "a2",
      ask: null,
      askKind: "resource_conflict",
      answered: false,
      stepId: "st_1",
      text: "有一个资源冲突在等你决定",
    };
    const model = deriveWorkbench([tool(), confirmed, pending], false);
    expect(model.steps[0]!.decisions).toEqual(["已确认", "待你回答"]);
  });

  it("carries a step's input and its confirmation flag into the model", () => {
    const withInput = { ...tool(), input: { maxLines: 200 }, requiresConfirmation: true };
    const model = deriveWorkbench([withInput], false);
    expect(model.steps[0]!.input).toEqual({ maxLines: 200 });
    expect(model.steps[0]!.requiresConfirmation).toBe(true);
  });
});
