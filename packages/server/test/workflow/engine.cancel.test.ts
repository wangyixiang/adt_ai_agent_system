import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store: PostgresWorkflowStore;
let engine: WorkflowEngine;

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events");
  store = new PostgresWorkflowStore(pool);
  engine = new WorkflowEngine({ store, now: () => 1000 });
});
afterAll(async () => {
  await pool.end();
});

const open = { mode: "open" as const, revision: 0 };
const sideEffectStep = {
  objective: "reset",
  capability: "sim_rig.trigger_reset",
  sideEffect: true,
  interruptible: false,
};

describe("engine cancel", () => {
  it("cancels immediately when nothing is in flight", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const after = await engine.cancel(wf.id, "user_cancelled");
    expect(after.state).toBe("CANCELLED");
    expect(after.terminalReason).toBe("user_cancelled");
  });

  it("queues CANCELLING for a non-interruptible execution, then converges on any terminal", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const step = await engine.dispatchStep(wf.id, sideEffectStep);
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });

    const queued = await engine.cancel(wf.id, "abandoned");
    expect(queued.state).toBe("CANCELLING");

    const after = await engine.applyStepStatus(wf.id, step.id, { state: "UNKNOWN" });
    expect(after.state).toBe("CANCELLED");
    expect(after.terminalReason).toBe("abandoned");
  });
});

describe("engine UNKNOWN reconciliation", () => {
  it("reconciles an UNKNOWN step and records the outcome", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const step = await engine.dispatchStep(wf.id, sideEffectStep);
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.applyStepStatus(wf.id, step.id, { state: "UNKNOWN" });

    await engine.reconcileUnknown(wf.id, step.id, "COMPLETED", [step.id]);

    expect((await store.getStep(step.id))!.state).toBe("COMPLETED");
    expect((await engine.get(wf.id))!.state).toBe("RUNNING");
  });

  it("refuses a verdict that cites no evidence", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const step = await engine.dispatchStep(wf.id, sideEffectStep);
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.applyStepStatus(wf.id, step.id, { state: "UNKNOWN" });

    await expect(engine.reconcileUnknown(wf.id, step.id, "COMPLETED", [])).rejects.toThrow(
      /evidence reference/,
    );
    expect((await store.getStep(step.id))!.state).toBe("UNKNOWN");
  });
});
