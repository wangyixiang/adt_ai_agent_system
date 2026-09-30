import { describe, it, expect } from "vitest";
import { attachStepRunner } from "../src/stepRunner";
import { CapabilityRegistry } from "../src/capability/registry";
import { openLedger, type Ledger } from "../src/ledger";

function harness(ledger: Ledger = openLedger(":memory:")) {
  const sent: Array<{ payload: Record<string, unknown> }> = [];
  const handlers = new Map<string, (env: { payload: unknown }) => void>();
  let runs = 0;
  let confirmations = 0;

  const registry = new CapabilityRegistry();
  registry.register({
    spec: { name: "sim_rig.trigger_reset", side_effect: true, interruptible: false },
    execute: async () => {
      runs++;
      return { status: "completed", type: "reset_ack", result: { reset_ack: true } };
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
    ledger,
    onConfirmationRequired: async () => {
      confirmations++;
      return true;
    },
  });

  const dispatch = (payload: Record<string, unknown>): void =>
    handlers.get("step.dispatch")!({ payload });
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  return {
    sent,
    dispatch,
    settle,
    get runs() {
      return runs;
    },
    get confirmations() {
      return confirmations;
    },
  };
}

const payload = {
  workflow_id: "wf_1",
  step_id: "step_1",
  objective: "reset",
  capability: "sim_rig.trigger_reset",
  input: {},
  expected_output: null,
  requires_confirmation: true,
  idempotency_key: "idem_1",
};

describe("idempotency ledger", () => {
  it("does not execute the same idempotency key twice", async () => {
    const h = harness();
    h.dispatch(payload);
    await h.settle();
    expect(h.runs).toBe(1);

    // A re-dispatch of the same key (a resume after a reconnect) must return the
    // recorded result instead of repeating the action.
    h.dispatch({ ...payload, step_id: "step_2" });
    await h.settle();

    expect(h.runs).toBe(1);
    const last = h.sent[h.sent.length - 1]!.payload;
    expect(last).toMatchObject({
      workflow_id: "wf_1",
      step_id: "step_2",
      status: "COMPLETED",
      evidence: { source: "capability", type: "reset_ack", result: { reset_ack: true } },
    });
    // Nothing to execute means nothing to confirm.
    expect(h.confirmations).toBe(1);
  });

  it("executes again for a different key", async () => {
    const h = harness();
    h.dispatch(payload);
    await h.settle();
    h.dispatch({ ...payload, step_id: "step_2", idempotency_key: "idem_2" });
    await h.settle();

    expect(h.runs).toBe(2);
  });

  it("does not record a failed side effect", async () => {
    const ledger = openLedger(":memory:");
    const handlers = new Map<string, (env: { payload: unknown }) => void>();
    let runs = 0;
    const registry = new CapabilityRegistry();
    registry.register({
      spec: { name: "sim_rig.trigger_reset", side_effect: true, interruptible: false },
      execute: async () => {
        runs++;
        return { status: "failed", code: "capability_error", message: "no ack" };
      },
    });
    attachStepRunner({
      connection: {
        on: (type, handler) => {
          handlers.set(type, handler);
        },
        send: () => undefined,
      },
      registry,
      workspaceRoot: "/ws",
      ledger,
      onConfirmationRequired: async () => true,
    });

    handlers.get("step.dispatch")!({ payload });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toBe(1);
    // The action may or may not have taken effect; remembering "failed" as an
    // outcome would suppress the retry that reconciliation may ask for.
    expect(ledger.get("idem_1")).toBeUndefined();
  });
});
