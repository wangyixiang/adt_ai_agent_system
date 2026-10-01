import { describe, it, expect } from "vitest";

import { createProjection } from "./projection";

const terminated = {
  workflow_id: "wf_1",
  payload: { terminal_state: "CANCELLED", terminal_reason: null, record_id: "rec_1" },
};

const cancelling = (p: ReturnType<typeof createProjection>): boolean | undefined =>
  p.snapshot(null).workflows.find((w) => w.workflowId === "wf_1")?.cancelling;

describe("the projection's cancellation state", () => {
  it("marks a workflow as cancelling and clears it on termination", () => {
    const p = createProjection();
    p.observeCancelAck("wf_1");
    expect(cancelling(p)).toBe(true);

    p.observe("workflow.terminated", terminated);
    expect(cancelling(p)).toBe(false);
  });

  it("does not re-mark a workflow that has already terminated", () => {
    const p = createProjection();
    p.observe("workflow.terminated", terminated);
    p.observeCancelAck("wf_1");
    expect(cancelling(p)).toBe(false);
  });
});
