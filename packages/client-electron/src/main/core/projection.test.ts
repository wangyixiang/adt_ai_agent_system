import { describe, it, expect } from "vitest";

import { createProjection } from "./projection";

const terminated = {
  workflow_id: "wf_1",
  payload: { terminal_state: "CANCELLED", terminal_reason: null, record_id: "rec_1" },
};

const cancelling = (p: ReturnType<typeof createProjection>): boolean | undefined =>
  p.workflows().find((w) => w.workflowId === "wf_1")?.cancelling;

describe("the projection's cancellation state", () => {
  it("marks a workflow as cancelling and clears it on termination", () => {
    const p = createProjection();
    p.observeCancelAck("wf_1", "CANCELLING");
    expect(cancelling(p)).toBe(true);

    p.observe("workflow.terminated", terminated);
    expect(cancelling(p)).toBe(false);
  });

  it("does not mark a run the Server already reported CANCELLED", () => {
    const p = createProjection();
    p.observeCancelAck("wf_1", "CANCELLED");
    expect(cancelling(p)).toBe(false);
  });

  it("does not re-mark a workflow that has already terminated", () => {
    const p = createProjection();
    p.observe("workflow.terminated", terminated);
    p.observeCancelAck("wf_1", "CANCELLING");
    expect(cancelling(p)).toBe(false);
  });
});

describe("the projection's resumed steps", () => {
  it("seeds a resumed step with its dispatch, then clears resuming on a status", () => {
    const p = createProjection();
    p.noteResumed({
      workflowId: "wf_1",
      stepId: "st_1",
      capability: "git.collect_diagnostics",
      objective: "先收集诊断信息",
      input: { maxLines: 200 },
    });
    const step = p.workflows().find((w) => w.workflowId === "wf_1")!.steps[0]!;
    expect(step).toMatchObject({
      capability: "git.collect_diagnostics",
      objective: "先收集诊断信息",
      input: { maxLines: 200 },
      resuming: true,
    });

    p.observeStepStatus({ workflowId: "wf_1", stepId: "st_1", state: "RUNNING" });
    expect(p.workflows().find((w) => w.workflowId === "wf_1")!.steps[0]!.resuming).toBe(false);
  });
});
