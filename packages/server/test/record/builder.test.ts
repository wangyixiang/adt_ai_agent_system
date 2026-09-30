import { describe, it, expect } from "vitest";
import { buildRecord, renderNarrative } from "../../src/record/builder";
import type {
  StepSnapshot,
  WorkflowEvent,
  WorkflowEventKind,
  WorkflowSnapshot,
} from "../../src/workflow/store";

const workflow: WorkflowSnapshot = {
  id: "wf_1",
  userId: "usr_1",
  sessionId: "sess_1",
  userRequest: { text: "svc down" },
  state: "COMPLETED",
  terminalReason: null,
  criteria: { mode: "open", revision: 0 },
  createdAt: 100,
  endedAt: 200,
  notSolvedRounds: 0,
};

const step = (over: Partial<StepSnapshot> = {}): StepSnapshot => ({
  id: "step_1",
  workflowId: "wf_1",
  state: "COMPLETED",
  objective: "read",
  capability: "git.collect_diagnostics",
  sideEffect: false,
  interruptible: true,
  idempotencyKey: null,
  attempt: 1,
  waitClass: null,
  input: {},
  ...over,
});

const ev = (kind: WorkflowEventKind, payload: unknown, id = `ev_${kind}`): WorkflowEvent => ({
  id,
  workflowId: "wf_1",
  kind,
  ts: 100,
  payload,
});

