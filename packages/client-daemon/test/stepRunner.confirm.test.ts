import { describe, it, expect } from "vitest";
import { attachStepRunner, type StepRunnerDeps } from "../src/stepRunner";
import { CapabilityRegistry } from "../src/capability/registry";
import type { CapabilityAdapter } from "../src/capability/result";

function harness(adapter: CapabilityAdapter | null, hooks: Partial<StepRunnerDeps> = {}) {
  const sent: Array<{ payload: Record<string, unknown> }> = [];
  const handlers = new Map<string, (env: { payload: unknown }) => void>();
  const registry = new CapabilityRegistry();
  if (adapter) registry.register(adapter);
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
    ...hooks,
  });
  const dispatch = (payload: Record<string, unknown>): void =>
    handlers.get("step.dispatch")!({ payload });
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
  return { sent, dispatch, settle };
}

const base = {
  workflow_id: "wf_1",
  step_id: "step_1",
  objective: "reset",
  capability: "sim_rig.trigger_reset",
  input: {},
  expected_output: null,
  idempotency_key: "idem_1",
  requires_confirmation: true,
};

const sideEffect = (
  execute: CapabilityAdapter["execute"],
): CapabilityAdapter => ({
  spec: { name: "sim_rig.trigger_reset", side_effect: true, interruptible: false },
  execute,
});

describe("confirmation and advisory flows", () => {
  it("waits for confirmation, then executes", async () => {
    const { sent, dispatch, settle } = harness(
      sideEffect(async () => ({
        status: "completed",
        type: "reset_ack",
        result: { reset_ack: true },
      })),
      { onConfirmationRequired: async () => true },
    );

    dispatch(base);
    await settle();

    expect(sent.map((s) => s.payload.status)).toEqual(["WAITING", "RUNNING", "COMPLETED"]);
    expect(sent[0]!.payload.wait_reason).toEqual({ code: "user_confirmation" });
  });

  it("does not execute when the engineer declines", async () => {
    let executed = false;
    const { sent, dispatch, settle } = harness(
      sideEffect(async () => {
        executed = true;
        return { status: "completed", type: "reset_ack", result: {} };
      }),
      { onConfirmationRequired: async () => false },
    );

    dispatch(base);
    await settle();

    expect(executed).toBe(false);
    expect(sent.map((s) => s.payload.status)).toEqual(["WAITING", "REJECTED"]);
    expect(sent[1]!.payload.reject_reason).toEqual({ code: "user_declined" });
  });

  it("reports a failed side effect without confirming again", async () => {
    const { sent, dispatch, settle } = harness(
      sideEffect(async () => ({ status: "failed", code: "capability_error", message: "boom" })),
      { onConfirmationRequired: async () => true },
    );

    dispatch(base);
    await settle();

    expect(sent.map((s) => s.payload.status)).toEqual(["WAITING", "RUNNING", "FAILED"]);
  });

  it("turns the engineer's advisory feedback into user_input evidence", async () => {
    const { sent, dispatch, settle } = harness(null, {
      onUserInput: async () => ({ outcome: "succeeded", observation: "换了电源线" }),
    });

    dispatch({
      ...base,
      capability: "human.manual_action",
      requires_confirmation: false,
      input: { instruction: "换线" },
    });
    await settle();

    expect(sent.map((s) => s.payload.status)).toEqual(["WAITING", "COMPLETED"]);
    expect(sent[0]!.payload.wait_reason).toEqual({ code: "user_input" });
    expect(sent[1]!.payload.evidence).toEqual({
      source: "user_input",
      type: "manual_action_result",
      result: { outcome: "succeeded", observation: "换了电源线" },
    });
  });

  it("declines an advisory step when there is no one to ask", async () => {
    const { sent, dispatch, settle } = harness(null);

    dispatch({ ...base, capability: "human.manual_action", requires_confirmation: false });
    await settle();

    expect(sent.map((s) => s.payload.status)).toEqual(["WAITING", "REJECTED"]);
    expect(sent[1]!.payload.reject_reason).toEqual({ code: "user_declined" });
  });
});
