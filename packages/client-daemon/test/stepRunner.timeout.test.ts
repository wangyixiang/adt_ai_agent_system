import { describe, it, expect } from "vitest";
import { attachStepRunner } from "../src/stepRunner";
import { CapabilityRegistry } from "../src/capability/registry";
import type { CapabilitySpec } from "../src/capability/spec";
import type { ExecutionResult } from "../src/capability/result";
import { openLedger, type Ledger } from "../src/ledger";

function harness(spec: CapabilitySpec, result: ExecutionResult, ledger: Ledger = openLedger(":memory:")) {
  const sent: Array<{ payload: Record<string, unknown> }> = [];
  const handlers = new Map<string, (env: { payload: unknown }) => void>();
  const registry = new CapabilityRegistry();
  registry.register({ spec, execute: async () => result });

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
    onConfirmationRequired: async () => true,
  });

  return {
    sent,
    ledger,
    dispatch: (payload: Record<string, unknown>): void =>
      handlers.get("step.dispatch")!({ payload }),
    settle: (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20)),
  };
}

const dispatch = {
  workflow_id: "wf_1",
  step_id: "step_1",
  objective: "run",
  capability: "terminal.execute_command",
  input: { command: "sleep" },
  requires_confirmation: true,
  idempotency_key: "idem_1",
};

describe("local timeout semantics", () => {
  it("reports UNKNOWN for a side effect it had to kill, keeping the ledger marker", async () => {
    const h = harness(
      { name: "terminal.execute_command", side_effect: true, interruptible: false },
      { status: "failed", code: "timeout", message: "command exceeded its timeout" },
    );
    h.dispatch(dispatch);
    await h.settle();

    // It may have taken (partial) effect: that is unknown, not a failure.
    expect(h.sent.at(-1)!.payload).toMatchObject({ status: "UNKNOWN" });
    // And a re-dispatch after a reconnect must still refuse to run it again.
    expect(h.ledger.get("idem_1")).toEqual({ state: "in_flight" });
  });

  it("keeps FAILED(timeout) for a read-only step", async () => {
    const h = harness(
      { name: "git.collect_diagnostics", side_effect: false, interruptible: true },
      { status: "failed", code: "timeout", message: "git failed" },
    );
    h.dispatch({
      ...dispatch,
      capability: "git.collect_diagnostics",
      requires_confirmation: false,
      idempotency_key: null,
    });
    await h.settle();

    // Nothing in the real world changed: a plain failure the planner may retry
    // or route around.
    expect(h.sent.at(-1)!.payload).toMatchObject({
      status: "FAILED",
      fail_reason: { code: "timeout" },
    });
  });

  it("still clears the marker for a side effect that genuinely failed", async () => {
    const ledger = openLedger(":memory:");
    const h = harness(
      { name: "terminal.execute_command", side_effect: true, interruptible: false },
      { status: "failed", code: "capability_error", message: "could not start" },
      ledger,
    );
    h.dispatch(dispatch);
    await h.settle();

    expect(h.sent.at(-1)!.payload).toMatchObject({ status: "FAILED" });
    // "Could not start" is a definite non-execution, so a later attempt is fine.
    expect(ledger.get("idem_1")).toBeUndefined();
  });
});
