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

describe("engine.fail", () => {
  it("terminates a running workflow as FAILED with the given reason", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const failed = await engine.fail(wf.id, "planner_error");
    expect(failed.state).toBe("FAILED");
    expect(failed.terminalReason).toBe("planner_error");
  });

  it("converges a CANCELLING workflow to CANCELLED", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const step = await engine.dispatchStep(wf.id, {
      objective: "r",
      capability: "git.collect_diagnostics",
      sideEffect: false,
      interruptible: false,
    });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.cancel(wf.id, "abandoned");
    const failed = await engine.fail(wf.id, "planner_error");
    expect(failed.state).toBe("CANCELLED");
    expect(failed.terminalReason).toBe("abandoned");
  });

  it("records fail_reason on the step_status event", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const step = await engine.dispatchStep(wf.id, {
      objective: "r",
      capability: "git.collect_diagnostics",
      sideEffect: false,
      interruptible: true,
    });
    await engine.applyStepStatus(wf.id, step.id, { state: "RUNNING" });
    await engine.applyStepStatus(wf.id, step.id, { state: "FAILED", failReason: { code: "invalid_output" } });
    const event = (await store.listEvents(wf.id)).find(
      (e) => e.kind === "step_status" && (e.payload as { state?: string }).state === "FAILED",
    )!;
    expect((event.payload as { failReason: unknown }).failReason).toEqual({ code: "invalid_output" });
  });
});
