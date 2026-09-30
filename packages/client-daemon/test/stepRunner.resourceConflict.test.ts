import { describe, it, expect } from "vitest";
import { attachStepRunner, type StepRunnerDeps } from "../src/stepRunner";
import { CapabilityRegistry } from "../src/capability/registry";
import type { ExecutionResult } from "../src/capability/result";

function harness(results: Array<ExecutionResult | "throw">, hooks: Partial<StepRunnerDeps> = {}) {
  const sent: Array<{ payload: Record<string, unknown> }> = [];
  const handlers = new Map<string, (env: { payload: unknown }) => void>();
  let runs = 0;
  let confirmations = 0;

  const registry = new CapabilityRegistry();
  registry.register({
    spec: { name: "sim_rig.trigger_reset", side_effect: true, interruptible: false },
    execute: async () => {
      runs++;
      const step = results[Math.min(runs - 1, results.length - 1)]!;
      if (step === "throw") throw new Error("adapter exploded");
      return step;
    },
  });

  attachStepRunner({
    connection: {
      on: (type, handler) => {
        handlers.set(type, handler);
      },
      send: (_type, payload) => {
        sent.push({ payload: payload as Record<string, unknown> });
      },
    },
    registry,
    workspaceRoot: "/ws",
    onConfirmationRequired: async () => {
      confirmations++;
      return true;
    },
    ...hooks,
  });

  return {
    sent,
    dispatch: (payload: Record<string, unknown>): void =>
      handlers.get("step.dispatch")!({ payload }),
    settle: (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20)),
    get runs() {
      return runs;
    },
    get confirmations() {
      return confirmations;
    },
  };
}

const dispatch = {
  workflow_id: "wf_1",
  step_id: "step_1",
  objective: "复位测试台",
  capability: "sim_rig.trigger_reset",
  input: {},
  requires_confirmation: true,
  idempotency_key: "idem_1",
};

const conflict: ExecutionResult = {
  status: "rejected",
  code: "resource_conflict",
  message: "测试台正被占用",
};
const ok: ExecutionResult = {
  status: "completed",
  type: "reset_ack",
  result: { reset_ack: true },
};

describe("resource conflict on the client", () => {
  it("stops when the engineer says not to wait, keeping the reason", async () => {
    const h = harness([conflict], { onResourceConflict: async () => "stop" });
    h.dispatch(dispatch);
    await h.settle();

    expect(h.sent.map((s) => s.payload.status)).toEqual([
      "WAITING",
      "RUNNING",
      "WAITING",
      "REJECTED",
    ]);
    expect(h.sent[2]!.payload.wait_reason).toEqual({ code: "resource_conflict" });
    expect(h.sent[3]!.payload.reject_reason).toEqual({
      code: "resource_conflict",
      message: "测试台正被占用",
    });
  });

  it("retries after the engineer frees the resource, and the workflow continues", async () => {
    const h = harness([conflict, ok], { onResourceConflict: async () => "wait" });
    h.dispatch(dispatch);
    await h.settle();

    expect(h.runs).toBe(2);
    // Approving a busy-resource wait is not a second approval of the action.
    expect(h.confirmations).toBe(1);
    expect(h.sent.map((s) => s.payload.status)).toEqual([
      "WAITING",
      "RUNNING",
      "WAITING",
      "RUNNING",
      "COMPLETED",
    ]);
    expect(h.sent[4]!.payload.evidence).toMatchObject({ type: "reset_ack" });
  });

  it("reports a capability failure when the adapter throws on the retry", async () => {
    const h = harness([conflict, "throw"], { onResourceConflict: async () => "wait" });
    h.dispatch(dispatch);
    await h.settle();

    expect(h.sent.map((s) => s.payload.status)).toEqual([
      "WAITING",
      "RUNNING",
      "WAITING",
      "RUNNING",
      "FAILED",
    ]);
    expect(h.sent[4]!.payload.fail_reason).toMatchObject({ code: "capability_error" });
  });

  it("stops when there is nobody to ask", async () => {
    const h = harness([conflict]); // no hook
    h.dispatch(dispatch);
    await h.settle();

    expect(h.runs).toBe(1);
    expect(h.sent.map((s) => s.payload.status)).toEqual([
      "WAITING",
      "RUNNING",
      "WAITING",
      "REJECTED",
    ]);
  });

  it("leaves other rejections alone", async () => {
    const h = harness([{ status: "rejected", code: "invalid_input", message: "bad" }], {
      onResourceConflict: async () => "wait",
    });
    h.dispatch(dispatch);
    await h.settle();

    expect(h.sent.map((s) => s.payload.status)).toEqual(["WAITING", "RUNNING", "REJECTED"]);
    expect(h.sent[2]!.payload.reject_reason).toEqual({ code: "invalid_input", message: "bad" });
  });
});
