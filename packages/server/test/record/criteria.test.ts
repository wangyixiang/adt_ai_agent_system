import { describe, it, expect } from "vitest";
import { buildRecord } from "../../src/record/builder";
import type { StepSnapshot, WorkflowEvent, WorkflowSnapshot } from "../../src/workflow/store";

const workflow: WorkflowSnapshot = {
  id: "wf_1",
  userId: "usr_1",
  sessionId: "sess_1",
  userRequest: { text: "x" },
  state: "COMPLETED",
  terminalReason: null,
  criteria: { mode: "open", revision: 1, description: "问题消失" },
  createdAt: 100,
  endedAt: 200,
  notSolvedRounds: 0,
};
const ev = (kind: any, payload: any, id = `ev_${kind}`): WorkflowEvent => ({
  id,
  workflowId: "wf_1",
  kind,
  ts: 150,
  payload,
});

describe("criteria revisions", () => {
  it("keeps the latest criteria and its revision history", () => {
    const record = buildRecord({
      workflow,
      steps: [] as StepSnapshot[],
      events: [
        ev("workflow_created", { request: { text: "x" } }),
        ev(
          "criteria_revised",
          { criteria: { mode: "open", revision: 1, description: "问题消失" } },
          "ev_r1",
        ),
        ev("workflow_terminated", { state: "COMPLETED", reason: null }),
      ],
      userRequest: { text: "x" },
      recordId: "rec_c",
    });
    expect(record.completion_criteria.revision).toBe(1);
    expect(record.criteria_revisions).toHaveLength(1);
    expect(record.criteria_revisions[0]!.criteria.description).toBe("问题消失");
  });

  it("seeds the revision history with the criteria recorded at creation", () => {
    const record = buildRecord({
      workflow,
      steps: [] as StepSnapshot[],
      events: [
        ev("workflow_created", {
          request: { text: "x" },
          criteria: { mode: "open", revision: 0, description: "初始条件" },
        }),
        ev(
          "criteria_revised",
          { criteria: { mode: "open", revision: 1, description: "问题消失" } },
          "ev_r1",
        ),
        ev("workflow_terminated", { state: "COMPLETED", reason: null }),
      ],
      userRequest: { text: "x" },
      recordId: "rec_seed",
    });
    expect(record.criteria_revisions.map((entry) => entry.criteria.revision)).toEqual([0, 1]);
  });

  it("keeps every revision in order", () => {
    const record = buildRecord({
      workflow,
      steps: [] as StepSnapshot[],
      events: [
        ev("workflow_created", { request: { text: "x" } }),
        ev("criteria_revised", { criteria: { mode: "open", revision: 1, description: "第一版" } }, "ev_r1"),
        ev("criteria_revised", { criteria: { mode: "open", revision: 2, description: "第二版" } }, "ev_r2"),
        ev("workflow_terminated", { state: "COMPLETED", reason: null }),
      ],
      userRequest: { text: "x" },
      recordId: "rec_two",
    });
    expect(record.criteria_revisions.map((entry) => entry.criteria.revision)).toEqual([1, 2]);
    expect(record.completion_criteria.revision).toBe(1);
  });
});
