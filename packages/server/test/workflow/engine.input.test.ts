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

describe("step input", () => {
  it("persists and returns the step input", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const step = await engine.dispatchStep(wf.id, {
      objective: "read",
      capability: "git.collect_diagnostics",
      sideEffect: false,
      interruptible: true,
      input: { project_path: "/workspace/app" },
    });
    expect(step.input).toEqual({ project_path: "/workspace/app" });
    expect((await store.getStep(step.id))!.input).toEqual({ project_path: "/workspace/app" });
    const dispatched = (await store.listEvents(wf.id)).find(
      (e) =>
        e.kind === "step_dispatched" &&
        typeof (e.payload as { stepId?: unknown }).stepId === "string",
    )!;
    expect((dispatched.payload as { input: unknown }).input).toEqual({ project_path: "/workspace/app" });
  });
});