describe("record builder", () => {
  it("includes only what actually happened, in insertion order", () => {
    const record = buildRecord({
      workflow,
      steps: [step()],
      events: [
        ev("workflow_created", { request: { text: "svc down" } }),
        ev("step_dispatched", { stepId: "step_1", capability: "git.collect_diagnostics" }),
        ev("step_status", { stepId: "step_1", state: "RUNNING" }),
        ev("step_status", {
          stepId: "step_1",
          state: "COMPLETED",
          evidence: { source: "capability", type: "git_status", result: { branch: "main" } },
        }),
        ev("completion_response", { resolution: "solved" }),
        ev("workflow_terminated", { state: "COMPLETED", reason: null }),
      ],
      userRequest: { text: "svc down" },
      recordId: "rec_1",
    });

    expect(record.record_id).toBe("rec_1");
    expect(record.owner_user_id).toBe("usr_1");
    expect(record.terminal_state).toBe("COMPLETED");
    expect(record.summary.problem_short).toContain("svc down");
    expect(record.entries.map((e) => e.kind)).toEqual([
      "step_dispatched",
      "evidence_received",
      "completion_response",
    ]);
    expect(record.entries[1]!.ref.evidence).toEqual({
      source: "capability",
      type: "git_status",
      result: { branch: "main" },
    });
    expect(record.final_result.resolution).toBe("advisory");
  });

  it("never invents entries for steps that did not happen", () => {
    const record = buildRecord({
      workflow: { ...workflow, state: "CANCELLED", terminalReason: "user_cancelled" },
      steps: [],
      events: [
        ev("workflow_created", { request: { text: "x" } }),
        ev("cancel_requested", { reason: "user_cancelled" }),
        ev("workflow_terminated", { state: "CANCELLED", reason: "user_cancelled" }),
      ],
      userRequest: { text: "x" },
      recordId: "rec_2",
    });

    expect(record.entries.map((e) => e.kind)).toEqual(["cancellation_requested"]);
    expect(record.final_result).toEqual({ cancelled_summary: null });
  });

  it("flags unresolved side effects when an UNKNOWN was never reconciled", () => {
    const record = buildRecord({
      workflow: { ...workflow, state: "CANCELLED", terminalReason: "user_cancelled" },
      steps: [
        step({
          id: "step_9",
          state: "UNKNOWN",
          capability: "sim_rig.trigger_reset",
          sideEffect: true,
          interruptible: false,
          idempotencyKey: "idem_9",
        }),
      ],
      events: [
        ev("workflow_created", { request: { text: "x" } }),
        ev("step_dispatched", { stepId: "step_9", capability: "sim_rig.trigger_reset" }),
        ev("step_status", { stepId: "step_9", state: "UNKNOWN" }),
        ev("cancel_requested", { reason: "user_cancelled" }),
        ev("workflow_terminated", { state: "CANCELLED", reason: "user_cancelled" }),
      ],
      userRequest: { text: "x" },
      recordId: "rec_3",
    });

    expect(record.final_result.unresolved_side_effects).toEqual([
      {
        step_id: "step_9",
        capability: "sim_rig.trigger_reset",
        idempotency_key: "idem_9",
        last_known_state: "UNKNOWN",
      },
    ]);
    expect(record.summary.result_short).toContain("未对账");
  });

  it("marks a side-effect resolution as controlled execution", () => {
    const record = buildRecord({
      workflow,
      steps: [
        step({
          id: "step_7",
          capability: "sim_rig.trigger_reset",
          sideEffect: true,
          interruptible: false,
        }),
      ],
      events: [
        ev("workflow_created", { request: { text: "x" } }),
        ev("step_dispatched", { stepId: "step_7", capability: "sim_rig.trigger_reset" }),
        ev("step_status", {
          stepId: "step_7",
          state: "COMPLETED",
          evidence: { source: "capability", type: "reset_ack", result: { reset_ack: true } },
        }),
        ev("completion_response", { resolution: "solved" }),
        ev("workflow_terminated", { state: "COMPLETED", reason: null }),
      ],
      userRequest: { text: "x" },
      recordId: "rec_4",
    });

    expect(record.final_result.resolution).toBe("controlled_execution");
  });

  it("renders narratives from the structured ref only", () => {
    expect(
      renderNarrative("evidence_received", {
        step_id: "step_1",
        evidence: { source: "capability", type: "git_status", result: { branch: "main" } },
      }),
    ).toContain("git_status");
  });

  it("records a declined side-effect action as a user confirmation", () => {
    const record = buildRecord({
      workflow: { ...workflow, state: "RUNNING" },
      steps: [
        step({
          id: "step_7",
          state: "REJECTED",
          capability: "sim_rig.trigger_reset",
          sideEffect: true,
          interruptible: false,
        }),
      ],
      events: [
        ev("workflow_created", { request: { text: "x" } }),
        ev("step_dispatched", { stepId: "step_7", capability: "sim_rig.trigger_reset" }),
        ev("step_status", { stepId: "step_7", state: "REJECTED" }),
      ],
      userRequest: { text: "x" },
      recordId: "rec_5",
    });

    expect(record.entries.map((e) => e.kind)).toEqual(["step_dispatched", "user_confirmation"]);
    expect(record.entries[1]!.ref).toEqual({ step_id: "step_7", decision: "declined" });
  });

  it("ignores a null evidence payload", () => {
    const record = buildRecord({
      workflow: { ...workflow, state: "RUNNING" },
      steps: [step()],
      events: [
        ev("workflow_created", { request: { text: "x" } }),
        ev("step_dispatched", { stepId: "step_1", capability: "git.collect_diagnostics" }),
        ev("step_status", { stepId: "step_1", state: "COMPLETED", evidence: null }),
      ],
      userRequest: { text: "x" },
      recordId: "rec_6",
    });

    expect(record.entries.map((e) => e.kind)).toEqual(["step_dispatched"]);
  });

  it("records the completion candidate the system proposed", () => {
    const record = buildRecord({
      workflow,
      steps: [step()],
      events: [
        ev("workflow_created", { request: { text: "x" } }),
        ev("completion_candidate", { summary: "看起来好了", evidenceRefs: ["step_1"] }),
        ev("completion_response", { resolution: "solved" }),
        ev("workflow_terminated", { state: "COMPLETED", reason: null }),
      ],
      userRequest: { text: "x" },
      recordId: "rec_7",
    });

    expect(record.entries.map((e) => e.kind)).toEqual([
      "completion_candidate",
      "completion_response",
    ]);
    expect(record.entries[0]!.ref).toEqual({
      summary: "看起来好了",
      evidence_refs: ["step_1"],
    });
  });

  it("records the step input on the dispatched entry", () => {
    const record = buildRecord({
      workflow,
      steps: [step()],
      events: [
        ev("workflow_created", { request: { text: "svc down" } }),
        ev("step_dispatched", { stepId: "step_1", capability: "git.collect_diagnostics", input: { project_path: "/a" } }),
        ev("workflow_terminated", { state: "COMPLETED", reason: null }),
      ],
      userRequest: { text: "svc down" },
      recordId: "rec_input",
    });
    expect(record.entries[0]!.ref.input).toEqual({ project_path: "/a" });
  });
});
