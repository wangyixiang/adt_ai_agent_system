import { describe, it, expect } from "vitest";
import { attachStepRunner } from "../src/stepRunner";
import { CapabilityRegistry } from "../src/capability/registry";
import type { CapabilityAdapter } from "../src/capability/result";

function harness(adapter: CapabilityAdapter) {
  const sent: Array<{ type: string; payload: any }> = [];
  const handlers = new Map<string, (env: { payload: unknown }) => void>();
  const registry = new CapabilityRegistry();
  registry.register(adapter);
  attachStepRunner({
    connection: {
      on: (type, handler) => {
        handlers.set(type, handler);
      },
      send: (type, payload) => {
        sent.push({ type, payload });
      },
    },
    registry,
    workspaceRoot: "/ws",
  });
  const dispatch = (payload: Record<string, unknown>) => handlers.get("step.dispatch")!({ payload });
  return { sent, dispatch };
}

const dispatchPayload = (over: Record<string, unknown> = {}) => ({
  workflow_id: "wf_1",
  step_id: "step_1",
  objective: "read",
  capability: "filesystem.read_file",
  input: { path: "a.txt" },
  expected_output: null,
  requires_confirmation: false,
  idempotency_key: null,
  ...over,
});

const completedAdapter: CapabilityAdapter = {
  spec: { name: "filesystem.read_file", side_effect: false, interruptible: true },
  execute: async () => ({ status: "completed", type: "file_content", result: { content: "x" } }),
};

describe("attachStepRunner", () => {
  it("reports RUNNING then COMPLETED with faithful evidence", async () => {
    const { sent, dispatch } = harness(completedAdapter);
    dispatch(dispatchPayload());
    expect(sent[0]).toMatchObject({
      type: "step.status",
      payload: { workflow_id: "wf_1", step_id: "step_1", status: "RUNNING" },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[1]).toMatchObject({
      type: "step.status",
      payload: {
        workflow_id: "wf_1",
        step_id: "step_1",
        status: "COMPLETED",
        evidence: { source: "capability", type: "file_content", result: { content: "x" } },
      },
    });
  });

  it("rejects an unregistered capability", async () => {
    const { sent, dispatch } = harness(completedAdapter);
    dispatch(dispatchPayload({ capability: "not.registered" }));
    expect(sent[0]).toMatchObject({
      payload: { status: "REJECTED", reject_reason: { code: "capability_unavailable" } },
    });
  });

  it("never executes a step that asks for confirmation", async () => {
    let executed = false;
    const { sent, dispatch } = harness({
      spec: { name: "filesystem.read_file", side_effect: false, interruptible: true },
      execute: async () => {
        executed = true;
        return { status: "completed", type: "file_content", result: {} };
      },
    });
    dispatch(dispatchPayload({ requires_confirmation: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(executed).toBe(false);
    expect(sent[0]).toMatchObject({
      payload: { status: "REJECTED", reject_reason: { code: "user_declined" } },
    });
  });

  it("reports FAILED when the adapter fails", async () => {
    const { sent, dispatch } = harness({
      spec: { name: "filesystem.read_file", side_effect: false, interruptible: true },
      execute: async () => ({ status: "failed", code: "capability_error", message: "boom" }),
    });
    dispatch(dispatchPayload());
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[1]).toMatchObject({
      payload: { status: "FAILED", fail_reason: { code: "capability_error", message: "boom" } },
    });
    expect((sent[1] as { payload: { evidence?: unknown } }).payload.evidence).toBeUndefined();
  });

  it("rejects input that violates the declared schema without executing", async () => {
    let executed = false;
    const { sent, dispatch } = harness({
      spec: {
        name: "filesystem.read_file",
        side_effect: false,
        interruptible: true,
        input_schema: {
          type: "object",
          required: ["path"],
          properties: { path: { type: "string" } },
        },
      },
      execute: async () => {
        executed = true;
        return { status: "completed", type: "file_content", result: {} };
      },
    });
    dispatch(dispatchPayload({ input: { path: 7 } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(executed).toBe(false);
    expect(sent[0]).toMatchObject({
      payload: { status: "REJECTED", reject_reason: { code: "invalid_input" } },
    });
  });

  it("never executes a side-effect capability", async () => {
    let executed = false;
    const { sent, dispatch } = harness({
      spec: { name: "sim_rig.trigger_reset", side_effect: true, interruptible: false },
      execute: async () => {
        executed = true;
        return { status: "completed", type: "reset_ack", result: {} };
      },
    });
    dispatch(dispatchPayload({ capability: "sim_rig.trigger_reset", requires_confirmation: false }));
    await new Promise((r) => setTimeout(r, 20));
    expect(executed).toBe(false);
    expect(sent[0]).toMatchObject({
      payload: { status: "REJECTED", reject_reason: { code: "user_declined" } },
    });
  });
});
