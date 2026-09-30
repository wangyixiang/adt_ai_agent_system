import { describe, it, expect } from "vitest";
import { attachStepRunner } from "../src/stepRunner";
import { CapabilityRegistry } from "../src/capability/registry";
import type { ExecutionResult } from "../src/capability/result";
import { openLedger, type Ledger } from "../src/ledger";

function harness({
  ledger = openLedger(":memory:"),
  execute,
}: { ledger?: Ledger; execute?: () => Promise<ExecutionResult> } = {}) {
  const sent: Array<{ payload: Record<string, unknown> }> = [];
  const handlers = new Map<string, (env: { payload: unknown }) => void>();
  let runs = 0;
  let confirmations = 0;

  const registry = new CapabilityRegistry();
  registry.register({
    spec: { name: "sim_rig.trigger_reset", side_effect: true, interruptible: false },
    execute: async () => {
      runs++;
      if (execute) return execute();
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

  it("reports UNKNOWN for a step it had already begun, instead of running it twice", async () => {
    const ledger = openLedger(":memory:");
    ledger.markInFlight("idem_1");

    const h = harness({ ledger });
    h.dispatch(payload);
    await h.settle();

    // WORKFLOW_SPEC.md §4.3: a client that cannot confirm the ledger must not
    // re-execute a physical action — it reports the outcome as unknown.
    expect(h.runs).toBe(0);
    expect(h.confirmations).toBe(0);
    expect(h.sent.at(-1)!.payload).toMatchObject({ status: "UNKNOWN" });
  });

  it("replays a finished result without executing anything", async () => {
    const ledger = openLedger(":memory:");
    ledger.markDone("idem_1", "reset_ack", { reset_ack: true });

    const h = harness({ ledger });
    h.dispatch(payload);
    await h.settle();

    expect(h.runs).toBe(0);
    expect(h.sent.at(-1)!.payload).toMatchObject({
      status: "COMPLETED",
      evidence: { source: "capability", type: "reset_ack", result: { reset_ack: true } },
    });
  });

  it("marks a step in flight before running it, and clears it when it did not happen", async () => {
    const ledger = openLedger(":memory:");
    const h = harness({
      ledger,
      execute: async () => ({ status: "failed", code: "capability_error", message: "boom" }),
    });

    h.dispatch(payload);
    await h.settle();

    expect(h.runs).toBe(1);
    // A failure is not "unknown": the marker is cleared so a later attempt is
    // allowed to run.
    expect(ledger.get("idem_1")).toBeUndefined();
  });

  it("refuses a side effect that carries no idempotency key at all", async () => {
    const h = harness();
    h.dispatch({ ...payload, idempotency_key: null });
    await h.settle();

    // Without a key there is nothing to make a retry safe, and a reconnect
    // would run the action twice — so do not run it once.
    expect(h.runs).toBe(0);
    expect(h.sent.at(-1)!.payload).toMatchObject({
      status: "REJECTED",
      reject_reason: { code: "unsafe_operation" },
    });
  });
});
